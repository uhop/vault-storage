import test from 'tape-six';
import {readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {migrateVault} from '../src/migration/import.ts';
import {importVault} from '../src/importer/import.ts';
import {RecordsRepository} from '../src/records/repository.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {source: string; target: string; cleanup: () => void} => {
  const source = mkdtempSync(join(tmpdir(), 'vault-migration-source-'));
  const target = mkdtempSync(join(tmpdir(), 'vault-migration-target-'));
  return {
    source,
    target,
    cleanup: () => {
      rmSync(source, {recursive: true, force: true});
      rmSync(target, {recursive: true, force: true});
    }
  };
};

test('migrateVault writes target tree with normalized frontmatter', t => {
  const {source, target, cleanup} = setupVault();
  try {
    writeMd(
      source,
      'topics/alpha.md',
      [
        '---',
        'title: Alpha',
        'tags: [Gotchas, AWS, gotcha]',
        'status: shipped',
        '---',
        'Alpha body.',
        ''
      ].join('\n')
    );
    writeMd(
      source,
      'projects/demo/decisions.md',
      [
        '---',
        'title: Demo decisions',
        'tags: [design]',
        'type: decision',
        'status: in-progress',
        '---',
        'Decision content.',
        ''
      ].join('\n')
    );
    writeMd(source, 'raw/no-frontmatter.md', '# A heading\n\nbody only, no frontmatter.\n');

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);

    const summary = migrateVault({source, target, db, isoDate: '2026-04-29'});

    t.equal(summary.total, 3, 'three files migrated');
    t.equal(summary.backfilled, 1, 'raw/ file got bootstrapped frontmatter');
    t.ok(summary.canonicalTagCount >= 2, 'at least gotcha and aws survive');

    // Tags collapsed: Gotchas + gotcha → gotcha
    const alpha = readFileSync(join(target, 'topics/alpha.md'), 'utf8');
    const alphaFm = parseFrontmatter(alpha).data;
    t.deepEqual(alphaFm['tags'], ['gotcha', 'aws'], 'alpha tags canonicalized + deduped');
    t.equal(alphaFm['status'], 'done', 'shipped → done remap applied');

    // Type remap: decision → design.
    const demo = readFileSync(join(target, 'projects/demo/decisions.md'), 'utf8');
    const demoFm = parseFrontmatter(demo).data;
    t.equal(demoFm['type'], 'design', 'decision → design');
    t.equal(demoFm['status'], 'active', 'in-progress → active');

    // Backfill: raw note got created/updated/title/type=fleeting frontmatter.
    const raw = readFileSync(join(target, 'raw/no-frontmatter.md'), 'utf8');
    const rawFm = parseFrontmatter(raw).data;
    t.equal(rawFm['title'], 'A heading', 'title from H1');
    t.equal(rawFm['type'], 'fleeting', 'raw → fleeting');
    t.equal(rawFm['status'], 'active', 'default status active');
    t.equal(rawFm['created'], '2026-04-29', 'created stamped');

    db.close();
  } finally {
    cleanup();
  }
});

test('migrateVault seeds tags_taxonomy and tag_aliases', t => {
  const {source, target, cleanup} = setupVault();
  try {
    writeMd(
      source,
      'topics/x.md',
      ['---', 'title: X', 'tags: [logs, log, gotchas]', '---', 'body', ''].join('\n')
    );

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);

    migrateVault({source, target, db, isoDate: '2026-04-29'});

    const taxonomy = (
      db.prepare('SELECT tag FROM tags_taxonomy ORDER BY tag').all() as Array<{tag: string}>
    ).map(r => r.tag);
    t.ok(taxonomy.includes('log'), 'log canonical seeded');
    t.ok(!taxonomy.includes('logs'), 'logs not in canonical (collapsed)');
    t.ok(taxonomy.includes('gotchas'), 'gotchas alone is canonical (no gotcha partner here)');

    const aliases = db.prepare('SELECT alias, canonical FROM tag_aliases').all() as Array<{
      alias: string;
      canonical: string;
    }>;
    t.ok(
      aliases.some(a => a.alias === 'logs' && a.canonical === 'log'),
      'alias logs → log seeded'
    );
    db.close();
  } finally {
    cleanup();
  }
});

test('migrated tree round-trips through importVault', t => {
  const {source, target, cleanup} = setupVault();
  try {
    writeMd(
      source,
      'topics/alpha.md',
      ['---', 'title: Alpha', 'status: shipped', '---', 'Alpha body.', ''].join('\n')
    );
    writeMd(
      source,
      'projects/demo/decisions.md',
      ['---', 'title: Demo', 'type: decision', '---', 'body.', ''].join('\n')
    );

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);

    migrateVault({source, target, db, isoDate: '2026-04-29'});
    const importSummary = importVault(db, target);

    t.equal(importSummary.total, 2, 'two files imported from migrated tree');
    t.equal(importSummary.skipped, 0, 'no files skipped');

    const records = new RecordsRepository(db);
    const alpha = records.getByPath('topics/alpha.md');
    const demo = records.getByPath('projects/demo/decisions.md');
    t.equal(alpha?.status, 'done', 'imported with remapped status');
    t.equal(demo?.type, 'design', 'imported with remapped type');
    db.close();
  } finally {
    cleanup();
  }
});
