import test from 'tape-six';
import {execSync} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {SuggestionFiler} from '../src/importer/file-suggestions.ts';
import {importFile} from '../src/importer/import-file.ts';
import {fullImportOptions} from '../src/importer/import-options.ts';
import {importVault} from '../src/importer/import.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import {startGitSync} from '../src/server/git-sync.ts';
import {
  dropSeededIds,
  exportVaultState,
  seedVaultState,
  STATE_DIR,
  stateFiles
} from '../src/vault-state.ts';

const setup = () => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  db.exec(`
    INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES
      ('beta', NULL, '2026-04-29', 'seeded'),
      ('alpha', 'Notes about alpha.', '2026-09-30T00:00:00Z', 'manual');
    INSERT INTO tag_aliases (alias, canonical) VALUES ('alfa', 'alpha'), ('a', 'alpha');
    INSERT INTO records (record_id, file_path, type, body, content_hash, body_hash, created, updated)
      VALUES ('id-b', 'topics/b.md', 'permanent', 'b', 'h', 'h', '2026-09-30', '2026-09-30'),
             ('id-a', 'topics/a.md', 'permanent', 'a', 'h', 'h', '2026-09-30', '2026-09-30');
  `);
  return db;
};

test('stateFiles: the taxonomy with its aliases, and the record ids, each sorted', t => {
  const db = setup();
  try {
    const files = stateFiles(db);
    t.deepEqual(
      files
        .get('tags.jsonl')!
        .trimEnd()
        .split('\n')
        .map(l => JSON.parse(l)),
      [
        {
          tag: 'alpha',
          description: 'Notes about alpha.',
          added: '2026-09-30T00:00:00Z',
          origin: 'manual',
          aliases: ['a', 'alfa']
        },
        {tag: 'beta', description: null, added: '2026-04-29', origin: 'seeded', aliases: []}
      ]
    );
    t.equal(
      files.get('records.jsonl'),
      '{"path":"topics/a.md","id":"id-a"}\n{"path":"topics/b.md","id":"id-b"}\n'
    );
    t.equal(files.get('suggestions.jsonl'), '', 'no decisions, an empty file');
  } finally {
    db.close();
  }
});

test('stateFiles: the latest decision per identity that a rebuild would ask again', t => {
  const db = setup();
  const now = '2026-10-01T00:00:00.000Z';
  let n = 0;
  const decide = (
    kind: string,
    payload: Record<string, unknown>,
    status: string,
    resolvedAt: string | null,
    subject: string | null = null
  ): void => {
    db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, '2026-09-01', ?, ?)`
    ).run(
      `s${String(++n).padStart(2, '0')}`,
      kind,
      subject,
      JSON.stringify(payload),
      status,
      resolvedAt,
      resolvedAt && 'agent'
    );
  };
  try {
    db.exec(`
      INSERT INTO records (record_id, file_path, type, body, content_hash, body_hash, created, updated)
        VALUES ('id-c', 'topics/c.md', 'permanent', 'c', 'h', 'h', '2026-09-30', '2026-09-30');
      INSERT INTO tags (record_id, tag) VALUES ('id-a', 'alpha');
    `);
    const pair = (a: string, b: string) => ({a_record: a, b_record: b, distance: 0.05});
    decide('duplicate', pair('id-b', 'id-a'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('duplicate', pair('id-a', 'id-gone'), 'accepted', '2026-09-20T00:00:00.000Z');
    decide('duplicate', pair('id-a', 'id-c'), 'rejected', '2026-09-10T00:00:00.000Z');
    decide('duplicate', pair('id-c', 'id-a'), 'accepted', '2026-09-21T00:00:00.000Z');
    decide('duplicate', pair('id-b', 'id-c'), 'pending', null);
    const tagged = (tag: string, record: string) => ({tag, record_id: record});
    decide('tag_suggestion', tagged('beta', 'id-a'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('tag_suggestion', tagged('alpha', 'id-a'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('tag_suggestion', tagged('alfa', 'id-a'), 'accepted', '2026-09-20T00:00:00.000Z');
    decide('tag_suggestion', tagged('beta', 'id-gone'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('tag_suggestion', tagged('beta', 'id-b'), 'rejected', '2026-09-10T00:00:00.000Z');
    decide('tag_suggestion', tagged('beta', 'id-b'), 'accepted', '2026-09-11T00:00:00.000Z');
    decide('new_tag', tagged('zeta', 'id-b'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('new_tag', tagged('alpha', 'id-b'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('new_tag', tagged('alfa', 'id-c'), 'rejected', '2026-09-20T00:00:00.000Z');
    decide('new_tag', tagged('zeta', 'id-gone'), 'rejected', '2026-09-20T00:00:00.000Z');
    const aged = {file_path: 'topics/c.md', age_days: 100, rule: 'log > 90d'};
    decide(
      'archive_candidate',
      {record_id: 'id-c', ...aged},
      'rejected',
      '2026-09-17T00:00:00.000Z',
      'id-c'
    );
    decide(
      'archive_candidate',
      {record_id: 'id-b', ...aged},
      'rejected',
      '2026-09-16T23:59:59.999Z',
      'id-b'
    );
    decide(
      'archive_candidate',
      {record_id: 'id-a', ...aged},
      'accepted',
      '2026-09-30T00:00:00.000Z',
      'id-a'
    );
    decide('compaction_candidate', {folder_path: 'logs'}, 'rejected', '2026-09-30T00:00:00.000Z');
    decide('compaction_candidate', {folder_path: 'topics'}, 'rejected', '2026-09-01T00:00:00.000Z');
    decide(
      'inefficiency_detected',
      {signal: 'edge_fanout_high', current: 12},
      'accepted',
      '2026-09-10T00:00:00.000Z'
    );
    decide(
      'inefficiency_detected',
      {signal: 'edge_fanout_high', current: 20},
      'rejected',
      '2026-09-20T00:00:00.000Z'
    );
    decide('inefficiency_detected', {signal: 'fts_bloat', current: 3}, 'pending', null);
    decide(
      'edge_type',
      {from_record: 'id-a', to_record: 'id-b'},
      'rejected',
      '2026-09-20T00:00:00.000Z',
      'id-a'
    );
    decide(
      'agent_enrichment_stale',
      {record_id: 'id-a'},
      'accepted',
      '2026-09-20T00:00:00.000Z',
      'id-a'
    );

    const lines = stateFiles(db, now)
      .get('suggestions.jsonl')!
      .trimEnd()
      .split('\n')
      .map(l => JSON.parse(l));
    const by = 'agent';
    t.deepEqual(lines, [
      {
        kind: 'archive_candidate',
        record_id: 'id-c',
        status: 'rejected',
        resolved_by: by,
        resolved_at: '2026-09-17T00:00:00.000Z'
      },
      {
        kind: 'compaction_candidate',
        folder_path: 'logs',
        status: 'rejected',
        resolved_by: by,
        resolved_at: '2026-09-30T00:00:00.000Z'
      },
      {
        kind: 'duplicate',
        a_record: 'id-a',
        b_record: 'id-b',
        status: 'rejected',
        resolved_by: by,
        resolved_at: '2026-09-20T00:00:00.000Z'
      },
      {
        kind: 'duplicate',
        a_record: 'id-a',
        b_record: 'id-c',
        status: 'accepted',
        resolved_by: by,
        resolved_at: '2026-09-21T00:00:00.000Z'
      },
      {
        kind: 'inefficiency_detected',
        signal: 'edge_fanout_high',
        current: 20,
        status: 'rejected',
        resolved_by: by,
        resolved_at: '2026-09-20T00:00:00.000Z'
      },
      {
        kind: 'new_tag',
        tag: 'zeta',
        record_id: 'id-b',
        status: 'rejected',
        resolved_by: by,
        resolved_at: '2026-09-20T00:00:00.000Z'
      },
      {
        kind: 'tag_suggestion',
        tag: 'beta',
        record_id: 'id-a',
        status: 'rejected',
        resolved_by: by,
        resolved_at: '2026-09-20T00:00:00.000Z'
      },
      {
        kind: 'tag_suggestion',
        tag: 'beta',
        record_id: 'id-b',
        status: 'accepted',
        resolved_by: by,
        resolved_at: '2026-09-11T00:00:00.000Z'
      }
    ]);

    db.exec(
      `UPDATE suggestions SET status = 'pending', resolved_at = NULL, resolved_by = NULL WHERE id = 's01'`
    );
    t.notOk(
      stateFiles(db, now).get('suggestions.jsonl')!.includes('"b_record":"id-b"'),
      'a reopened decision leaves the file'
    );
  } finally {
    db.close();
  }
});

test('exportVaultState writes a file only when its content changed', async t => {
  const db = setup();
  const root = mkdtempSync(join(tmpdir(), 'vault-state-'));
  try {
    t.deepEqual(await exportVaultState(db, root), [
      `${STATE_DIR}/tags.jsonl`,
      `${STATE_DIR}/records.jsonl`,
      `${STATE_DIR}/suggestions.jsonl`
    ]);
    t.deepEqual(await exportVaultState(db, root), [], 'nothing changed, nothing written');
    db.exec(`UPDATE tags_taxonomy SET description = 'Now described.' WHERE tag = 'beta'`);
    t.deepEqual(await exportVaultState(db, root), [`${STATE_DIR}/tags.jsonl`]);
    t.matchString(readFileSync(join(root, STATE_DIR, 'tags.jsonl'), 'utf8'), /Now described\./);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('git-sync commits the state with the content, and an unchanged state with nothing', async t => {
  const db = setup();
  const root = mkdtempSync(join(tmpdir(), 'vault-state-sync-'));
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', {
    cwd: root
  });
  writeFileSync(join(root, 'README.md'), '# vault\n');
  execSync('git add -A && git commit -q -m initial', {cwd: root});
  const handle = startGitSync({
    vaultDataPath: root,
    db,
    intervalMs: 60_000,
    log: () => {},
    onError: () => {}
  });
  const committed = (): string =>
    execSync('git show --name-only --format= HEAD', {cwd: root}).toString().trim();
  try {
    await handle.syncNow();
    t.equal(
      committed(),
      `${STATE_DIR}/records.jsonl\n${STATE_DIR}/suggestions.jsonl\n${STATE_DIR}/tags.jsonl`,
      'the first pass commits the state'
    );
    const head = execSync('git rev-parse HEAD', {cwd: root}).toString().trim();
    await handle.syncNow();
    t.equal(
      execSync('git rev-parse HEAD', {cwd: root}).toString().trim(),
      head,
      'an unchanged state commits nothing'
    );
    db.exec(`DELETE FROM tag_aliases WHERE alias = 'a'`);
    await handle.syncNow();
    t.equal(committed(), `${STATE_DIR}/tags.jsonl`, 'a changed alias commits its file');
  } finally {
    handle.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

const NOW = '2026-10-01T00:00:00.000Z';

const fresh = (): DatabaseSync => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return db;
};

/** A vault of three notes and a database that imported it and decided four suggestions. */
const decidedVault = () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-seed-'));
  mkdirSync(join(root, 'topics'));
  const note = (name: string, fm: string): void =>
    writeFileSync(
      join(root, 'topics', name),
      `---\ntitle: ${name}\ntype: permanent\n${fm}---\nBody of ${name}.\n`
    );
  note('a.md', 'tags: [alpha]\nagent:\n  tags_suggested: [beta]\n');
  note('b.md', 'tags: [zeta]\n');
  note('c.md', 'tags: [alfa]\n');
  const db = fresh();
  db.exec(`
    INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES
      ('alpha', 'Notes about alpha.', '2026-09-30', 'manual'),
      ('beta', NULL, '2026-09-30', 'minted');
    INSERT INTO tag_aliases (alias, canonical) VALUES ('alfa', 'alpha');
  `);
  importVault(db, root);
  const id = (path: string): string =>
    (
      db.prepare('SELECT record_id FROM records WHERE file_path = ?').get(path) as {
        record_id: string;
      }
    ).record_id;
  db.exec(`UPDATE suggestions SET status = 'rejected', resolved_at = '${NOW}', resolved_by = 'agent'
            WHERE kind IN ('tag_suggestion', 'new_tag')`);
  new SuggestionFiler(db, 'duplicate').file(
    {
      a_record: id('topics/a.md'),
      a_path: 'topics/a.md',
      b_record: id('topics/b.md'),
      b_path: 'topics/b.md',
      distance: 0.05
    },
    NOW,
    {resolved: {status: 'rejected', by: null}}
  );
  new SuggestionFiler(db, 'inefficiency_detected').file(
    {signal: 'edge_fanout_high', current: 20, threshold: 10, recommendation: 'r'},
    NOW,
    {resolved: {status: 'accepted', by: 'agent'}}
  );
  return {root, db};
};

const pending = (db: DatabaseSync): number =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM suggestions WHERE kind IN ('tag_suggestion', 'new_tag') AND status = 'pending'`
      )
      .get() as {n: number}
  ).n;

test('seedVaultState: a fresh database seeded and imported exports the state it was seeded from', async t => {
  const {root, db} = decidedVault();
  const rebuilt = fresh();
  try {
    t.equal(pending(db), 0, 'every tag question decided');
    await exportVaultState(db, root, NOW);
    const saved = Object.fromEntries(stateFiles(db, NOW));
    t.equal(saved['suggestions.jsonl']!.trimEnd().split('\n').length, 4, 'four decisions saved');
    t.deepEqual(seedVaultState(rebuilt, root), {tags: 2, aliases: 1, records: 3, decisions: 4});
    importVault(rebuilt, root);
    t.deepEqual(
      Object.fromEntries(stateFiles(rebuilt, NOW)),
      saved,
      'the same ids, taxonomy, and decisions'
    );
    t.equal(
      pending(rebuilt),
      0,
      'no tag question asked again, and no new tag for the seeded alias'
    );
    t.equal(dropSeededIds(rebuilt), 0, 'every seeded id taken');
    t.equal(seedVaultState(db, root), null, 'a database with records is left alone');
  } finally {
    db.close();
    rebuilt.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('seedVaultState: an import cut short keeps taking the seeded ids', async t => {
  const {root, db} = decidedVault();
  const rebuilt = fresh();
  try {
    await exportVaultState(db, root, NOW);
    const saved = stateFiles(db, NOW).get('records.jsonl');
    appendFileSync(
      join(root, STATE_DIR, 'records.jsonl'),
      '{"path":"topics/gone.md","id":"id-gone"}\n'
    );
    t.equal(seedVaultState(rebuilt, root)?.records, 4);
    importFile(
      new RecordsRepository(rebuilt),
      'topics/b.md',
      join(root, 'topics/b.md'),
      NOW,
      fullImportOptions(rebuilt)
    );
    t.equal(seedVaultState(rebuilt, root), null, 'a restart does not seed again');
    importVault(rebuilt, root);
    t.equal(stateFiles(rebuilt, NOW).get('records.jsonl'), saved, 'every note under its saved id');
    t.equal(dropSeededIds(rebuilt), 1, 'the id of a note that is gone is dropped');
  } finally {
    db.close();
    rebuilt.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('seedVaultState: a line it cannot read stops the seed with nothing written', t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-seed-bad-'));
  const dir = join(root, STATE_DIR);
  mkdirSync(dir);
  const db = fresh();
  const taxonomy = (): number =>
    (db.prepare('SELECT count(*) AS n FROM tags_taxonomy').get() as {n: number}).n;
  const before = taxonomy();
  try {
    writeFileSync(
      join(dir, 'tags.jsonl'),
      '{"tag":"alpha","description":null,"added":"2026-09-30","origin":"manual","aliases":[]}\n'
    );
    writeFileSync(
      join(dir, 'suggestions.jsonl'),
      '{"kind":"duplicate","a_record":"x","b_record":"y","status":"rejected","resolved_by":null,"resolved_at":"2026-09-30"}\n{"kind":"duplicate"\n'
    );
    t.throws(() => seedVaultState(db, root), SyntaxError, 'unparsed JSON throws');
    try {
      seedVaultState(db, root);
    } catch (err) {
      t.matchString(
        (err as Error).message,
        /suggestions\.jsonl:2: not JSON; .* move \.vault-storage-state\/ aside/
      );
    }
    writeFileSync(join(dir, 'suggestions.jsonl'), '');
    writeFileSync(
      join(dir, 'records.jsonl'),
      '{"path":"a.md","id":"1"}\n{"path":"a.md","id":"2"}\n'
    );
    try {
      seedVaultState(db, root);
      t.fail('a repeated path should throw');
    } catch (err) {
      t.matchString((err as Error).message, /records\.jsonl:2: /, 'the failing line is named');
    }
    t.equal(taxonomy(), before, 'the taxonomy rolled back');
    t.equal(
      (db.prepare('SELECT count(*) AS n FROM seeded_record_ids').get() as {n: number}).n,
      0,
      'no ids kept'
    );
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
