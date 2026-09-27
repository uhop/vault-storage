import type {DatabaseSync} from 'node:sqlite';
import {diffBaseline, EnrichmentBaselineRepository} from '../../db/enrichment-baseline-repo.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface EnrichmentDeltaDeps {
  db: DatabaseSync;
  records: RecordsRepository;
}

/**
 * GET /sections/{id}/enrichment-delta
 * What changed in a record's body since its `agent:` block was last current:
 * the chunks added since (with text) and the count and bytes of those removed.
 * `baseline: null` means no baseline exists, so a refresh reads the whole body.
 * The caller picks the threshold past which the delta is not enough.
 */
export const enrichmentDeltaHandler =
  (deps: EnrichmentDeltaDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set())) return;
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }
    const record = deps.records.getById(id);
    if (!record) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }

    const head = {
      record_id: id,
      file_path: record.filePath,
      body_hash: record.bodyHash,
      body_bytes: Buffer.byteLength(record.body, 'utf8'),
      agent_current: record.agentSummary !== null && record.agentDerivedFromHash === record.bodyHash
    };
    const baseline = new EnrichmentBaselineRepository(deps.db).get(id);
    if (!baseline) {
      sendJson(ctx.res, 200, {...head, baseline: null});
      return;
    }

    const delta = diffBaseline(baseline.chunks, record.body);
    sendJson(ctx.res, 200, {
      ...head,
      baseline: {
        body_hash: baseline.bodyHash,
        body_bytes: baseline.bodyBytes,
        at: baseline.created
      },
      chunks: {total: delta.total, added: delta.added.length, removed: delta.removed},
      added_bytes: delta.addedBytes,
      removed_bytes: delta.removedBytes,
      changed_fraction: Number(delta.changedFraction.toFixed(4)),
      added_chunks: delta.added
    });
  };
