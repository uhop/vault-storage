import {fork, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BGE_DIM, BGE_MODEL, BGE_QUERY_INSTRUCTION} from './model.ts';
import type {Embedder} from './types.ts';

export type EmbedChildConfig =
  | {
      kind: 'bge';
      modelName?: string;
      maxBatch?: number;
      retentionMs?: number;
      anomalyLogPath?: string | null;
    }
  | {
      kind: 'fake';
      dim?: number;
      /** Busy-waits this long per call inside the child: a stand-in for synchronous inference in tests. */
      blockMs?: number;
    };

export type EmbedChildRequest =
  {id: number; op: 'embedBatch'; texts: string[]} | {id: number; op: 'release'};

export type EmbedChildReply =
  | {id: number; ok: true; vectors: Float32Array[]}
  | {id: number; ok: false; error: string}
  | {op: 'retained'; value: boolean};

interface Channel {
  child: ChildProcess;
  pending: Map<number, {resolve: (vectors: Float32Array[]) => void; reject: (err: Error) => void}>;
}

const CHILD_PATH = fileURLToPath(new URL('./embed-child.ts', import.meta.url));

/**
 * An {@link Embedder} whose model runs in a child process. onnxruntime-node
 * runs inference synchronously on the calling thread, so in-process every model
 * call blocked the server's event loop (D44). A worker thread cannot host it
 * instead: the native binding loads once per process, so a second thread, or a
 * restarted worker, fails with "Module did not self-register". The child starts
 * on first use; if it exits, pending calls reject and the next call starts a
 * fresh one.
 */
export class ChildProcessEmbedder implements Embedder {
  readonly dim: number;
  readonly modelName: string;
  readonly #config: EmbedChildConfig;
  #channel: Channel | null = null;
  #nextId = 0;
  #retained = false;

  constructor(config: EmbedChildConfig) {
    this.#config = config;
    this.dim = config.kind === 'fake' ? (config.dim ?? BGE_DIM) : BGE_DIM;
    this.modelName =
      config.kind === 'fake' ? `fake-deterministic-${this.dim}` : (config.modelName ?? BGE_MODEL);
  }

  get retained(): boolean {
    return this.#retained;
  }

  /** The child's process id while one runs. */
  get pid(): number | null {
    return this.#channel?.child.pid ?? null;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector!;
  }

  embedQuery(text: string): Promise<Float32Array> {
    return this.embed(this.#config.kind === 'bge' ? BGE_QUERY_INSTRUCTION + text : text);
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    return this.#send(id => ({id, op: 'embedBatch', texts}));
  }

  async releaseRetained(): Promise<void> {
    if (!this.#channel) return;
    await this.#send(id => ({id, op: 'release'}));
  }

  /** Stops the child process; pending calls reject. */
  async terminate(): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    this.#channel = null;
    this.#retained = false;
    if (channel.child.exitCode !== null || channel.child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => channel.child.once('exit', () => resolve()));
    // An unreferenced child would let the process exit before this promise settles.
    this.#hold(channel, true);
    channel.child.kill();
    await exited;
  }

  #send(request: (id: number) => EmbedChildRequest): Promise<Float32Array[]> {
    const channel = (this.#channel ??= this.#spawn());
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      channel.pending.set(id, {resolve, reject});
      this.#hold(channel, true);
      channel.child.send(request(id), err => {
        if (!err || !channel.pending.delete(id)) return;
        reject(err);
      });
    });
  }

  // An idle child must not keep a CLI or test process alive.
  #hold(channel: Channel, busy: boolean): void {
    if (busy) {
      channel.child.ref();
      channel.child.channel?.ref();
    } else {
      channel.child.unref();
      channel.child.channel?.unref();
    }
  }

  #spawn(): Channel {
    const child = fork(CHILD_PATH, [JSON.stringify(this.#config)], {serialization: 'advanced'});
    const channel: Channel = {child, pending: new Map()};
    child.on('message', (reply: EmbedChildReply) => {
      if ('op' in reply) {
        if (this.#channel === channel) this.#retained = reply.value;
        return;
      }
      const waiter = channel.pending.get(reply.id);
      if (!waiter) return;
      channel.pending.delete(reply.id);
      if (!channel.pending.size) this.#hold(channel, false);
      if (reply.ok) waiter.resolve(reply.vectors);
      else waiter.reject(new Error(reply.error));
    });
    const fail = (err: Error): void => {
      if (this.#channel === channel) {
        this.#channel = null;
        this.#retained = false;
      }
      for (const waiter of channel.pending.values()) waiter.reject(err);
      channel.pending.clear();
    };
    child.on('error', fail);
    child.on('exit', (code, signal) =>
      fail(new Error(`embed child exited (${signal ?? `code ${code}`})`))
    );
    this.#hold(channel, false);
    return channel;
  }
}
