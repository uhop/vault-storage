import {Worker} from 'node:worker_threads';
import {contentHash} from '../util/hash.ts';
import type {PathEntry, Rendered} from './render.ts';
import type {RenderReply, RenderRequest} from './render-worker.ts';

/** The wikilink path set a render resolves against; `version` changes only when the set does. */
export interface PathSet {
  version: number;
  entries: readonly PathEntry[];
}

export class RenderTimeoutError extends Error {
  constructor(ms: number) {
    super(`markdown render exceeded ${ms} ms; the worker was replaced`);
    this.name = 'RenderTimeoutError';
  }
}

interface Waiter {
  resolve: (rendered: Rendered) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Channel {
  worker: Worker;
  pending: Map<number, Waiter>;
  version: number | null;
}

interface CacheEntry {
  promise: Promise<Rendered>;
  bytes: number;
}

export interface RendererOptions {
  timeoutMs?: number;
  maxCacheBytes?: number;
}

const WORKER_URL = new URL('./render-worker.ts', import.meta.url);

/**
 * Markdown → HTML on a worker thread, so a large note never blocks the event
 * loop (a 950 KB note parses in ~75 ms on nuke, and `marked` is regex-driven,
 * so a pathological input could hold the thread far longer). Results are
 * cached by body, start line, and path-set version: a note renders once per
 * content, and again only when a create, delete, or move changes what its
 * wikilinks resolve to. A render past the time limit replaces the worker.
 */
export class MarkdownRenderer {
  readonly #timeoutMs: number;
  readonly #maxCacheBytes: number;
  readonly #cache = new Map<string, CacheEntry>();
  #cacheBytes = 0;
  #channel: Channel | null = null;
  #nextId = 0;
  /** Renders sent to the worker, cache hits excluded. */
  workerRenders = 0;

  constructor(options: RendererOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxCacheBytes = options.maxCacheBytes ?? 32 * 1024 * 1024;
  }

  /** The worker's thread id while one runs. */
  get threadId(): number | null {
    return this.#channel?.worker.threadId ?? null;
  }

  render(body: string, firstLine: number, paths: PathSet): Promise<Rendered> {
    const key = `${contentHash(body)}\t${firstLine}\t${paths.version}`;
    const hit = this.#cache.get(key);
    if (hit) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit.promise;
    }
    const entry: CacheEntry = {promise: this.#send(body, firstLine, paths), bytes: 0};
    this.#cache.set(key, entry);
    entry.promise.then(
      rendered => {
        if (this.#cache.get(key) !== entry) return;
        entry.bytes = (rendered.html.length + body.length) * 2;
        this.#cacheBytes += entry.bytes;
        this.#evict();
      },
      () => {
        if (this.#cache.get(key) === entry) this.#cache.delete(key);
      }
    );
    return entry.promise;
  }

  /** Stops the worker; pending renders reject. */
  async terminate(): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    this.#fail(channel, new Error('markdown renderer terminated'));
    await channel.worker.terminate();
  }

  #evict(): void {
    for (const [key, entry] of this.#cache) {
      if (this.#cacheBytes <= this.#maxCacheBytes) return;
      if (entry.bytes === 0) continue;
      this.#cache.delete(key);
      this.#cacheBytes -= entry.bytes;
    }
  }

  #send(body: string, firstLine: number, paths: PathSet): Promise<Rendered> {
    const channel = (this.#channel ??= this.#spawn());
    const id = ++this.#nextId;
    const request: RenderRequest = {id, body, firstLine};
    if (channel.version !== paths.version) {
      request.paths = paths.entries;
      channel.version = paths.version;
    }
    ++this.workerRenders;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(channel, new RenderTimeoutError(this.#timeoutMs));
        void channel.worker.terminate();
      }, this.#timeoutMs);
      channel.pending.set(id, {resolve, reject, timer});
      channel.worker.ref();
      channel.worker.postMessage(request);
    });
  }

  #spawn(): Channel {
    const worker = new Worker(WORKER_URL);
    const channel: Channel = {worker, pending: new Map(), version: null};
    worker.on('message', (reply: RenderReply) => {
      const waiter = channel.pending.get(reply.id);
      if (!waiter) return;
      channel.pending.delete(reply.id);
      clearTimeout(waiter.timer);
      // An idle worker must not keep a CLI or test process alive.
      if (!channel.pending.size) worker.unref();
      if (reply.ok) waiter.resolve({html: reply.html, sections: reply.sections});
      else waiter.reject(new Error(reply.error));
    });
    worker.on('error', err =>
      this.#fail(channel, err instanceof Error ? err : new Error(String(err)))
    );
    worker.on('exit', code =>
      this.#fail(channel, new Error(`render worker exited (code ${code})`))
    );
    worker.unref();
    return channel;
  }

  #fail(channel: Channel, err: Error): void {
    if (this.#channel === channel) this.#channel = null;
    for (const waiter of channel.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    channel.pending.clear();
  }
}
