// A tool description is the entire contract an agent sees before calling, so
// a field the response carries but the description omits reads as absent and
// sends the agent to curl for data it already had. These tests pin the
// response-shape claims that were wrong or missing in the 2026-08-03 audit,
// so the next handler change that alters a shape has to update the prose too.

import test from 'tape-six';
import {VaultClient} from '../src/client.js';
import {registerTools} from '../src/tools.js';

const descriptions = () => {
  const map = new Map();
  registerTools(
    {registerTool: (name, config) => map.set(name, config.description)},
    new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl: () => {}})
  );
  return map;
};

/** Every field name a description must mention for its documented shape. */
const REQUIRED_MENTIONS = {
  // The filed defect: /system/lint carries `coverage` beside {ok, total_issues,
  // checks}, and all nine check names — the description advertised five.
  vault_lint: [
    'coverage',
    'unenriched_records',
    'by_type',
    'embedding_hash_drift',
    'records_without_embeddings',
    'orphan_embeddings',
    'orphan_doc_embeddings',
    'orphan_vec_rows',
    'orphan_suggestions',
    'temporal_anomalies',
    'dangling_tag_aliases',
    'auto_commit_failing'
  ],
  vault_status: ['embedder', 'memory', 'sqlite_vec_version', 'last_indexed_commit'],
  vault_suggestions_summary: ['statuses', 'total', 'by_kind'],
  vault_neighborhood: ['root_id', 'layers', 'edges', 'direction'],
  vault_similar: ['root_id', 'distance', 'score'],
  vault_backlinks: ['edge', 'from_record', 'offset', 'total'],
  // Conditional fields are the worst case of this defect class: they are
  // absent from a canonical-name probe, so only source review finds them.
  vault_records_by_tag: ['items', 'offset', 'limit', 'total', 'alias_for', 'requested'],
  vault_tag_info: ['aliases', 'record_count', 'requested'],
  vault_list_tags: ['record_count', 'offset', 'total'],
  vault_list_pieces: ['items', 'offset', 'limit', 'total'],
  vault_list_suggestions: ['claim_expires', 'subject_id', 'offset', 'total'],
  vault_claim_suggestions: ['claimed', 'remaining_pending', 'claim_expires'],
  vault_resolve_suggestions_batch: ['accepted', 'rejected', 'failed', 'results'],
  vault_queue_reindex: ['filesProcessed', 'staleSlicesDropped', 'errors', 'durationMs'],
  vault_resume_bundle: [
    'coverage_enrichment',
    'project_bodies',
    'body_bytes',
    'body_omitted',
    'bundle_budget',
    'headings'
  ],
  vault_context_pack: [
    'chunks',
    'chunk_index',
    'sources',
    'neighborhood_total',
    'inbound_total',
    'max_bytes',
    'used_bytes',
    'chunks_dropped'
  ],
  vault_supersede: ['record_id', 'etag', 'archive', 'new_path'],
  vault_move: ['record_id', '204'],
  vault_propose: ['candidates', 'distance', 'proposed_chunks', 'candidates_screened'],
  vault_raw_inbox: ['ready', 'drafts', 'title', 'updated'],
  vault_cleanup_lint: ['totalFixed', 'fixed', 'needsReview', 'durationMs'],
  vault_embed_pending: ['embedded', 'upToDate', 'chunksWritten', 'docVecsWritten'],
  vault_incremental_reindex: ['fromCommit', 'toCommit', 'changedFiles', 'fellBack'],
  vault_run_scans: ['duplicates', 'compaction', 'retention', 'upgrade'],
  vault_append: ['etag'],
  vault_replace: ['etag', 'replaced'],
  vault_patch_fm: ['changed', 'results'],
  vault_read_file: ['etag', 'composed', 'content'],
  vault_write_file: ['expected_etag', 'If-Match'],
  vault_update_piece: ['expected_etag', 'If-Match'],
  vault_lease_list: ['count', 'items', 'holder_kind', 'attestation', 'expires_at'],
  vault_lease_events: ['seq', 'event', 'detail', 'preempted', 'transferred'],
  vault_lease_claim: ['claimed_by_other', 'preempted', 'renewed', 'attestation'],
  vault_lease_release: ['force', 'released'],
  vault_lease_transfer: ['to_holder', 'lease'],
  vault_handoff_list: ['count', 'items', 'idempotency_key', 'claim_expires', 'notes', 'result'],
  vault_handoff_get: ['handoff_not_found', 'status', 'returned'],
  vault_handoff_events: ['seq', 'handoff_id', 'actor', 'claim_expired', 'resubmitted'],
  vault_handoff_create: ['idempotency_key', 'existing', 'handoff/', 'ref', 'from'],
  vault_handoff_claim: ['claimed_by_other', 'not_open', 'renewed', 'TTL'],
  vault_handoff_resolve: ['returned', 'archived_to', 'not_claimed', 'note'],
  vault_handoff_resubmit: ['not_returned', 'ref', 'same record'],
  vault_handoff_note: ['handoff_resolved', 'notes', 'author'],
  vault_handoff_put_artifact: ['artifact_too_large', 'format-patch', 'spool', 'sha256', 'bundle'],
  vault_handoff_get_artifact: [
    'bytes',
    'sha256',
    'include_content',
    'artifact_not_found',
    'am --3way'
  ]
};

test('every documented response field appears in its tool description', t => {
  const map = descriptions();
  for (const [name, fields] of Object.entries(REQUIRED_MENTIONS)) {
    const description = map.get(name);
    t.ok(description, `${name} is registered`);
    for (const field of fields) {
      t.ok(description.includes(field), `${name} documents \`${field}\``);
    }
  }
});

// Three list shapes coexist and are easy to confuse: the paginated envelope
// ({items, offset, limit, total}, limit capped at 100), the flat count+items
// queue slices, and the genuinely unpaginated reads. Reading the wrong one as
// the other is the under-count that truncated a coverage scan at 800/1513.
test('paginated readers warn about paging by items.length, not requested limit', t => {
  const map = descriptions();
  for (const name of ['vault_list_pieces', 'vault_backlinks']) {
    const d = map.get(name);
    t.ok(/page by items\.length/i.test(d), `${name} states the paging rule`);
    t.ok(d.includes('100'), `${name} states the server-side limit cap`);
  }
});

test('unpaginated readers say so, so a short result is not read as a first page', t => {
  const map = descriptions();
  const unpaginated = [
    'vault_queue_top',
    'vault_queue_by_section',
    'vault_queue_by_priority',
    'vault_queue_by_project',
    'vault_queue_ready',
    'vault_queue_blocked',
    'vault_queue_project_archive',
    'vault_list_folder',
    'vault_neighborhood',
    'vault_similar'
  ];
  for (const name of unpaginated) {
    t.ok(
      /unpaginated|not paginated|NOT paginated/i.test(map.get(name)),
      `${name} says unpaginated`
    );
  }
});

test('whole-document writers steer to the narrow ops', t => {
  const map = descriptions();
  for (const name of ['vault_write_file', 'vault_update_piece']) {
    const d = map.get(name);
    t.ok(d.includes('vault_patch_fm'), `${name} points at vault_patch_fm`);
    t.ok(d.includes('vault_append'), `${name} points at vault_append`);
  }
});
