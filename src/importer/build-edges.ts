import type {DatabaseSync} from 'node:sqlite';
import {extractEdgesFromFrontmatter, extractRelatedFromFrontmatter} from '../markdown/wikilinks.ts';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {readFileSync} from 'node:fs';
import {EdgesRepository} from '../records/edges.ts';
import {RecordsRepository} from '../records/repository.ts';
import type {Edge, EdgeType, VaultRecord} from '../records/types.ts';
import {EDGE_TYPES} from '../records/types.ts';
import {classifyBodyLinks} from './classify-wikilinks.ts';
import {SuggestionFiler} from './file-suggestions.ts';
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

interface RecordSource {
  /**
   * Body text + parsed frontmatter data for a record, from a single read.
   * In fs mode one disk read + one parse serves both (the file used to be
   * read and parsed twice — once for the body, once for the FM block).
   */
  read(record: VaultRecord): {body: string; fmData: Record<string, unknown>};
}

const fsRecordSource = (vaultRoot: string): RecordSource => {
  const root = vaultRoot.replace(/\/+$/, '');
  return {
    read(record) {
      const parsed = parseFrontmatter(readFileSync(`${root}/${record.filePath}`, 'utf8'));
      return {body: parsed.body, fmData: parsed.data};
    }
  };
};

const dbRecordSource = (): RecordSource => ({
  read(record) {
    // Imported records store the body FM-stripped, so the parse yields no FM
    // data — DB-only mode has never produced frontmatter-derived edges. The
    // body is passed through verbatim (not re-stripped) to keep parity with
    // the previous behavior for callers whose stored bodies embed FM.
    return {body: record.body, fmData: parseFrontmatter(record.body).data};
  }
});

interface ClassifiedTarget {
  target: string;
  type: Edge['type'];
  /** When true, the edge runs target→source instead of source→target. */
  inverse?: boolean;
}

const SYMMETRIC_TYPES: ReadonlySet<EdgeType> = new Set(['contradicts', 'related-to']);

/** Receives every resolved directed edge (mirrors included) a record's content backs. */
type EdgeSink = (fromId: string, toId: string, type: EdgeType) => void;

const touchKey = (fromId: string, toId: string, type: EdgeType): string =>
  `${fromId}|${toId}|${type}`;

/**
 * Resolve a target list against the record set and feed each directed edge
 * (including auto-mirrors for symmetric types) to `sink`, deduped within
 * this call. Mutates `summary` diagnostics counters; writes nothing itself.
 */
const resolveEdges = (
  resolver: WikilinkResolver,
  source: VaultRecord,
  targets: ClassifiedTarget[],
  summary: EdgeBuildSummary,
  origin: 'frontmatter' | 'body',
  sink: EdgeSink
): void => {
  const seen = new Set<string>();
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
    sink(fromId, toId, type);

    // Auto-mirror symmetric types (contradicts, related-to) per edge-taxonomy.md.
    if (SYMMETRIC_TYPES.has(type)) {
      const mirrorKey = touchKey(toId, fromId, type);
      if (!seen.has(mirrorKey)) {
        seen.add(mirrorKey);
        sink(toId, fromId, type);
      }
    }
  }
};

interface DeclarationHooks {
  /** A default-cites body link got its type pinned by the FM `edges:` map. */
  onOverride?: (toId: string) => void;
  /** An unreviewed default-cites body link (candidate for an `edge_type` suggestion). */
  onCiteNeedingReview?: (toId: string, context: string) => void;
}

/**
 * Walk one record's content (frontmatter `related:`, FM `edges:` overrides,
 * classified body wikilinks) and feed every directed edge it backs to `sink`.
 * Pure with respect to the DB — the caller decides whether the sink writes
 * (the build pass) or merely collects keys (the scoped-GC verifier).
 */
const forEachDeclaredEdge = (
  record: VaultRecord,
  src: RecordSource,
  resolver: WikilinkResolver,
  summary: EdgeBuildSummary,
  sink: EdgeSink,
  hooks: DeclarationHooks = {}
): void => {
  const {body, fmData} = src.read(record);
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

  resolveEdges(
    resolver,
    record,
    related.map(target => ({target, type: 'related-to' as EdgeType})),
    summary,
    'frontmatter',
    sink
  );

  // Body wikilinks: classify, apply FM overrides, then hand off.
  const classified = classifyBodyLinks(body);
  const adjusted: ClassifiedTarget[] = [];

  for (const c of classified) {
    const resolved = resolver.resolve(c.target);
    if (!resolved || resolved === record.recordId) {
      // Pass through to resolveEdges so its existing summary counters fire.
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
      hooks.onOverride?.(resolved);
    }
    adjusted.push(
      c.inverse
        ? {target: c.target, type: finalType, inverse: true}
        : {target: c.target, type: finalType}
    );
    if (c.type === 'cites' && override === undefined && c.context !== undefined) {
      hooks.onCiteNeedingReview?.(resolved, c.context);
    }
  }

  resolveEdges(resolver, record, adjusted, summary, 'body', sink);
};

/** Throwaway summary for read-only declaration walks (scoped-GC verification). */
const scratchSummary = (): EdgeBuildSummary => ({
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
});

/**
 * Walk records, extract wikilinks (`related:` array → 'related-to', body
 * `[[link]]` → 'cites'), resolve to record_ids, and upsert edges. Idempotent.
 *
 * If `vaultRoot` is supplied, body + frontmatter are re-read from disk (one
 * read per record); otherwise the stored body in the DB is used. The disk
 * read matters when records.body intentionally diverges from the file
 * (atomization later splits files into pieces — body of a piece is just one
 * section, not the whole file).
 *
 * Without `scope`, every record is processed and the GC pass sweeps the
 * whole edges table. With `scope` (a set of record_ids), only those records
 * are re-extracted — the incremental path for content-only changes. Scoped
 * mode is ONLY sound when the batch didn't create, delete, or rename files:
 * the resolver keys on file paths alone (path / basename-uniqueness /
 * folder-fallback maps), so content edits can't change how OTHER records'
 * links resolve, but path-set changes can. Callers fall back to a full
 * rebuild in that case (see the watcher / incremental-reindex).
 *
 * Scoped GC: a stale edge candidate is any edge incident to a scoped record
 * that this pass didn't touch. An untouched candidate may still be backed by
 * the OTHER endpoint's content — symmetric auto-mirrors and inverse
 * classifications ("superseded by [[X]]") create edges whose `from_id` is
 * not the declaring record — so candidates are verified against a read-only
 * re-extraction of the counterparty's declarations before deletion.
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
    /** Restrict re-extraction + GC to these record_ids (content-only batches). */
    scope?: ReadonlySet<string>;
  } = {}
): EdgeBuildSummary => {
  const records = new RecordsRepository(db);
  const edges = new EdgesRepository(db);
  const all = records.listAll();
  const resolver = new WikilinkResolver(all);
  const filer = new SuggestionFiler(db, 'edge_type');

  // O(1) lookup from record_id to record (used to render to_path in suggestion payloads).
  const byRecordId = new Map<string, VaultRecord>();
  for (const r of all) byRecordId.set(r.recordId, r);

  const source = options.vaultRoot ? fsRecordSource(options.vaultRoot) : dbRecordSource();
  const now = options.now ?? new Date().toISOString();
  const skipFilingFromTypes =
    options.skipEdgeTypeFilingFromTypes ?? DEFAULT_SKIP_EDGE_TYPE_FILING_FROM;

  const scope = options.scope;
  const work = scope === undefined ? all : all.filter(r => scope.has(r.recordId));

  const summary: EdgeBuildSummary = scratchSummary();
  const start = performance.now();

  // Track every edge that the current pass backs. The GC below deletes edges
  // not in this set — so a wikilink removal in a markdown file actually
  // removes the corresponding edge instead of leaving a dangling row.
  const touched = new Set<string>();

  db.exec('BEGIN');
  try {
    for (const record of work) {
      // Archived notes are kept for inbound wikilink resolution only.
      // Skip outbound extraction so they don't bloat fanout; their stale
      // outbound edges from pre-archive content will be GC'd at the end of
      // this pass since none land in `touched`.
      if (record.status === 'archived') {
        summary.archivedSkipped++;
        continue;
      }

      const citesNeedingReview: Array<{toId: string; context: string}> = [];

      forEachDeclaredEdge(
        record,
        source,
        resolver,
        summary,
        (fromId, toId, type) => {
          touched.add(touchKey(fromId, toId, type));
          edges.upsert({fromId, toId, type, weight: 1, note: null, created: now});
          summary.edgesCreated++;
        },
        {
          // If a pending suggestion already exists for this pair (e.g. the
          // user edited FM manually after filing), auto-resolve it.
          onOverride: toId =>
            filer.accept({from_record: record.recordId, to_record: toId}, 'fm-override', now),
          onCiteNeedingReview: (toId, context) => citesNeedingReview.push({toId, context})
        }
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
        const filed = filer.file(
          {
            from_record: record.recordId,
            from_path: record.filePath,
            to_record: toId,
            to_path: toRecord.filePath,
            classifier_type: 'cites',
            context
          },
          now
        );
        if (filed) summary.suggestionsFiled++;
      }
    }

    if (scope === undefined) {
      // GC pass: any edge in the DB not covered by the current run is stale.
      for (const edge of edges.listAll()) {
        if (!touched.has(touchKey(edge.fromId, edge.toId, edge.type))) {
          edges.delete(edge.fromId, edge.toId, edge.type);
          summary.edgesDeleted++;
        }
      }
    } else {
      // Scoped GC: only edges incident to scoped records can have gone
      // stale (content elsewhere didn't change). An untouched candidate is
      // deleted unless the counterparty's content still backs it.
      const counterpartyKeys = new Map<string, ReadonlySet<string>>();
      const keysFor = (rec: VaultRecord): ReadonlySet<string> => {
        const keys = new Set<string>();
        // Archived counterparties back nothing — extraction skips them above.
        if (rec.status !== 'archived') {
          forEachDeclaredEdge(rec, source, resolver, scratchSummary(), (f, t, ty) =>
            keys.add(touchKey(f, t, ty))
          );
        }
        return keys;
      };

      for (const record of work) {
        const candidates = [
          ...edges.listOutbound(record.recordId),
          ...edges.listInbound(record.recordId)
        ];
        const judged = new Set<string>();
        for (const e of candidates) {
          const k = touchKey(e.fromId, e.toId, e.type);
          if (touched.has(k) || judged.has(k)) continue;
          judged.add(k);
          const otherId = e.fromId === record.recordId ? e.toId : e.fromId;
          // Both endpoints scoped → both fully re-extracted; untouched means stale.
          if (scope.has(otherId)) {
            if (edges.delete(e.fromId, e.toId, e.type)) summary.edgesDeleted++;
            continue;
          }
          let otherKeys = counterpartyKeys.get(otherId);
          if (otherKeys === undefined) {
            const otherRecord = byRecordId.get(otherId);
            otherKeys = otherRecord === undefined ? new Set() : keysFor(otherRecord);
            counterpartyKeys.set(otherId, otherKeys);
          }
          if (!otherKeys.has(k)) {
            if (edges.delete(e.fromId, e.toId, e.type)) summary.edgesDeleted++;
          }
        }
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
