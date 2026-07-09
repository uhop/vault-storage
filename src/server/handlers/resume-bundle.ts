import type {DatabaseSync} from 'node:sqlite';
import {incrementalReindex} from '../../maintenance/incremental-reindex.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {computeLintReport, type LintReport} from './lint.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface ResumeBundleDeps {
  db: DatabaseSync;
  records: RecordsRepository;
  vaultDataPath: string;
}

const WORKFLOW_QUEUE_PATH = 'projects/agent-workflow/queue.md';
const CLARIFY_QUEUE_PATH = 'projects/agent-workflow/clarify-queue.md';

// feedback.md ships its full body: it is the read path for fleet-shared
// working rules and must land in the session verbatim. The rest ship
// summaries + sizes; the agent fetches bodies only when it needs them.
const PROJECT_FILES = ['feedback', 'queue', 'decisions', 'learnings', 'stack'] as const;

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const DEFAULT_LOGS = 3;
const MAX_LOGS = 20;

/** Body of `## <title>` up to the next `## ` heading; null when absent. */
const extractSection = (body: string, title: string): string | null => {
  const match = new RegExp(`^## ${title}[ \\t]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(
    body
  );
  if (!match || match[1] === undefined) return null;
  return match[1].trim();
};

const emptySection = (text: string | null): boolean =>
  text === null || text.length === 0 || text === '(empty)';

/**
 * POST /system/resume-bundle?project=<name>&logs=<n>
 *
 * One-shot session-start bundle for `/vault resume`: runs the incremental
 * reindex (so everything after it reads fresh state), then packages the
 * integrity lint (non-zero checks only), pending-suggestion counts, the
 * agent-workflow surface, the most recent session logs as their
 * `agent.summary` lines, and the requested project's notes. Replaces ~6
 * separate reads with one prepared payload — the agent spends its turns on
 * synthesis, not fetching. POST because the embedded reindex writes.
 */
export const resumeBundleHandler =
  (deps: ResumeBundleDeps): Handler =>
  async ctx => {
    const project = ctx.query['project'];
    if (project !== undefined && !PROJECT_NAME_RE.test(project)) {
      sendError(ctx.res, 400, 'bad_request', 'project must be a kebab-case name');
      return;
    }
    const logsRaw = ctx.query['logs'];
    let logsLimit = DEFAULT_LOGS;
    if (logsRaw !== undefined) {
      const n = Number.parseInt(logsRaw, 10);
      if (!Number.isFinite(n) || n < 0 || n > MAX_LOGS) {
        sendError(ctx.res, 400, 'bad_request', `logs must be an integer in 0..${MAX_LOGS}`);
        return;
      }
      logsLimit = n;
    }
    // `project_bodies` opts additional project files into full-body delivery
    // (wrap prep needs learnings/decisions verbatim for dedup); feedback.md
    // always ships its body — it is the fleet-feedback read path.
    const projectBodies = new Set<string>(['feedback']);
    const bodiesRaw = ctx.query['project_bodies'];
    if (bodiesRaw !== undefined) {
      for (const name of bodiesRaw.split(',').filter(s => s.length > 0)) {
        if (!(PROJECT_FILES as readonly string[]).includes(name)) {
          sendError(
            ctx.res,
            400,
            'bad_request',
            `unknown project file: ${name} (expected: ${PROJECT_FILES.join(', ')})`
          );
          return;
        }
        projectBodies.add(name);
      }
    }

    const {db, records} = deps;
    const reindex = await incrementalReindex(db, deps.vaultDataPath);

    const fullLint = computeLintReport(db);
    const nonZeroChecks: LintReport['checks'] = {};
    for (const [name, check] of Object.entries(fullLint.checks)) {
      if (check.count > 0) nonZeroChecks[name] = check;
    }
    const {total, enriched, unenriched} = fullLint.coverage.enrichment;

    const suggestionRows = db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM suggestions WHERE status = 'pending' GROUP BY kind ORDER BY n DESC`
      )
      .all() as unknown[] as {kind: string; n: number}[];
    const byKind: Record<string, number> = {};
    let suggestionsTotal = 0;
    for (const row of suggestionRows) {
      byKind[row.kind] = row.n;
      suggestionsTotal += row.n;
    }

    // Agent-workflow surface — opt-in files; absent → nulls, never an error.
    const workflowQueue = records.getByPath(WORKFLOW_QUEUE_PATH);
    const activeRaw = workflowQueue ? extractSection(workflowQueue.body, 'Active') : null;
    const clarifyQueue = records.getByPath(CLARIFY_QUEUE_PATH);
    const clarifyPending = clarifyQueue
      ? ((extractSection(clarifyQueue.body, 'Pending') ?? '').match(/^### Q-/gm)?.length ?? 0)
      : null;

    const logRows =
      logsLimit === 0
        ? []
        : (db
            .prepare(
              `SELECT file_path, title, updated, agent_summary
                 FROM records
                WHERE type = 'log'
                  AND file_path NOT LIKE 'archive/%'
                  AND file_path NOT LIKE '%/archive/%'
                ORDER BY COALESCE(modified_at, updated) DESC, file_path DESC
                LIMIT ?`
            )
            .all(logsLimit) as unknown[] as {
            file_path: string;
            title: string | null;
            updated: string;
            agent_summary: string | null;
          }[]);

    let projectBlock: Record<string, unknown> | null = null;
    if (project !== undefined) {
      const files: Record<string, unknown> = {};
      let found = false;
      for (const name of PROJECT_FILES) {
        const record = records.getByPath(`projects/${project}/${name}.md`);
        if (!record) {
          files[name] = null;
          continue;
        }
        found = true;
        files[name] = {
          file_path: record.filePath,
          updated: record.updated,
          summary: record.agentSummary,
          body_bytes: Buffer.byteLength(record.body, 'utf8'),
          ...(projectBodies.has(name) ? {body: record.body} : {})
        };
      }
      projectBlock = {name: project, found, files};
    }

    sendJson(ctx.res, 200, {
      reindex,
      lint: {
        ok: fullLint.ok,
        total_issues: fullLint.total_issues,
        checks: nonZeroChecks,
        coverage_enrichment: {total, enriched, unenriched}
      },
      suggestions: {total: suggestionsTotal, by_kind: byKind},
      workflow: {
        active: emptySection(activeRaw) ? null : activeRaw,
        clarify_pending: clarifyPending
      },
      logs: logRows.map(r => ({
        file_path: r.file_path,
        title: r.title,
        updated: r.updated,
        summary: r.agent_summary
      })),
      project: projectBlock
    });
  };
