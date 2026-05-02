import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {checkBearer} from './auth.ts';
import type {ServerEnv} from './env.ts';
import type {Embedder} from '../embeddings/types.ts';
import {backlinksHandler, neighborhoodHandler} from './handlers/edges.ts';
import {
  getRecordHandler,
  getRecordMetaHandler,
  listRecordsHandler
} from './handlers/records.ts';
import {putRecordHandler} from './handlers/records-write.ts';
import {
  cleanupLintHandler,
  findCompactionCandidatesHandler,
  findDuplicatesHandler,
  findRetentionCandidatesHandler,
  findUpgradeSignalsHandler,
  incrementalReindexHandler,
  snapshotHandler
} from './handlers/maintenance.ts';
import {simpleSearchHandler} from './handlers/search.ts';
import {similarHandler} from './handlers/similar.ts';
import {
  acceptSuggestionHandler,
  createSuggestionHandler,
  getSuggestionHandler,
  listSuggestionsHandler,
  rejectSuggestionHandler,
  reopenSuggestionHandler,
  summarySuggestionsHandler
} from './handlers/suggestions.ts';
import {lintHandler} from './handlers/lint.ts';
import {syncFromObsidianHandler} from './handlers/sync.ts';
import {systemStatusHandler} from './handlers/system.ts';
import {addAliasHandler, addTaxonomyHandler, listTagsHandler, recordsByTagHandler} from './handlers/tags.ts';
import {
  deleteVaultHandler,
  getVaultHandler,
  getVaultRootHandler,
  moveVaultHandler,
  putVaultHandler
} from './handlers/vault.ts';
import {sendError} from './responses.ts';
import {Router, type RequestContext} from './router.ts';
import {staticHandler} from './handlers/static.ts';

export interface ServerHandle {
  server: Server;
  url: string;
  /** Stop accepting new connections, close existing keep-alive sockets, then resolve. */
  close: () => Promise<void>;
}

interface BuildOptions {
  db: DatabaseSync;
  env: ServerEnv;
  schemaVersion: number;
  embedder: Embedder;
}

export const buildRouter = (opts: BuildOptions): Router => {
  const router = new Router();
  router.get(
    '/system/status',
    systemStatusHandler({
      db: opts.db,
      schemaVersion: opts.schemaVersion,
      vaultDataPath: opts.env.vaultDataPath
    })
  );
  router.get('/system/lint', lintHandler({db: opts.db}));
  router.get('/sections', listRecordsHandler(opts.db));
  router.get('/sections/{id}/neighborhood', neighborhoodHandler({db: opts.db}));
  router.get('/sections/{id}/similar', similarHandler({db: opts.db}));
  router.get('/sections/{id}/backlinks', backlinksHandler({db: opts.db}));
  router.get('/sections/{id}/meta', getRecordMetaHandler(opts.db));
  router.get('/sections/{id}', getRecordHandler(opts.db));
  router.put(
    '/sections/{id}',
    putRecordHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );

  const tagsDeps = {db: opts.db};
  router.get('/tags', listTagsHandler(tagsDeps));
  router.get('/tags/{tag}/records', recordsByTagHandler(tagsDeps));
  router.post('/tags/taxonomy', addTaxonomyHandler(tagsDeps));
  router.post('/tags/aliases', addAliasHandler(tagsDeps));

  const suggestionsDeps = {db: opts.db};
  router.get('/suggestions', listSuggestionsHandler(suggestionsDeps));
  router.post('/suggestions', createSuggestionHandler(suggestionsDeps));
  // `/summary` registered before `/{id}` so the literal path wins over the
  // wildcard match (router currently uses registration-order precedence).
  router.get('/suggestions/summary', summarySuggestionsHandler(suggestionsDeps));
  router.get('/suggestions/{id}', getSuggestionHandler(suggestionsDeps));
  router.post('/suggestions/{id}/accept', acceptSuggestionHandler(suggestionsDeps));
  router.post('/suggestions/{id}/reject', rejectSuggestionHandler(suggestionsDeps));
  router.post('/suggestions/{id}/reopen', reopenSuggestionHandler(suggestionsDeps));

  const vaultDeps = {db: opts.db, vaultDataPath: opts.env.vaultDataPath};
  router.get('/vault/', getVaultRootHandler(vaultDeps));
  router.get('/vault/{path}', getVaultHandler(vaultDeps));
  router.put('/vault/{path}', putVaultHandler(vaultDeps));
  router.delete('/vault/{path}', deleteVaultHandler(vaultDeps));
  router.post('/vault/move', moveVaultHandler(vaultDeps));

  router.post('/search/simple/', simpleSearchHandler({db: opts.db, embedder: opts.embedder}));
  router.post('/search/simple', simpleSearchHandler({db: opts.db, embedder: opts.embedder}));

  router.post(
    '/sync/from-obsidian',
    syncFromObsidianHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );

  router.post('/maintenance/find-duplicates', findDuplicatesHandler({db: opts.db}));
  router.post(
    '/maintenance/find-compaction-candidates',
    findCompactionCandidatesHandler({db: opts.db})
  );
  router.post(
    '/maintenance/find-retention-candidates',
    findRetentionCandidatesHandler({db: opts.db})
  );
  router.post('/maintenance/find-upgrade-signals', findUpgradeSignalsHandler({db: opts.db}));
  router.post('/maintenance/cleanup-lint', cleanupLintHandler({db: opts.db}));
  router.post(
    '/maintenance/snapshot',
    snapshotHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );
  router.post(
    '/maintenance/incremental-reindex',
    incrementalReindexHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );

  if (opts.env.uiStaticPath) {
    const uiHandler = staticHandler({rootDir: opts.env.uiStaticPath, indexFile: 'index.html'});
    router.get('/ui', uiHandler);
    router.get('/ui/', uiHandler);
    router.get('/ui/{path}', uiHandler);
  }

  return router;
};

/**
 * The `/ui/` prefix serves the unauthenticated shell. The page calls API
 * endpoints with the bearer the user pasted into localStorage, so the
 * shell itself doesn't need it. Anyone on the LAN can load the HTML; only
 * a token holder can read or write data.
 */
const isPublicPath = (path: string): boolean => path === '/ui' || path.startsWith('/ui/');

const parseUrl = (req: IncomingMessage): {path: string; query: Record<string, string>} | null => {
  if (!req.url) return null;
  const u = new URL(req.url, 'http://placeholder');
  const query: Record<string, string> = {};
  for (const key of u.searchParams.keys()) {
    const all = u.searchParams.getAll(key);
    query[key] = all.join(',');
  }
  return {path: u.pathname, query};
};

const handleRequest =
  (router: Router, env: ServerEnv) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const parsed = parseUrl(req);
      if (!parsed) {
        sendError(res, 400, 'bad_request', 'malformed request URL');
        return;
      }

      if (!isPublicPath(parsed.path) && !checkBearer(req, env.apiToken)) {
        sendError(res, 401, 'unauthorized', 'missing or invalid bearer token');
        return;
      }

      const match = router.match(req.method ?? 'GET', parsed.path);
      if (match === null) {
        sendError(res, 404, 'not_found', `no route: ${req.method} ${parsed.path}`);
        return;
      }
      if (match === 'method-not-allowed') {
        sendError(res, 405, 'method_not_allowed', `method not allowed for ${parsed.path}`);
        return;
      }

      const ctx: RequestContext = {
        req,
        res,
        path: parsed.path,
        query: parsed.query,
        params: match.params
      };
      await match.handler(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`request error: ${msg}\n`);
      if (!res.headersSent) {
        sendError(res, 500, 'internal', 'internal server error');
      } else {
        res.end();
      }
    }
  };

export const startServer = (opts: BuildOptions): Promise<ServerHandle> => {
  const router = buildRouter(opts);
  const server = createServer(handleRequest(router, opts.env));

  return new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(opts.env.port, opts.env.host, () => {
      server.off('error', reject);
      const url = `http://${opts.env.host}:${opts.env.port}`;
      const close = (): Promise<void> =>
        new Promise(resolveClosed => {
          server.closeAllConnections();
          server.close(() => resolveClosed());
        });
      resolveListening({server, url, close});
    });
  });
};
