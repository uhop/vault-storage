import type {ServerResponse} from 'node:http';
import {Worker} from 'node:worker_threads';
import type {CodeReply, CodeRequest} from './compress-worker.ts';

export type Encoding = 'zstd' | 'br' | 'gzip';

/** Below one TCP segment the framing costs more than the coding saves. */
const MIN_BYTES = 1400;

const WORKER_URL = new URL('./compress-worker.ts', import.meta.url);

interface Waiter {
  resolve: (out: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

interface Channel {
  worker: Worker;
  pending: Map<number, Waiter>;
}

/**
 * Bodies are coded on a worker thread, one message each way: `zlib`'s own
 * asynchronous coders take two turns of the event loop, and on a busy server
 * every turn waits behind the queued work (D102). A coding that fails or
 * outlasts the limit answers null, and the body goes out as it is.
 */
export class Coder {
  readonly #timeoutMs: number;
  #channel: Channel | null = null;
  #nextId = 0;

  constructor(timeoutMs = 10_000) {
    this.#timeoutMs = timeoutMs;
  }

  /** The worker's thread id while one runs. */
  get threadId(): number | null {
    return this.#channel?.worker.threadId ?? null;
  }

  code(encoding: Encoding, body: Buffer): Promise<Buffer | null> {
    const channel = (this.#channel ??= this.#spawn());
    const id = ++this.#nextId;
    // A copy: the body may sit in a shared pool, and only an owned buffer transfers.
    const bytes = new Uint8Array(body);
    const request: CodeRequest = {id, encoding, bytes};
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#fail(channel);
        void channel.worker.terminate();
      }, this.#timeoutMs);
      channel.pending.set(id, {resolve, timer});
      channel.worker.ref();
      channel.worker.postMessage(request, [bytes.buffer]);
    });
  }

  /** Stops the worker; pending codings answer null. */
  async terminate(): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    this.#fail(channel);
    await channel.worker.terminate();
  }

  #spawn(): Channel {
    const worker = new Worker(WORKER_URL);
    const channel: Channel = {worker, pending: new Map()};
    worker.on('message', (reply: CodeReply) => {
      const waiter = channel.pending.get(reply.id);
      if (!waiter) return;
      channel.pending.delete(reply.id);
      clearTimeout(waiter.timer);
      // An idle worker must not keep a CLI or test process alive.
      if (!channel.pending.size) worker.unref();
      waiter.resolve(
        reply.ok
          ? Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength)
          : null
      );
    });
    worker.on('error', () => this.#fail(channel));
    worker.on('exit', () => this.#fail(channel));
    worker.unref();
    return channel;
  }

  #fail(channel: Channel): void {
    if (this.#channel === channel) this.#channel = null;
    for (const waiter of channel.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    channel.pending.clear();
  }
}

export const coder = new Coder();

/** Our order among codings the client rates equally: fastest at a given ratio first. */
const PREFERENCE: readonly Encoding[] = ['zstd', 'br', 'gzip'];

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/;

export const isCompressible = (contentType: string): boolean => COMPRESSIBLE.test(contentType);

const CODING_SUFFIX = /-(?:zstd|br|gzip)$/;

/**
 * RFC 9110 § 8.8.3.3: a strong tag names one coding's bytes, so a coded body
 * carries its own (`"X-gzip"`, Apache's shape). A weak tag may be shared, and
 * `W/` already means a composed view to clients.
 */
const codedEtag = (etag: string, encoding: Encoding): string =>
  etag.startsWith('"') ? `${etag.slice(0, -1)}-${encoding}"` : etag;

/** The entity-tags of an `If-Match` or `If-None-Match` header, as sent. */
export const entityTags = (header: string): string[] =>
  header
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0);

/**
 * One tag's opaque value, with `W/`, the quotes, and any coding suffix off:
 * every coding of one representation compares equal. Bare unquoted values
 * are accepted for caller convenience.
 */
export const entityValue = (tag: string): string => {
  const strong = tag.startsWith('W/') ? tag.slice(2) : tag;
  const value =
    strong.length >= 2 && strong.startsWith('"') && strong.endsWith('"')
      ? strong.slice(1, -1)
      : strong;
  return value.replace(CODING_SUFFIX, '');
};

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
  if (encoding !== null) {
    head['Content-Encoding'] = encoding;
    if (head['ETag'] !== undefined) head['ETag'] = codedEtag(head['ETag'], encoding);
  }
  res.writeHead(status, head);
  res.end(body);
};

/**
 * Write a fully buffered body, coded when the client asked for it and it
 * pays. A coded body is written when the worker answers, so callers must
 * treat the response as finished and write nothing more; every caller
 * already does.
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
  void coder.code(encoding, body).then(out => {
    const worthIt = out !== null && out.byteLength < body.byteLength;
    writeOut(res, status, varied, worthIt ? out : body, worthIt ? encoding : null);
  });
};
