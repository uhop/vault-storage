// Experiment runner: import a vault under a *different* embedding model and
// dimension than the project's locked default, so we can compare baseline
// numbers without touching the schema migration. Builds a fresh DB at --db
// with `record_vec USING vec0(... embedding FLOAT[<dim>])` substituted in,
// imports the vault, runs edge extraction, and embeds with the requested
// BGE variant. After this, run `eval/embedding-quality.ts --db <db> --vault <vault>`
// to see the metrics.
//
//   node eval/try-model.ts --model Xenova/bge-base-en-v1.5 --dim 768 \
//                          --vault /path/to/vault-data \
//                          --db /tmp/vault-bge-base.sqlite

import {readFileSync, mkdirSync, rmSync, existsSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../src/db/connection.ts';
import {BgeEmbedder} from '../src/embeddings/bge.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {importVault} from '../src/importer/import.ts';

interface CliArgs {
  model: string;
  dim: number;
  vault: string;
  db: string;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {model: '', dim: 0, vault: '', db: ''};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') args.model = argv[++i] ?? '';
    else if (a === '--dim') args.dim = Number.parseInt(argv[++i] ?? '0', 10);
    else if (a === '--vault') args.vault = argv[++i] ?? '';
    else if (a === '--db') args.db = argv[++i] ?? '';
  }
  if (!args.model || !args.dim || !args.vault || !args.db) {
    process.stderr.write('usage: try-model.ts --model <hf-path> --dim <n> --vault <root> --db <out.sqlite>\n');
    process.exit(2);
  }
  return args;
};

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'schema');

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db);
mkdirSync(dirname(dbPath), {recursive: true});
if (existsSync(dbPath)) rmSync(dbPath);
const db = openDatabase({path: dbPath});

// Bootstrap the meta table the migration runner expects.
db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO meta (key, value) VALUES ('schema_version', '0');`);

// Apply 0001_init.sql with the embedding dim substituted. The schema currently
// has exactly one occurrence of FLOAT[384] (the record_vec virtual table).
const schemaSql = readFileSync(join(SCHEMA_DIR, '0001_init.sql'), 'utf8');
const patched = schemaSql.replace(/FLOAT\[\d+\]/g, `FLOAT[${args.dim}]`);
if (patched === schemaSql) {
  process.stderr.write('schema substitution failed: no FLOAT[<n>] match\n');
  process.exit(1);
}
db.exec(patched);

const t0 = performance.now();
const summary = importVault(db, resolve(args.vault));
const tImport = Math.round(performance.now() - t0);
process.stdout.write(
  `imported ${summary.total} files: ${summary.inserted} inserted, ${summary.skipped} skipped ` +
  `(${tImport} ms)\nedges: ${summary.edges.edgesCreated} created (${summary.edges.durationMs} ms)\n`
);

const embedder = new BgeEmbedder({modelName: args.model, dim: args.dim});
const t1 = performance.now();
const embed = await embedPending(db, embedder);
const tEmbed = Math.round(performance.now() - t1);
process.stdout.write(
  `embed: ${embed.embedded} embedded with ${args.model} (dim=${args.dim}, ${tEmbed} ms)\n`
);
process.stdout.write(`db ready: ${dbPath}\n`);

db.close();
