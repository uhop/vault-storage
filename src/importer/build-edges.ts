import type {DatabaseSync} from 'node:sqlite';
import {extractRelatedFromFrontmatter} from '../markdown/wikilinks.ts';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {readFileSync} from 'node:fs';
import {EdgesRepository} from '../records/edges.ts';
import {RecordsRepository} from '../records/repository.ts';
import type {Edge, EdgeType, VaultRecord} from '../records/types.ts';
import {classifyBodyLinks} from './classify-wikilinks.ts';
import {WikilinkResolver} from './resolver.ts';

export interface EdgeBuildSummary {
  /** Edges actually written to the DB (idempotent — re-runs over the same content yield 0). */
  edgesCreated: number;
  /** Frontmatter `related:` targets that didn't resolve to any record. */
  unresolvedFrontmatter: number;
  /** Body `[[wikilink]]` targets that didn't resolve to any record. */
  unresolvedBody: number;
  /** Wikilinks pointing at the source record itself; skipped. */
  selfReferences: number;
  durationMs: number;
}

interface FileBodySource {
  /** Read fresh from disk so body wikilinks are extracted from up-to-date content. */
  read(record: VaultRecord): string;
}

const fsBodySource = (vaultRoot: string): FileBodySource => ({
  read(record) {
    const abs = `${vaultRoot.replace(/\/+$/, '')}/${record.filePath}`;
    const source = readFileSync(abs, 'utf8');
    return parseFrontmatter(source).body;
  }
});

const dbBodySource = (): FileBodySource => ({
  read(record) {
    return record.body;
  }
});

/**
 * Walk every record, extract wikilinks (`related:` array → 'related-to', body
 * `[[link]]` → 'cites'), resolve to record_ids, and upsert edges. Idempotent.
 *
 * If `vaultRoot` is supplied, body text is re-read from disk; otherwise the
 * stored body in the DB is used. Both produce the same edges; the disk read
 * matters when records.body intentionally diverges from the file (atomization
 * later splits files into pieces — body of a piece is just one section, not
 * the whole file).
 */
export const buildEdges = (
  db: DatabaseSync,
  options: {vaultRoot?: string; now?: string} = {}
): EdgeBuildSummary => {
  const records = new RecordsRepository(db);
  const edges = new EdgesRepository(db);
  const all = records.listAll();
  const resolver = new WikilinkResolver(all);

  const source = options.vaultRoot ? fsBodySource(options.vaultRoot) : dbBodySource();
  const now = options.now ?? new Date().toISOString();

  const summary: EdgeBuildSummary = {
    edgesCreated: 0,
    unresolvedFrontmatter: 0,
    unresolvedBody: 0,
    selfReferences: 0,
    durationMs: 0
  };
  const start = performance.now();

  db.exec('BEGIN');
  try {
    for (const record of all) {
      const body = source.read(record);

      // Frontmatter `related:` is on the file itself, not the record body.
      // Re-parse from disk if we have the vaultRoot; fall back to stored body when DB-only.
      const frontmatterText = options.vaultRoot
        ? readFromDisk(options.vaultRoot, record.filePath)
        : record.body;
      const fmData = parseFrontmatter(frontmatterText).data;
      const related = extractRelatedFromFrontmatter(fmData);

      summary.edgesCreated += writeEdges(
        edges,
        resolver,
        record,
        related.map(target => ({target, type: 'related-to' as EdgeType})),
        now,
        summary,
        'frontmatter'
      );

      summary.edgesCreated += writeEdges(
        edges,
        resolver,
        record,
        classifyBodyLinks(body),
        now,
        summary,
        'body'
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};

const readFromDisk = (vaultRoot: string, relativePath: string): string => {
  const abs = `${vaultRoot.replace(/\/+$/, '')}/${relativePath}`;
  return readFileSync(abs, 'utf8');
};

interface ClassifiedTarget {
  target: string;
  type: Edge['type'];
  /** When true, the edge runs target→source instead of source→target. */
  inverse?: boolean;
}

const SYMMETRIC_TYPES: ReadonlySet<EdgeType> = new Set(['contradicts', 'related-to']);

const writeEdges = (
  edges: EdgesRepository,
  resolver: WikilinkResolver,
  source: VaultRecord,
  targets: ClassifiedTarget[],
  now: string,
  summary: EdgeBuildSummary,
  origin: 'frontmatter' | 'body'
): number => {
  const seen = new Set<string>();
  let written = 0;
  for (const {target, type, inverse} of targets) {
    const resolved = resolver.resolve(target);
    if (!resolved) {
      if (origin === 'frontmatter') summary.unresolvedFrontmatter++;
      else summary.unresolvedBody++;
      continue;
    }
    if (resolved === source.recordId) {
      summary.selfReferences++;
      continue;
    }
    const fromId = inverse ? resolved : source.recordId;
    const toId = inverse ? source.recordId : resolved;
    const dedupKey = `${fromId}|${toId}|${type}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    edges.upsert({
      fromId,
      toId,
      type,
      weight: 1,
      note: null,
      created: now
    });
    written++;

    // Auto-mirror symmetric types (contradicts, related-to) per edge-taxonomy.md.
    if (SYMMETRIC_TYPES.has(type)) {
      const mirrorKey = `${toId}|${fromId}|${type}`;
      if (!seen.has(mirrorKey)) {
        seen.add(mirrorKey);
        edges.upsert({
          fromId: toId,
          toId: fromId,
          type,
          weight: 1,
          note: null,
          created: now
        });
        written++;
      }
    }
  }
  return written;
};
