import test from 'tape-six';
import {execSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {startGitSync} from '../src/server/git-sync.ts';
import {exportVaultState, STATE_DIR, stateFiles} from '../src/vault-state.ts';

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
      `${STATE_DIR}/records.jsonl`
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
      `${STATE_DIR}/records.jsonl\n${STATE_DIR}/tags.jsonl`,
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
