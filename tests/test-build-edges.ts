import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {buildEdges} from '../src/importer/build-edges.ts';
import {importVault} from '../src/importer/import.ts';
import {EdgesRepository} from '../src/records/edges.ts';
import {RecordsRepository} from '../src/records/repository.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

interface Fixture {
  root: string;
  db: DatabaseSync;
}

const setup = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'vault-edges-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db};
};

const teardown = ({root, db}: Fixture): void => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

test('end-to-end edge extraction from a synthetic vault', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'topics/alpha.md',
      [
        '---',
        'title: Alpha',
        'related:',
        '  - "[[topics/beta]]"',
        '  - "[[topics/gamma]]"',
        '---',
        'Alpha mentions [[topics/beta]] in the body too.',
        ''
      ].join('\n')
    );
    writeMd(
      fx.root,
      'topics/beta.md',
      ['---', 'title: Beta', '---', 'Beta references [[alpha]] by basename.', ''].join('\n')
    );
    writeMd(fx.root, 'topics/gamma.md', '---\ntitle: Gamma\n---\nNo links here.\n');

    importVault(fx.db, fx.root);

    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const alpha = records.getByPath('topics/alpha.md');
    const beta = records.getByPath('topics/beta.md');
    const gamma = records.getByPath('topics/gamma.md');

    await t.test('all three records present', t => {
      t.ok(alpha && beta && gamma, 'three records');
    });

    await t.test('alpha frontmatter related: created two related-to edges', t => {
      const out = edges.listOutbound(alpha!.recordId).filter(e => e.type === 'related-to');
      const targets = new Set(out.map(e => e.toId));
      t.equal(out.length, 2, 'two related-to edges');
      t.ok(targets.has(beta!.recordId), 'related-to → beta');
      t.ok(targets.has(gamma!.recordId), 'related-to → gamma');
    });

    await t.test("alpha body wikilink to beta produced a 'cites' edge", t => {
      const cites = edges
        .listOutbound(alpha!.recordId)
        .filter(e => e.type === 'cites' && e.toId === beta!.recordId);
      t.equal(cites.length, 1, 'one cites edge from alpha to beta');
    });

    await t.test("beta body wikilink resolved by basename to alpha ('cites')", t => {
      const cites = edges.listOutbound(beta!.recordId).filter(e => e.type === 'cites');
      t.equal(cites.length, 1, 'one outbound cites from beta');
      t.equal(cites[0]?.toId, alpha!.recordId, 'cites → alpha');
    });

    await t.test('gamma has no outbound edges', t => {
      t.equal(edges.listOutbound(gamma!.recordId).length, 0, 'gamma references nothing');
    });
  } finally {
    teardown(fx);
  }
});

test('buildEdges is idempotent — re-run is a no-op', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'topics/x.md',
      ['---', 'title: X', 'related:', '  - "[[topics/y]]"', '---', 'body', ''].join('\n')
    );
    writeMd(fx.root, 'topics/y.md', '---\ntitle: Y\n---\nbody\n');

    const first = importVault(fx.db, fx.root);
    t.equal(first.edges.edgesCreated, 1, 'one edge on initial import');

    const second = buildEdges(fx.db, {vaultRoot: fx.root});
    t.equal(second.edgesCreated, 1, 're-run reports the upsert (idempotent at DB level)');

    const edges = new EdgesRepository(fx.db);
    const records = new RecordsRepository(fx.db);
    const x = records.getByPath('topics/x.md');
    t.equal(edges.listOutbound(x!.recordId).length, 1, 'still exactly one edge');
  } finally {
    teardown(fx);
  }
});

test('unresolved targets and self-references are counted, not thrown', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'related:',
        '  - "[[does/not/exist]]"',
        '  - "[[topics/x]]"', // self-reference
        '---',
        'A body link to [[also/missing]] and a self [[topics/x]].',
        ''
      ].join('\n')
    );

    const summary = importVault(fx.db, fx.root);

    await t.test('frontmatter unresolved counted', t => {
      t.equal(summary.edges.unresolvedFrontmatter, 1, 'one missing frontmatter target');
    });
    await t.test('body unresolved counted', t => {
      t.equal(summary.edges.unresolvedBody, 1, 'one missing body wikilink');
    });
    await t.test('self-references counted', t => {
      t.ok(summary.edges.selfReferences >= 2, 'two self-references (frontmatter + body)');
    });
    await t.test('no edges created on a record that only had bad targets', t => {
      const records = new RecordsRepository(fx.db);
      const edges = new EdgesRepository(fx.db);
      const x = records.getByPath('topics/x.md');
      t.equal(edges.listOutbound(x!.recordId).length, 0, 'no real edges');
    });
  } finally {
    teardown(fx);
  }
});

test('edge types: related: → related-to, body links → cites', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'a.md', ['---', 'related:', '  - "[[b]]"', '---', '[[c]]', ''].join('\n'));
    writeMd(fx.root, 'b.md', '---\n---\nbody\n');
    writeMd(fx.root, 'c.md', '---\n---\nbody\n');

    importVault(fx.db, fx.root);

    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const a = records.getByPath('a.md');
    const out = edges.listOutbound(a!.recordId);

    const byType = new Map(out.map(e => [e.type, e]));
    t.ok(byType.has('related-to'), 'related-to edge present');
    t.ok(byType.has('cites'), 'cites edge present');
    t.equal(byType.size, 2, 'exactly those two types');
  } finally {
    teardown(fx);
  }
});
