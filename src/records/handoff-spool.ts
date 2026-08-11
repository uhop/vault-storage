import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {join} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';

// Spool file layer for handoffs (agent-coordination design, leg 2): a
// gitignored directory at the vault root, `handoff/<project>/<status>/<id>.md`.
// Files are the source of truth — the DB table is an index rebuilt by scan on
// every server start. Status lives in the path (a transition is an atomic
// rename), everything else in the sidecar's `handoff:` frontmatter block.
// A handoff is a *basename*: `<id>.*` siblings (a `.patch` in leg 3) move and
// die together with the sidecar.

export const SPOOL_DIR = 'handoff';

export const HANDOFF_STATUSES = ['open', 'claimed', 'done', 'rejected', 'returned'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** Sidecar frontmatter payload — everything the path does not already say. */
export interface SpoolSidecar {
  id: string;
  idempotency_key: string;
  project: string;
  to: string;
  kind: string;
  ref?: {type: string; value: string};
  from: {host: string; session: string; repo?: string};
  created: string;
  updated: string;
  claimed_by?: string;
  claimed_at?: string;
  claim_expires?: string;
  result?: Record<string, unknown>;
  notes: {author: string; at: string; text: string}[];
}

export interface SpoolEntry {
  status: HandoffStatus;
  sidecar: SpoolSidecar;
  body: string;
}

const spoolRoot = (vaultDataPath: string): string => join(vaultDataPath, SPOOL_DIR);

const statusDir = (vaultDataPath: string, project: string, status: HandoffStatus): string =>
  join(spoolRoot(vaultDataPath), project, status);

export const sidecarPath = (
  vaultDataPath: string,
  project: string,
  status: HandoffStatus,
  id: string
): string => join(statusDir(vaultDataPath, project, status), `${id}.md`);

/**
 * Make the spool self-gitignoring: `handoff/.gitignore` containing `*`
 * ignores every spool file (itself included), so vault-data never tracks
 * in-flight coordination state — no edit to the repo's own .gitignore needed.
 * The root walker skip (leg 1) keeps the same files out of the index.
 */
export const ensureSpool = (vaultDataPath: string): void => {
  const root = spoolRoot(vaultDataPath);
  mkdirSync(root, {recursive: true});
  const gitignore = join(root, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n');
};

export const writeSidecar = (vaultDataPath: string, entry: SpoolEntry): void => {
  ensureSpool(vaultDataPath);
  const dir = statusDir(vaultDataPath, entry.sidecar.project, entry.status);
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${entry.sidecar.id}.md`),
    serializeFrontmatter({data: {handoff: structuredClone(entry.sidecar)}, body: entry.body})
  );
};

export const readSidecar = (
  vaultDataPath: string,
  project: string,
  status: HandoffStatus,
  id: string
): SpoolEntry | null => {
  const path = sidecarPath(vaultDataPath, project, status, id);
  if (!existsSync(path)) return null;
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
  const sidecar = parsed.data['handoff'];
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) return null;
  return {status, sidecar: sidecar as unknown as SpoolSidecar, body: parsed.body};
};

/** Every `<id>.*` sibling in a status directory — the basename is the handoff. */
const siblingNames = (dir: string, id: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name === `${id}.md` || name.startsWith(`${id}.`));
};

/** Status transition as an atomic rename per sibling; sidecar content is untouched. */
export const moveEntry = (
  vaultDataPath: string,
  project: string,
  id: string,
  from: HandoffStatus,
  to: HandoffStatus
): void => {
  const fromDir = statusDir(vaultDataPath, project, from);
  const toDir = statusDir(vaultDataPath, project, to);
  mkdirSync(toDir, {recursive: true});
  for (const name of siblingNames(fromDir, id)) {
    renameSync(join(fromDir, name), join(toDir, name));
  }
};

/** Remove a resolved entry (all siblings) — the archive in vault-data has taken over. */
export const removeEntry = (
  vaultDataPath: string,
  project: string,
  status: HandoffStatus,
  id: string
): void => {
  const dir = statusDir(vaultDataPath, project, status);
  for (const name of siblingNames(dir, id)) rmSync(join(dir, name), {force: true});
};

/**
 * Scan the whole spool: every parseable sidecar, status taken from its
 * directory (the path is truth for status even when the frontmatter carries
 * stale claim fields from a crash between rewrite and rename). Unparseable
 * files are skipped and reported, never fatal — a human can still read them.
 */
export const scanSpool = (vaultDataPath: string): {entries: SpoolEntry[]; skipped: string[]} => {
  const root = spoolRoot(vaultDataPath);
  const entries: SpoolEntry[] = [];
  const skipped: string[] = [];
  if (!existsSync(root)) return {entries, skipped};
  for (const projectEntry of readdirSync(root, {withFileTypes: true})) {
    if (!projectEntry.isDirectory()) continue;
    for (const status of HANDOFF_STATUSES) {
      const dir = join(root, projectEntry.name, status);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const id = name.slice(0, -3);
        const entry = readSidecar(vaultDataPath, projectEntry.name, status, id);
        if (entry === null || entry.sidecar.id !== id) {
          skipped.push(join(SPOOL_DIR, projectEntry.name, status, name));
          continue;
        }
        entries.push(entry);
      }
    }
  }
  return {entries, skipped};
};
