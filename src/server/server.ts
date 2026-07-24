import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {checkBearer} from './auth.ts';
import type {ServerEnv} from './env.ts';
import type {Embedder} from '../embeddings/types.ts';
import {backlinksHandler, neighborhoodHandler} from './handlers/edges.ts';
import {
  deleteRecordTagHandler,
  getRecordFmHandler,
  getRecordHandler,
  getRecordMetaHandler,
  getRecordTagsHandler,
  listRecordsHandler,
  patchRecordFmHandler,
  postRecordTagHandler
} from './handlers/records.ts';
import {putRecordHandler} from './handlers/records-write.ts';
import {
  cleanupLintHandler,
  cleanupTagAliasesHandler,
  embedPendingHandler,
  findCompactionCandidatesHandler,
  findDuplicatesHandler,
  findRetentionCandidatesHandler,
  folderListingHandler,
  findUpgradeSignalsHandler,
  incrementalReindexHandler,
  rawInboxHandler,
  runAllScansHandler,
  snapshotDeleteHandler,
  snapshotDownloadHandler,
  snapshotHandler,
  snapshotListHandler
} from './handlers/maintenance.ts';
import {
  queueArchiveByProjectHandler,
  queueBlockedHandler,
  queueByPriorityHandler,
  queueByProjectHandler,
  queueBySectionHandler,
  queueReadyHandler,
  queueTopHandler,
  reindexQueuesHandler
} from './handlers/queue.ts';
import {simpleSearchHandler} from './handlers/search.ts';
import {similarHandler} from './handlers/similar.ts';
import {
  acceptSuggestionHandler,
  claimSuggestionsHandler,
  createSuggestionHandler,
  getSuggestionHandler,
  listSuggestionsHandler,
  rejectSuggestionHandler,
  reopenSuggestionHandler,
  resolveBatchSuggestionsHandler,
  summarySuggestionsHandler
} from './handlers/suggestions.ts';
import {commitHandler} from './handlers/commit.ts';
import {lintHandler} from './handlers/lint.ts';
import {resumeBundleHandler} from './handlers/resume-bundle.ts';
import {resolveHandler} from './handlers/resolve.ts';
import {releaseEmbedderHandler, systemStatusHandler} from './handlers/system.ts';
import {
  addAliasHandler,
  addTaxonomyHandler,
  listTagsHandler,
  recordsByTagHandler,
  tagInfoHandler
} from './handlers/tags.ts';
import {
  deleteVaultHandler,
  getVaultHandler,
  getVaultRootHandler,
  moveVaultHandler,
  proposeVaultHandler,
  putVaultHandler,
  supersedeVaultHandler
} from './handlers/vault.ts';
import {sendError} from './responses.ts';
import {ResolverCache} from './resolver-cache.ts';
import {Router, type RequestContext} from './router.ts';
import {staticHandler} from './handlers/static.ts';
import {EdgesRepository} from '../records/edges.ts';
import {RecordsRepository} from '../records/repository.ts';

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
  /**
   * Shared with the watcher (composition in index.ts) so its drains
   * invalidate the same cache the `/resolve` handler reads. Defaults to a
   * router-local instance — correct for tests that exercise the HTTP
   * surface without a watcher.
   */
  resolverCache?: ResolverCache;
}

export const buildRouter = (opts: BuildOptions): Router => {
  const router = new Router();

  // Shared repositories: each constructor prepares its statements, so build
  // them once per server instead of once per request. Safe to share — the
  // server is single-process and a handler's statement use runs to
  // completion before another request touches the same statement.
  const records = new RecordsRepository(opts.db);
  const edges = new EdgesRepository(opts.db);
  const resolverCache = opts.resolverCache ?? new ResolverCache(opts.db);
  router.get(
    '/system/status',
    systemStatusHandler({
      db: opts.db,
      schemaVersion: opts.schemaVersion,
      vaultDataPath: opts.env.vaultDataPath,
      embedder: opts.embedder
    })
  );
  router.get('/system/lint', lintHandler({db: opts.db}));
  router.post(
    '/system/resume-bundle',
    resumeBundleHandler({db: opts.db, records, vaultDataPath: opts.env.vaultDataPath})
  );
  router.get('/sections', listRecordsHandler({db: opts.db}));
  router.get('/sections/{id}/neighborhood', neighborhoodHandler({records, edges}));
  router.get('/sections/{id}/similar', similarHandler({db: opts.db, records}));
  router.get('/sections/{id}/backlinks', backlinksHandler({records, edges}));
  router.get('/sections/{id}/meta', getRecordMetaHandler({records}));
  const recordFmDeps = {db: opts.db, vaultDataPath: opts.env.vaultDataPath, records};
  router.get('/sections/{id}/fm', getRecordFmHandler(recordFmDeps));
  router.patch('/sections/{id}/fm', patchRecordFmHandler(recordFmDeps));
  router.get('/sections/{id}/tags', getRecordTagsHandler(recordFmDeps));
  router.post('/sections/{id}/tags', postRecordTagHandler(recordFmDeps));
  router.delete('/sections/{id}/tags/{tag}', deleteRecordTagHandler(recordFmDeps));
  router.get('/sections/{id}', getRecordHandler({records}));
  router.put(
    '/sections/{id}',
    putRecordHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath, records})
  );

  const tagsDeps = {db: opts.db, records};
  router.get('/tags', listTagsHandler(tagsDeps));
  router.get('/tags/{tag}/records', recordsByTagHandler(tagsDeps));
  router.get('/tags/{tag}', tagInfoHandler(tagsDeps));
  router.post('/tags/taxonomy', addTaxonomyHandler(tagsDeps));
  router.post('/tags/aliases', addAliasHandler(tagsDeps));

  const suggestionsDeps = {db: opts.db};
  router.get('/suggestions', listSuggestionsHandler(suggestionsDeps));
  router.post('/suggestions', createSuggestionHandler(suggestionsDeps));
  // `/summary` registered before `/{id}` so the literal path wins over the
  // wildcard match (router currently uses registration-order precedence).
  router.get('/suggestions/summary', summarySuggestionsHandler(suggestionsDeps));
  router.post('/suggestions/claim', claimSuggestionsHandler(suggestionsDeps));
  router.post(
    '/suggestions/resolve-batch',
    resolveBatchSuggestionsHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath, records})
  );
  router.get('/suggestions/{id}', getSuggestionHandler(suggestionsDeps));
  router.post('/suggestions/{id}/accept', acceptSuggestionHandler(suggestionsDeps));
  router.post('/suggestions/{id}/reject', rejectSuggestionHandler(suggestionsDeps));
  router.post('/suggestions/{id}/reopen', reopenSuggestionHandler(suggestionsDeps));

  const vaultDeps = {
    db: opts.db,
    vaultDataPath: opts.env.vaultDataPath,
    embedder: opts.embedder,
    records,
    resolverCache
  };
  router.get('/vault/', getVaultRootHandler(vaultDeps));
  router.get('/vault/{path}', getVaultHandler(vaultDeps));
  router.put('/vault/{path}', putVaultHandler(vaultDeps));
  router.delete('/vault/{path}', deleteVaultHandler(vaultDeps));
  router.post('/vault/move', moveVaultHandler(vaultDeps));
  router.post('/vault/supersede', supersedeVaultHandler(vaultDeps));
  router.post('/vault/propose', proposeVaultHandler(vaultDeps));

  router.post('/search/simple/', simpleSearchHandler({db: opts.db, embedder: opts.embedder}));
  router.post('/search/simple', simpleSearchHandler({db: opts.db, embedder: opts.embedder}));

  router.get('/resolve', resolveHandler({resolverCache}));

  router.post(
    '/commit',
    commitHandler({
      db: opts.db,
      vaultDataPath: opts.env.vaultDataPath,
      authorName: opts.env.gitAuthorName,
      authorEmail: opts.env.gitAuthorEmail
    })
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
  router.post('/maintenance/cleanup-tag-aliases', cleanupTagAliasesHandler({db: opts.db}));
  router.post(
    '/maintenance/embed-pending',
    embedPendingHandler({db: opts.db, embedder: opts.embedder})
  );
  router.post('/maintenance/release-embedder', releaseEmbedderHandler({embedder: opts.embedder}));
  router.post('/maintenance/run-all', runAllScansHandler({db: opts.db}));
  router.get(
    '/maintenance/raw-inbox',
    rawInboxHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );
  router.get('/maintenance/folder-listing', folderListingHandler({db: opts.db}));
  router.post(
    '/maintenance/snapshot',
    snapshotHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );
  router.get(
    '/maintenance/snapshot-download',
    snapshotDownloadHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );
  router.get(
    '/maintenance/snapshot-list',
    snapshotListHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );
  router.delete(
    '/maintenance/snapshot',
    snapshotDeleteHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );
  router.post(
    '/maintenance/incremental-reindex',
    incrementalReindexHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath, resolverCache})
  );
  router.post(
    '/maintenance/reindex-queues',
    reindexQueuesHandler({db: opts.db, vaultDataPath: opts.env.vaultDataPath})
  );

  // /queue/top before /queue/projects/{name} and /queue/by-* — registration
  // order is precedence in this router.
  router.get('/queue/top', queueTopHandler({db: opts.db}));
  router.get('/queue/ready', queueReadyHandler({db: opts.db}));
  router.get('/queue/blocked', queueBlockedHandler({db: opts.db}));
  router.get('/queue/by-section/{section}', queueBySectionHandler({db: opts.db}));
  router.get('/queue/by-priority/{n}', queueByPriorityHandler({db: opts.db}));
  router.get('/queue/projects/{name}/archive', queueArchiveByProjectHandler({db: opts.db}));
  router.get('/queue/projects/{name}', queueByProjectHandler({db: opts.db}));

  if (opts.env.uiStaticPath) {
    const uiHandler = staticHandler({rootDir: opts.env.uiStaticPath, indexFile: 'index.html'});
    router.get('/ui', uiHandler);
    router.get('/ui/', uiHandler);
    router.get('/ui/{path}', uiHandler);
    // Browsers auto-request /favicon.ico; reuse the file the UI ships.
    router.get('/favicon.ico', ctx => {
      ctx.params['path'] = 'favicon.ico';
      return uiHandler(ctx);
    });
  }

  return router;
};

/**
 * The `/ui/` prefix serves the unauthenticated shell. The page calls API
 * endpoints with the bearer the user pasted into localStorage, so the
 * shell itself doesn't need it. Anyone on the LAN can load the HTML; only
 * a token holder can read or write data.
 */
const isPublicPath = (path: string): boolean =>
  path === '/ui' || path.startsWith('/ui/') || path === '/favicon.ico';

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

      // OPTIONS is a safe method-discovery / CORS-preflight verb: answer it
      // ahead of the auth gate (it reveals only which methods a path accepts,
      // never data) for any known path. 204 + `Allow`; 404 if no route matches.
      if (req.method === 'OPTIONS') {
        const allow = router.allowedMethods(parsed.path);
        if (allow.length === 0) {
          sendError(res, 404, 'not_found', `no route: OPTIONS ${parsed.path}`);
          return;
        }
        res.writeHead(204, {Allow: allow.join(', ')});
        res.end();
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
        // RFC 7231 §6.5.5: a 405 must enumerate the supported methods.
        res.setHeader('Allow', router.allowedMethods(parsed.path).join(', '));
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
