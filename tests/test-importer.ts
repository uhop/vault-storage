import test from 'tape-six';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {RecordsRepository} from '../src/records/repository.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-test-'));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
};

test('importVault loads a small synthetic vault', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/alpha.md',
      ['---', 'title: Alpha', 'tags: []', 'created: 2026-04-01', '---', 'Alpha body.', ''].join(
        '\n'
      )
    );
    writeMd(
      root,
      'logs/2026-04-28-x.md',
      ['---', 'title: Log entry', 'created: 2026-04-28', '---', 'Log body.', ''].join('\n')
    );
    writeMd(
      root,
      'projects/demo/queue.md',
      ['---', 'title: Demo queue', '---', 'queue body', ''].join('\n')
    );
    writeMd(root, 'raw/note.md', 'No frontmatter here, just body.\n');

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);

    const summary = importVault(db, root);
    t.equal(summary.total, 4, '4 markdown files imported');
    t.equal(summary.inserted, 4, 'all inserted on first run');
    t.equal(summary.updated, 0, 'none updated');
    t.equal(summary.unchanged, 0, 'none unchanged');

    const repo = new RecordsRepository(db);
    t.equal(repo.count(), 4, 'records table has 4 rows');

    const alpha = repo.getByPath('topics/alpha.md');
    t.ok(alpha, 'topics/alpha.md present');
    t.equal(alpha?.type, 'permanent', 'topics → permanent');
    t.equal(alpha?.created, '2026-04-01', 'created from frontmatter');

    const log = repo.getByPath('logs/2026-04-28-x.md');
    t.equal(log?.type, 'log', 'logs → log');

    const projectQueue = repo.getByPath('projects/demo/queue.md');
    t.equal(projectQueue?.type, 'project', 'projects/<name>/queue.md → project');

    const raw = repo.getByPath('raw/note.md');
    t.equal(raw?.type, 'fleeting', 'raw → fleeting');
    t.equal(raw?.body, 'No frontmatter here, just body.\n', 'no-frontmatter body preserved');

    db.close();
  } finally {
    cleanup();
  }
});

test('second import is idempotent: unchanged when content matches', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/x.md', '---\ntitle: X\n---\nbody\n');
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const second = importVault(db, root);
    t.equal(second.unchanged, 1, 'one file unchanged');
    t.equal(second.inserted, 0, 'nothing newly inserted');
    t.equal(second.updated, 0, 'nothing updated');
    db.close();
  } finally {
    cleanup();
  }
});

test('second import detects body changes as "updated" with stable record_id', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/x.md', '---\ntitle: X\n---\nfirst body\n');
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    const idBefore = repo.getByPath('topics/x.md')?.recordId;

    writeMd(root, 'topics/x.md', '---\ntitle: X\n---\nsecond body\n');
    const second = importVault(db, root);
    t.equal(second.updated, 1, 'one file updated');
    const after = repo.getByPath('topics/x.md');
    t.equal(after?.recordId, idBefore, 'record_id preserved across update');
    t.equal(after?.body, 'second body\n', 'body refreshed');
    db.close();
  } finally {
    cleanup();
  }
});

test('frontmatter title round-trips into the records.title column', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/with-title.md', '---\ntitle: Hello World\n---\nbody\n');
    writeMd(root, 'topics/no-title.md', '---\ntags: []\n---\nbody\n');
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    t.equal(repo.getByPath('topics/with-title.md')?.title, 'Hello World', 'title preserved');
    t.equal(repo.getByPath('topics/no-title.md')?.title, null, 'absent title is null');
    db.close();
  } finally {
    cleanup();
  }
});

test('explicit frontmatter type overrides path-derived type', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/explicit.md', '---\ntitle: X\ntype: design\n---\nbody\n');
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    t.equal(repo.getByPath('topics/explicit.md')?.type, 'design', 'frontmatter type wins');
    db.close();
  } finally {
    cleanup();
  }
});

test('importFile syncs tags on the unchanged path (backfill case)', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      ['---', 'title: X', 'tags: [design, research]', '---', 'body', ''].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    db.exec(`
      INSERT INTO tags_taxonomy (tag, description, added) VALUES
        ('design', null, '2026-04-29'),
        ('research', null, '2026-04-29');
    `);

    // First import: tags get inserted (insert path).
    importVault(db, root);
    const repo = new RecordsRepository(db);
    const recordId = repo.getByPath('topics/x.md')?.recordId ?? '';
    t.ok(recordId, 'record was imported');

    // Simulate the live-DB backfill scenario: the record exists but the
    // tags table is empty (mimicking pre-TagsImporter import).
    db.prepare('DELETE FROM tags WHERE record_id = ?').run(recordId);
    const empty = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE record_id = ?').get(recordId) as {n: number};
    t.equal(empty.n, 0, 'tags cleared to simulate pre-backfill state');

    // Second import: content_hash and tracked fields all match → 'unchanged'
    // path. With the fix, tags are still synced from frontmatter.
    const second = importVault(db, root);
    t.equal(second.unchanged, 1, 'second import hits unchanged path');
    const rows = db
      .prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag')
      .all(recordId) as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['design', 'research'], 'tags backfilled on unchanged path');
    db.close();
  } finally {
    cleanup();
  }
});

test('importFile picks up tags-only frontmatter edits via the unchanged path', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/x.md', ['---', 'title: X', 'tags: [design]', '---', 'body', ''].join('\n'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    db.exec(`
      INSERT INTO tags_taxonomy (tag, description, added) VALUES
        ('design', null, '2026-04-29'),
        ('research', null, '2026-04-29');
    `);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    const recordId = repo.getByPath('topics/x.md')?.recordId ?? '';

    // Edit only the tags array. Body, title, type, status, priority all
    // unchanged → record-row unchanged → without the fix, tags would not
    // re-sync and 'design' would persist.
    writeMd(root, 'topics/x.md', ['---', 'title: X', 'tags: [research]', '---', 'body', ''].join('\n'));
    const second = importVault(db, root);
    t.equal(second.unchanged, 1, 'tags-only edit still hits unchanged path');
    const rows = db
      .prepare('SELECT tag FROM tags WHERE record_id = ?')
      .all(recordId) as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['research'], 'tag set tracks the new frontmatter');
    db.close();
  } finally {
    cleanup();
  }
});

test('walker skips .git and .obsidian directories', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/keep.md', '---\ntitle: K\n---\nbody\n');
    writeMd(root, '.git/foo.md', 'should be ignored\n');
    writeMd(root, '.obsidian/workspace.md', 'should be ignored\n');
    writeMd(root, 'node_modules/pkg/readme.md', 'should be ignored\n');

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    const summary = importVault(db, root);
    t.equal(summary.total, 1, 'only the real file imported');
    db.close();
  } finally {
    cleanup();
  }
});
