import type {ServerResponse} from 'node:http';
import {brotliCompress, constants, gzip, zstdCompress} from 'node:zlib';

type Encoding = 'zstd' | 'br' | 'gzip';
type Compressor = (body: Buffer, cb: (err: Error | null, out: Buffer) => void) => void;

/** Below one TCP segment the framing costs more than the coding saves. */
const MIN_BYTES = 1400;

/**
 * Levels chosen for the read path: one whose CPU exceeds the transfer it
 * saves is a regression. Brotli defaults to quality 11, seconds per
 * megabyte; 4 is the level meant for serving.
 */
const COMPRESSORS: Record<Encoding, Compressor> = {
  zstd: (body, cb) => zstdCompress(body, {params: {[constants.ZSTD_c_compressionLevel]: 3}}, cb),
  br: (body, cb) => brotliCompress(body, {params: {[constants.BROTLI_PARAM_QUALITY]: 4}}, cb),
  gzip: (body, cb) => gzip(body, {level: 5}, cb)
};

/** Our order among codings the client rates equally: fastest at a given ratio first. */
const PREFERENCE: readonly Encoding[] = ['zstd', 'br', 'gzip'];

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/;

export const isCompressible = (contentType: string): boolean => COMPRESSIBLE.test(contentType);

/** `gzip, br;q=0.5, *;q=0.1` → the weight each coding carries, `*` included. */
const weights = (header: string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map(p => p.trim().toLowerCase()).find(p => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number.parseFloat(q.slice(2));
    out.set(name.trim().toLowerCase(), Number.isFinite(weight) ? weight : 0);
  }
  return out;
};

/**
 * The best coding the client accepts, or null for identity. A coding the
 * client never names inherits the weight of `*`, and `q=0` is a refusal,
 * so `identity` and an absent header both land on null.
 */
export const negotiateEncoding = (header: string | string[] | undefined): Encoding | null => {
  if (typeof header !== 'string') return null;
  const accepted = weights(header);
  const wildcard = accepted.get('*') ?? 0;
  let best: Encoding | null = null;
  let bestWeight = 0;
  for (const encoding of PREFERENCE) {
    const weight = accepted.get(encoding) ?? wildcard;
    if (weight > bestWeight) {
      best = encoding;
      bestWeight = weight;
    }
  }
  return best;
};

const writeOut = (
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  encoding: Encoding | null
): void => {
  // The client can vanish while a compressor runs; writing then throws.
  if (res.writableEnded || res.destroyed) return;
  const head: Record<string, string> = {
    ...headers,
    'Content-Length': body.byteLength.toString()
  };
  if (encoding !== null) head['Content-Encoding'] = encoding;
  res.writeHead(status, head);
  res.end(body);
};

/**
 * Write a fully buffered body, coded when the client asked for it and it
 * pays. Compression completes on a later tick, so callers must treat the
 * response as finished and write nothing more; every caller already does.
 *
 * `Vary` rides on every compressible response whether or not this one was
 * coded, so a cache keys the variants apart.
 */
export const sendBuffer = (
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Record<string, string>
): void => {
  if (!isCompressible(headers['Content-Type'] ?? '')) {
    writeOut(res, status, headers, body, null);
    return;
  }
  const varied = {...headers, Vary: 'Accept-Encoding'};
  const encoding =
    body.byteLength < MIN_BYTES ? null : negotiateEncoding(res.req.headers['accept-encoding']);
  if (encoding === null) {
    writeOut(res, status, varied, body, null);
    return;
  }
  COMPRESSORS[encoding](body, (err, out) => {
    const worthIt = err === null && out.byteLength < body.byteLength;
    writeOut(res, status, varied, worthIt ? out : body, worthIt ? encoding : null);
  });
};
