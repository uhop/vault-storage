import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {gcTags} from '../src/maintenance/gc-tags.ts';

const NOW = '2026-09-28T12:00:00.000Z';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-tags-test-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  writeFileSync(
    join(root, 'topics/used.md'),
    ['---', 'title: Used', 'tags: [in-use]', '---', 'Body.', ''].join('\n')
  );
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  db.exec(`
    INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES
      ('in-use', 'Carried by a note.', '2026-05-01', 'minted'),
      ('030', NULL, '2026-04-29', 'seeded'),
      ('stale-mint', 'Its note expired.', '2026-06-01T00:00:00.000Z', 'minted'),
      ('on-purpose', 'Waiting for notes.', '2026-06-01', 'manual'),
      ('just-minted', NULL, '2026-09-28T11:00:00.000Z', 'minted');
    INSERT INTO tag_aliases (alias, canonical) VALUES ('0.3.0', '030');
  `);
  importVault(db, root);
  db.prepare(
    `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
     VALUES ('s1', 'tag_suggestion', NULL, '{"tag": "stale-mint"}', 'pending', ?)`
  ).run(NOW);
  return {root, db};
};

const teardown = ({root, db}: ReturnType<typeof setup>) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

const taxonomy = (db: ReturnType<typeof openDatabase>): string[] =>
  (db.prepare('SELECT tag FROM tags_taxonomy ORDER BY tag').all() as {tag: string}[]).map(
    r => r.tag
  );

test('gcTags dry run names the empty automatic tags past the grace window and changes nothing', t => {
  const fx = setup();
  try {
    const summary = gcTags(fx.db, {dryRun: true, now: NOW});
    t.deepEqual(
      summary.tags.map(e => e.tag),
      ['030', 'stale-mint'],
      'empty seeded and minted tags, A to Z'
    );
    t.deepEqual(summary.tags[0]?.aliases, ['0.3.0'], 'aliases listed');
    t.deepEqual(
      summary.young.map(e => e.tag),
      ['just-minted'],
      'a tag inside the grace window is kept'
    );
    t.equal(summary.manual, 1, 'the empty manual tag is kept');
    t.equal(summary.deleted, 0, 'nothing deleted');
    t.deepEqual(
      taxonomy(fx.db),
      ['030', 'in-use', 'just-minted', 'on-purpose', 'stale-mint'],
      'taxonomy unchanged'
    );
  } finally {
    teardown(fx);
  }
});

test('gcTags deletes them with their aliases and rejects the suggestions proposing them', t => {
  const fx = setup();
  try {
    const summary = gcTags(fx.db, {now: NOW});
    t.equal(summary.deleted, 2, 'two deleted');
    t.equal(summary.suggestionsRejected, 1, 'one suggestion rejected');
    t.deepEqual(taxonomy(fx.db), ['in-use', 'just-minted', 'on-purpose'], 'the rest stay');
    t.equal(
      (fx.db.prepare('SELECT COUNT(*) AS n FROM tag_aliases').get() as {n: number}).n,
      0,
      'the alias went with its tag'
    );
    t.deepEqual(
      {
        ...(fx.db
          .prepare("SELECT status, resolved_by FROM suggestions WHERE id = 's1'")
          .get() as object)
      },
      {status: 'rejected', resolved_by: 'tag-deleted'},
      'the proposing suggestion is rejected as tag-deleted'
    );
    t.equal(gcTags(fx.db, {now: NOW}).deleted, 0, 'a second pass finds nothing');
  } finally {
    teardown(fx);
  }
});
