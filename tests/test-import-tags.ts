import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TagsImporter} from '../src/importer/import-tags.ts';

const setup = () => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  // Seed a small taxonomy so the trigger has something to allow.
  db.exec(`
    INSERT INTO tags_taxonomy (tag, description, added) VALUES
      ('design', null, '2026-04-29'),
      ('research', null, '2026-04-29'),
      ('storage', null, '2026-04-29');
    INSERT INTO tag_aliases (alias, canonical) VALUES
      ('designs', 'design'),
      ('researches', 'research');
    INSERT INTO records (record_id, file_path, type, body, content_hash, body_hash, created, updated) VALUES
      ('r1', 'topics/x.md', 'permanent', 'b', 'h1', 'h1', '2026-04-29', '2026-04-29');
  `);
  return db;
};

test('TagsImporter: inserts known tags', t => {
  const db = setup();
  try {
    const tags = new TagsImporter(db);
    const result = tags.syncTags('r1', 'topics/x.md', ['design', 'research']);
    t.equal(result.inserted, 2);
    t.deepEqual(result.rejected, []);
    t.equal(result.suggestionsFiled, 0, 'no suggestions for known tags');
    const rows = db.prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag').all('r1') as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['design', 'research']);
  } finally {
    db.close();
  }
});

test('TagsImporter: applies aliases', t => {
  const db = setup();
  try {
    const tags = new TagsImporter(db);
    const result = tags.syncTags('r1', 'topics/x.md', ['designs', 'researches']);
    t.equal(result.inserted, 2);
    const rows = db.prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag').all('r1') as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['design', 'research'], 'aliases canonicalized');
  } finally {
    db.close();
  }
});

test('TagsImporter: unknown tags reported but not fatal', t => {
  const db = setup();
  try {
    const tags = new TagsImporter(db);
    const result = tags.syncTags('r1', 'topics/x.md', ['design', 'never-heard-of-this']);
    t.equal(result.inserted, 1, 'known tag inserted');
    t.deepEqual(result.rejected, ['never-heard-of-this']);
    t.equal(result.suggestionsFiled, 1, 'one new_tag suggestion filed');
    const rows = db.prepare('SELECT tag FROM tags WHERE record_id = ?').all('r1') as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['design']);
  } finally {
    db.close();
  }
});

test('TagsImporter: replaces previous tag set', t => {
  const db = setup();
  try {
    const tags = new TagsImporter(db);
    tags.syncTags('r1', 'topics/x.md', ['design', 'research']);
    const after = tags.syncTags('r1', 'topics/x.md', ['storage']);
    t.equal(after.inserted, 1);
    const rows = db.prepare('SELECT tag FROM tags WHERE record_id = ?').all('r1') as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['storage'], 'old tags removed');
  } finally {
    db.close();
  }
});

test('TagsImporter: normalizes raw input', t => {
  const db = setup();
  try {
    const tags = new TagsImporter(db);
    // Whitespace, case, underscores get normalized to kebab-case lowercase.
    const result = tags.syncTags('r1', 'topics/x.md', ['  Design ', 'RESEARCH']);
    t.equal(result.inserted, 2);
    const rows = db.prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag').all('r1') as Array<{tag: string}>;
    t.deepEqual(rows.map(r => r.tag), ['design', 'research']);
  } finally {
    db.close();
  }
});

test('TagsImporter: non-array frontmatter is a no-op', t => {
  const db = setup();
  try {
    const tags = new TagsImporter(db);
    const result = tags.syncTags('r1', 'topics/x.md', 'not an array');
    t.equal(result.inserted, 0);
    t.deepEqual(result.rejected, []);
  } finally {
    db.close();
  }
});
