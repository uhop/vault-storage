import {createHash} from 'node:crypto';

/** SHA-256 of the UTF-8 bytes of `text`, returned as lowercase hex. */
export const contentHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Embedding-input hash: covers body and any agent-derived prefix that the
 * chunker prepends. Same as `contentHash(body)` when no agent summary is
 * present (existing records stay on their current hashes after schema 5).
 * When a summary is present, the hash mixes it in with a literal separator
 * so summary-only changes invalidate the chunk set on the next embed pass.
 *
 * Stored as `records.content_hash` and mirrored into `record_vec.content_hash`
 * + `record_doc_vec.content_hash`, so the existing
 * "where vec.content_hash != records.content_hash → re-embed" check still
 * fires when the LLM updates the summary without touching the body.
 */
export const embedInputHash = (body: string, agentSummary: string | null): string => {
  const h = createHash('sha256');
  h.update(body, 'utf8');
  if (agentSummary && agentSummary.length > 0) {
    h.update('\0agent:', 'utf8');
    h.update(agentSummary, 'utf8');
  }
  return h.digest('hex');
};
