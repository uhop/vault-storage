// The stored fleet-status data as a derivative (schema 0036, D110): the
// `## GitHub` and `## Packages` JSON blocks of every `projects/<name>/state.md`
// and the runs of `projects/agent-workflow/fleet-status.md`, kept current by
// every import so `GET /fleet/status` answers in one read. Markdown stays the
// source of truth; the readers here match the client's in
// `static/ui/fleet-digest.js` and the CLI's in claude-config, line for line.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {prepared} from '../db/prepared.ts';

export const DIGEST_PATH = 'projects/agent-workflow/fleet-status.md';
const STATE_RE = /^projects\/([^/]+)\/state\.md$/;
const GITHUB_HEADING = '## GitHub';
const PACKAGES_HEADING = '## Packages';
const FENCE_RE = /```json\n([\s\S]*?)\n```/;

export interface FleetBaseline {
  project: string;
  repo: string | null;
  github: Record<string, unknown> | null;
  packages: Record<string, unknown> | null;
}

export interface FleetRun {
  collected_at: string;
  mode: string | null;
  repos?: Array<{project?: string; repo?: string} & Record<string, unknown>>;
  [key: string]: unknown;
}

export interface FleetStateApply {
  baselines: number;
  runs: number;
}

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The JSON block under `heading`, up to the next H2; null when absent or malformed. */
export const parseSection = (body: string, heading: string): Record<string, unknown> | null => {
  const text = `\n${body}`;
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) return null;
  const rest = text.slice(at + 1);
  const next = rest.indexOf('\n## ');
  const m = FENCE_RE.exec(next < 0 ? rest : rest.slice(0, next));
  return m ? parseJson(m[1]!) : null;
};

/** Every run of the digest note, newest first: one `## <time>` section with a JSON block each. */
export const parseRuns = (body: string): FleetRun[] => {
  const runs: FleetRun[] = [];
  for (const section of `\n${body}`.split(/\n(?=## )/)) {
    const m = FENCE_RE.exec(section);
    if (!m) continue;
    const run = parseJson(m[1]!);
    if (run && typeof run['collected_at'] === 'string') runs.push(run as FleetRun);
  }
  return runs.sort((a, b) =>
    a.collected_at < b.collected_at ? 1 : a.collected_at > b.collected_at ? -1 : 0
  );
};

const stringOr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class FleetStateRepository {
  readonly #deleteBaseline: StatementSync;
  readonly #upsertBaseline: StatementSync;
  readonly #deleteRuns: StatementSync;
  readonly #insertRun: StatementSync;
  readonly #listBaselines: StatementSync;
  readonly #getBaseline: StatementSync;
  readonly #listRuns: StatementSync;

  constructor(db: DatabaseSync) {
    this.#deleteBaseline = prepared(db, 'DELETE FROM fleet_baselines WHERE record_id = ?');
    this.#upsertBaseline = prepared(
      db,
      `INSERT INTO fleet_baselines
         (record_id, project, repo, github, github_collected_at, packages, packages_collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         project = excluded.project, repo = excluded.repo,
         github = excluded.github, github_collected_at = excluded.github_collected_at,
         packages = excluded.packages, packages_collected_at = excluded.packages_collected_at`
    );
    this.#deleteRuns = prepared(db, 'DELETE FROM fleet_runs WHERE record_id = ?');
    this.#insertRun = prepared(
      db,
      `INSERT INTO fleet_runs (record_id, collected_at, mode, run) VALUES (?, ?, ?, ?)
       ON CONFLICT(record_id, collected_at) DO UPDATE SET mode = excluded.mode, run = excluded.run`
    );
    this.#listBaselines = prepared(
      db,
      'SELECT project, repo, github, packages FROM fleet_baselines ORDER BY project'
    );
    this.#getBaseline = prepared(
      db,
      'SELECT project, repo, github, packages FROM fleet_baselines WHERE project = ?'
    );
    this.#listRuns = prepared(
      db,
      `SELECT run FROM fleet_runs WHERE collected_at >= ? ORDER BY collected_at DESC LIMIT ?`
    );
  }

  /**
   * Keep the record's rows in step with its file: a state document's baseline,
   * the digest's runs, or nothing when the path is neither (a rename away
   * clears what the record had). The rows of a deleted record go with it.
   */
  apply(recordId: string, relativePath: string, body: string): FleetStateApply {
    const state = STATE_RE.exec(relativePath);
    if (state) {
      const github = parseSection(body, GITHUB_HEADING);
      const packages = parseSection(body, PACKAGES_HEADING);
      this.#deleteRuns.run(recordId);
      if (github === null && packages === null) {
        this.#deleteBaseline.run(recordId);
        return {baselines: 0, runs: 0};
      }
      this.#upsertBaseline.run(
        recordId,
        state[1]!,
        stringOr(github?.['repo']) ?? stringOr(packages?.['repo']),
        github === null ? null : JSON.stringify(github),
        stringOr(github?.['collected_at']),
        packages === null ? null : JSON.stringify(packages),
        stringOr(packages?.['collected_at'])
      );
      return {baselines: 1, runs: 0};
    }
    this.#deleteBaseline.run(recordId);
    this.#deleteRuns.run(recordId);
    if (relativePath !== DIGEST_PATH) return {baselines: 0, runs: 0};
    const runs = parseRuns(body);
    for (const run of runs) {
      this.#insertRun.run(recordId, run.collected_at, stringOr(run['mode']), JSON.stringify(run));
    }
    return {baselines: 0, runs: runs.length};
  }

  baselines(project?: string): FleetBaseline[] {
    const rows = (project === undefined
      ? this.#listBaselines.all()
      : this.#getBaseline.all(project)) as unknown as {
      project: string;
      repo: string | null;
      github: string | null;
      packages: string | null;
    }[];
    return rows.map(r => ({
      project: r.project,
      repo: r.repo,
      github: r.github === null ? null : (JSON.parse(r.github) as Record<string, unknown>),
      packages: r.packages === null ? null : (JSON.parse(r.packages) as Record<string, unknown>)
    }));
  }

  /** Runs newest first, at or after `since`, at most `limit`. */
  runs(since: string, limit: number): FleetRun[] {
    const rows = this.#listRuns.all(since, limit) as unknown as {run: string}[];
    return rows.map(r => JSON.parse(r.run) as FleetRun);
  }
}
