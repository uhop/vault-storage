import type {IncomingMessage} from 'node:http';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Buffer the request body up to `maxBytes`. Throws if the limit is exceeded. */
export const readBodyText = async (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<string> => {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};
