import {parentPort} from 'node:worker_threads';
import {brotliCompressSync, constants, gzipSync, zstdCompressSync} from 'node:zlib';
import type {Encoding} from './compress.ts';

export interface CodeRequest {
  id: number;
  encoding: Encoding;
  bytes: Uint8Array;
}

export type CodeReply =
  {id: number; ok: true; bytes: Uint8Array} | {id: number; ok: false; error: string};

/**
 * Levels chosen for the read path: one whose CPU exceeds the transfer it
 * saves is a regression. Brotli defaults to quality 11, seconds per
 * megabyte; 4 is the level meant for serving.
 */
const CODERS: Record<Encoding, (body: Buffer) => Buffer> = {
  zstd: body => zstdCompressSync(body, {params: {[constants.ZSTD_c_compressionLevel]: 3}}),
  br: body => brotliCompressSync(body, {params: {[constants.BROTLI_PARAM_QUALITY]: 4}}),
  gzip: body => gzipSync(body, {level: 5})
};

parentPort!.on('message', (request: CodeRequest) => {
  const {id, encoding, bytes} = request;
  try {
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // A copy: zlib answers from a shared pool, and only an owned buffer transfers.
    const out = new Uint8Array(CODERS[encoding](body));
    const reply: CodeReply = {id, ok: true, bytes: out};
    parentPort!.postMessage(reply, [out.buffer]);
  } catch (err) {
    const reply: CodeReply = {id, ok: false, error: (err as Error).message};
    parentPort!.postMessage(reply);
  }
});
