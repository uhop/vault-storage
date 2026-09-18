import {parentPort} from 'node:worker_threads';
import {
  linkResolver,
  renderMarkdown,
  type PathEntry,
  type Rendered,
  type ResolveLink
} from './render.ts';

export interface RenderRequest {
  id: number;
  body: string;
  firstLine: number;
  /** Sent only when the path set changed since this worker last saw it. */
  paths?: readonly PathEntry[];
}

export type RenderReply =
  ({id: number; ok: true} & Rendered) | {id: number; ok: false; error: string};

let resolve: ResolveLink = () => null;

parentPort!.on('message', (request: RenderRequest) => {
  let reply: RenderReply;
  try {
    if (request.paths) resolve = linkResolver(request.paths);
    reply = {id: request.id, ok: true, ...renderMarkdown(request.body, request.firstLine, resolve)};
  } catch (err) {
    reply = {id: request.id, ok: false, error: (err as Error).message};
  }
  parentPort!.postMessage(reply);
});
