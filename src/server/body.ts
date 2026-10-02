import type {IncomingMessage} from 'node:http';
import {sendError} from './responses.ts';
import type {RequestContext} from './router.ts';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const bodies = new WeakMap<IncomingMessage, Buffer>();

/** The body a handler read, for checks that run after it (the stream is gone by then). */
export const bodyRead = (req: IncomingMessage): Buffer | undefined => bodies.get(req);

/**
 * Buffer the request body up to `maxBytes`. Throws if the limit is exceeded —
 * the check runs per chunk, so an oversized upload is refused mid-stream
 * rather than after it has all been held in memory. A body already read (the
 * strict-field check reads it before the handler) is returned as it was.
 */
export const readBodyBuffer = async (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<Buffer> => {
  const read = bodies.get(req);
  if (read !== undefined) return read;
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  bodies.set(req, body);
  return body;
};

/** Buffer the request body up to `maxBytes`. Throws if the limit is exceeded. */
export const readBodyText = async (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<string> => (await readBodyBuffer(req, maxBytes)).toString('utf8');

/**
 * The request body as a JSON object, or null after answering 413 (too large)
 * or 400 (not JSON, or not an object).
 */
export const readJsonBody = async (
  ctx: RequestContext
): Promise<{body: Record<string, unknown>} | null> => {
  let raw: string;
  try {
    raw = await readBodyText(ctx.req);
  } catch (err) {
    sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
      return null;
    }
    return {body: parsed as Record<string, unknown>};
  } catch (err) {
    sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
    return null;
  }
};
