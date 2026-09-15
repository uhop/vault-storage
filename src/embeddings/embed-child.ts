import type {EmbedChildConfig, EmbedChildReply, EmbedChildRequest} from './child-embedder.ts';
import type {Embedder} from './types.ts';

const send = process.send?.bind(process);
if (!send) throw new Error('embed-child.ts runs only as a forked child (see ChildProcessEmbedder)');

const config = JSON.parse(process.argv[2] ?? '{}') as EmbedChildConfig;

const post = (reply: EmbedChildReply): void => {
  send(reply);
};

const busyWait = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

const makeEmbedder = async (): Promise<Embedder> => {
  if (config.kind === 'bge') {
    const [{BgeEmbedder}, {JsonlAnomalyLogger}] = await Promise.all([
      import('./bge.ts'),
      import('./anomaly-log.ts')
    ]);
    return new BgeEmbedder({
      ...(config.modelName ? {modelName: config.modelName} : {}),
      ...(config.maxBatch ? {maxBatch: config.maxBatch} : {}),
      ...(config.retentionMs ? {retentionMs: config.retentionMs} : {}),
      anomalyLogger: config.anomalyLogPath ? new JsonlAnomalyLogger(config.anomalyLogPath) : null,
      onRetainedChange: value => post({op: 'retained', value})
    });
  }
  const {FakeEmbedder} = await import('./fake.ts');
  const fake = new FakeEmbedder(config.dim ? {dim: config.dim} : {});
  const blockMs = config.blockMs ?? 0;
  return {
    dim: fake.dim,
    modelName: fake.modelName,
    retained: false,
    embed: async text => {
      busyWait(blockMs);
      return fake.embed(text);
    },
    embedBatch: async texts => {
      busyWait(blockMs);
      return fake.embedBatch(texts);
    },
    embedQuery: async text => {
      busyWait(blockMs);
      return fake.embedQuery(text);
    },
    releaseRetained: () => fake.releaseRetained()
  };
};

const ready = makeEmbedder();

process.on('message', async (request: EmbedChildRequest) => {
  try {
    const embedder = await ready;
    if (request.op === 'embedBatch') {
      post({id: request.id, ok: true, vectors: await embedder.embedBatch(request.texts)});
      return;
    }
    await embedder.releaseRetained();
    post({id: request.id, ok: true, vectors: []});
  } catch (err) {
    post({id: request.id, ok: false, error: err instanceof Error ? err.message : String(err)});
  }
});

// The parent owns this process: exit with it instead of lingering as an orphan.
process.on('disconnect', () => process.exit(0));
