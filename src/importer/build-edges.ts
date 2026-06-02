import type {DatabaseSync} from 'node:sqlite';
import {extractEdgesFromFrontmatter, extractRelatedFromFrontmatter} from '../markdown/wikilinks.ts';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {readFileSync} from 'node:fs';
import {EdgesRepository} from '../records/edges.ts';
import {RecordsRepository} from '../records/repository.ts';
import type {Edge, EdgeType, VaultRecord} from '../records/types.ts';
import {EDGE_TYPES} from '../records/types.ts';
import {classifyBodyLinks} from './classify-wikilinks.ts';
import {EdgeSuggestionFiler} from './file-suggestions.ts';
import {WikilinkResolver} from './resolver.ts';

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

/**
 * Record types where a default-`cites` body wikilink is overwhelmingly
 * the right answer, so filing an `edge_type` review suggestion just
 * adds noise to the queue. `log` / `query` notes by convention cite
 * topic / project notes; `meta` is the type carried by compaction
 * summaries (`logs/_summary-*`), the archived `_index.md` stub, and
 * similar derived-from-other-records files whose wikilinks are by
 * definition cites of canon. None of these cross-links warrant
 * reclassification to `derived-from`, `applies-to`, etc. Skipping the
 * filing for these source types cut ~30–50% of edge_type fire rate
 * during the 2026-05-03 session that produced 5 noisy log→topic
 * suggestions in one PUT; `meta` joined the set 2026-06-02 after a
 * `_summary-*` import fired 19 such suggestions in one go (discovered
 * 2026-05-09 during `/vault-compact logs`). Override per-call via
 * `buildEdges({skipEdgeTypeFilingFromTypes: ...})`.
 */
export const DEFAULT_SKIP_EDGE_TYPE_FILING_FROM: ReadonlySet<string> = new Set([
  'log',
  'query',
  'meta'
]);

export interface EdgeBuildSummary {
  /** Edges actually written to the DB (idempotent — re-runs over the same content yield 0). */
  edgesCreated: number;
  /** Stale edges removed because no current wikilink/frontmatter target backs them. */
  edgesDeleted: number;
  /** Frontmatter `related:` targets that didn't resolve to any record. */
  unresolvedFrontmatter: number;
  /** Body `[[wikilink]]` targets that didn't resolve to any record. */
  unresolvedBody: number;
  /** Wikilinks pointing at the source record itself; skipped. */
  selfReferences: number;
  /** Frontmatter `edges:` overrides applied (cites → user-pinned type). */
  fmOverridesApplied: number;
  /** New `edge_type` suggestions filed for unreviewed default-cites edges. */
  suggestionsFiled: number;
  /** Default-cites edges from a high-cite source type (log, query, meta) that
   *  bypassed `edge_type` filing per `skipEdgeTypeFilingFromTypes`. The
   *  edges still land in the DB; only the review-queue noise is suppressed. */
  suggestionsSkippedByType: number;
  /** Archived records skipped — outbound edges are not extracted from `status: archived` notes. */
  archivedSkipped: number;
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
  options: {
    vaultRoot?: string;
    now?: string;
    /**
     * Source-record types that should NOT file `edge_type` review
     * suggestions for their default-cites body wikilinks. Defaults to
     * `DEFAULT_SKIP_EDGE_TYPE_FILING_FROM` (log + query + meta). Pass an
     * empty set to file for all types (legacy behavior); pass a custom set
     * to tune.
     */
    skipEdgeTypeFilingFromTypes?: ReadonlySet<string>;
  } = {}
): EdgeBuildSummary => {
  const records = new RecordsRepository(db);
  const edges = new EdgesRepository(db);
  const all = records.listAll();
  const resolver = new WikilinkResolver(all);
  const filer = new EdgeSuggestionFiler(db);

  // O(1) lookup from record_id to record (used to render to_path in suggestion payloads).
  const byRecordId = new Map<string, VaultRecord>();
  for (const r of all) byRecordId.set(r.recordId, r);

  const source = options.vaultRoot ? fsBodySource(options.vaultRoot) : dbBodySource();
  const now = options.now ?? new Date().toISOString();
  const skipFilingFromTypes =
    options.skipEdgeTypeFilingFromTypes ?? DEFAULT_SKIP_EDGE_TYPE_FILING_FROM;

  const summary: EdgeBuildSummary = {
    edgesCreated: 0,
    edgesDeleted: 0,
    unresolvedFrontmatter: 0,
    unresolvedBody: 0,
    selfReferences: 0,
    fmOverridesApplied: 0,
    suggestionsFiled: 0,
    suggestionsSkippedByType: 0,
    archivedSkipped: 0,
    durationMs: 0
  };
  const start = performance.now();

  // Track every edge that the current vault content backs. After the pass we
  // delete edges in the DB that aren't in this set — that's edge GC, so a
  // wikilink removal in a markdown file actually removes the corresponding
  // edge instead of leaving a dangling row.
  const touched = new Set<string>();
  const touchKey = (fromId: string, toId: string, type: EdgeType): string =>
    `${fromId}|${toId}|${type}`;

  db.exec('BEGIN');
  try {
    for (const record of all) {
      // Archived notes are kept for inbound wikilink resolution only.
      // Skip outbound extraction so they don't bloat fanout; their stale
      // outbound edges from pre-archive content will be GC'd at the end of
      // this pass since none land in `touched`.
      if (record.status === 'archived') {
        summary.archivedSkipped++;
        continue;
      }

      const body = source.read(record);

      // Frontmatter `related:` is on the file itself, not the record body.
      // Re-parse from disk if we have the vaultRoot; fall back to stored body when DB-only.
      const frontmatterText = options.vaultRoot
        ? readFromDisk(options.vaultRoot, record.filePath)
        : record.body;
      const fmData = parseFrontmatter(frontmatterText).data;
      const related = extractRelatedFromFrontmatter(fmData);

      // FM `edges:` map: target string → edge type. The user's per-record
      // override for the body-wikilink classifier. Resolve target strings to
      // record_ids so build-edges can match by toId regardless of which slug
      // form ([[foo]] vs [[topics/foo]]) the body uses.
      const fmEdgesRaw = extractEdgesFromFrontmatter(fmData, EDGE_TYPE_SET);
      const fmOverrides = new Map<string, EdgeType>(); // toId → type
      for (const [target, type] of fmEdgesRaw) {
        const resolved = resolver.resolve(target);
        if (resolved && resolved !== record.recordId) {
          fmOverrides.set(resolved, type as EdgeType);
        }
      }

      summary.edgesCreated += writeEdges(
        edges,
        resolver,
        record,
        related.map(target => ({target, type: 'related-to' as EdgeType})),
        now,
        summary,
        'frontmatter',
        touched,
        touchKey
      );

      // Body wikilinks: classify, apply FM overrides, write, then file
      // suggestions for default-cites the user hasn't yet decided on.
      const classified = classifyBodyLinks(body);
      const adjusted: ClassifiedTarget[] = [];
      const citesNeedingReview: Array<{toId: string; context: string}> = [];

      for (const c of classified) {
        const resolved = resolver.resolve(c.target);
        if (!resolved || resolved === record.recordId) {
          // Pass through to writeEdges so its existing summary counters fire.
          adjusted.push(
            c.inverse
              ? {target: c.target, type: c.type, inverse: true}
              : {target: c.target, type: c.type}
          );
          continue;
        }
        let finalType = c.type;
        const override = fmOverrides.get(resolved);
        if (c.type === 'cites' && override !== undefined) {
          finalType = override;
          summary.fmOverridesApplied++;
          // If a pending suggestion already exists for this pair (e.g. the
          // user edited FM manually after filing), auto-resolve it.
          filer.autoAcceptOnFmOverride(record.recordId, resolved, now);
        }
        adjusted.push(
          c.inverse
            ? {target: c.target, type: finalType, inverse: true}
            : {target: c.target, type: finalType}
        );
        if (c.type === 'cites' && override === undefined && c.context !== undefined) {
          citesNeedingReview.push({toId: resolved, context: c.context});
        }
      }

      summary.edgesCreated += writeEdges(
        edges,
        resolver,
        record,
        adjusted,
        now,
        summary,
        'body',
        touched,
        touchKey
      );

      // File one suggestion per (fromRecord, toRecord) for unreviewed default-cites.
      // The filer is idempotent: a suggestion of any status for the same pair
      // is left in place.
      //
      // Source-type skip: log / query / meta sources default-cite
      // topic/project notes by convention (meta = compaction summaries &
      // the archived index stub); flagging them for review just adds queue
      // noise. Edges still land in the DB at type=cites; only the
      // review-queue filing is skipped. Per `DEFAULT_SKIP_EDGE_TYPE_FILING_FROM`.
      const skipFilingForRecord = skipFilingFromTypes.has(record.type);
      const filedFor = new Set<string>();
      for (const {toId, context} of citesNeedingReview) {
        if (filedFor.has(toId)) continue;
        filedFor.add(toId);
        if (skipFilingForRecord) {
          ++summary.suggestionsSkippedByType;
          continue;
        }
        const toRecord = byRecordId.get(toId);
        if (!toRecord) continue;
        const filed = filer.fileEdgeTypeSuggestion({
          fromRecordId: record.recordId,
          fromPath: record.filePath,
          toRecordId: toId,
          toPath: toRecord.filePath,
          context,
          now
        });
        if (filed) summary.suggestionsFiled++;
      }
    }

    // GC pass: any edge in the DB not covered by the current run is stale.
    for (const edge of edges.listAll()) {
      if (!touched.has(touchKey(edge.fromId, edge.toId, edge.type))) {
        edges.delete(edge.fromId, edge.toId, edge.type);
        summary.edgesDeleted++;
      }
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
  origin: 'frontmatter' | 'body',
  touched: Set<string>,
  touchKey: (fromId: string, toId: string, type: EdgeType) => string
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
    const dedupKey = touchKey(fromId, toId, type);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    touched.add(dedupKey);

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
      const mirrorKey = touchKey(toId, fromId, type);
      if (!seen.has(mirrorKey)) {
        seen.add(mirrorKey);
        touched.add(mirrorKey);
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
