import test from 'tape-six';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import {contentHash} from '../src/util/hash.ts';

const bodyHash = (body: string): string => contentHash(body);

const pendingStaleCount = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM suggestions
           WHERE kind = 'agent_enrichment_stale' AND status = 'pending'`
        )
        .get() as {n: number}
    ).n
  );

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

test('importFile detects created/updated FM changes as "updated" (body unchanged)', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      ['---', 'title: X', 'created: 2026-04-20', 'updated: 2026-04-20', '---', 'body', ''].join(
        '\n'
      )
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    const before = repo.getByPath('topics/x.md');
    t.equal(before?.created, '2026-04-20', 'initial created');
    t.equal(before?.updated, '2026-04-20', 'initial updated');

    // Change only `updated:` in frontmatter; body unchanged → content_hash stable.
    writeMd(
      root,
      'topics/x.md',
      ['---', 'title: X', 'created: 2026-04-20', 'updated: 2026-04-30', '---', 'body', ''].join(
        '\n'
      )
    );
    const second = importVault(db, root);
    t.equal(second.updated, 1, 'FM-only updated change triggers updated path');
    t.equal(second.unchanged, 0, 'not classified as unchanged');
    const after = repo.getByPath('topics/x.md');
    t.equal(after?.updated, '2026-04-30', 'DB row reflects new updated');
    t.equal(after?.recordId, before?.recordId, 'record_id stable across update');
    db.close();
  } finally {
    cleanup();
  }
});

test('reindex treats a fossil timestamp created vs same-date file created as unchanged', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      ['---', 'title: X', 'created: 2026-04-29', 'updated: 2026-04-30', '---', 'body', ''].join(
        '\n'
      )
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    // Simulate the historical fossil: an early import stored `created` as a full
    // ISO timestamp. It's preserved (never overwritten) on upsert, so it never
    // reconciles to the file's date-only `created`. A strict === would then
    // report "changed" on every reindex — re-importing and churning modified_at.
    db.prepare(
      "UPDATE records SET created = '2026-04-29T02:39:23.977Z' WHERE file_path = 'topics/x.md'"
    ).run();

    const second = importVault(db, root);
    t.equal(second.unchanged, 1, 'date vs same-day timestamp created → unchanged');
    t.equal(second.updated, 0, 'not spuriously re-imported');
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
    const empty = db
      .prepare('SELECT COUNT(*) AS n FROM tags WHERE record_id = ?')
      .get(recordId) as {n: number};
    t.equal(empty.n, 0, 'tags cleared to simulate pre-backfill state');

    // Second import: content_hash and tracked fields all match → 'unchanged'
    // path. With the fix, tags are still synced from frontmatter.
    const second = importVault(db, root);
    t.equal(second.unchanged, 1, 'second import hits unchanged path');
    const rows = db
      .prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag')
      .all(recordId) as Array<{tag: string}>;
    t.deepEqual(
      rows.map(r => r.tag),
      ['design', 'research'],
      'tags backfilled on unchanged path'
    );
    db.close();
  } finally {
    cleanup();
  }
});

test('importFile picks up tags-only frontmatter edits via the unchanged path', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      ['---', 'title: X', 'tags: [design]', '---', 'body', ''].join('\n')
    );
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
    writeMd(
      root,
      'topics/x.md',
      ['---', 'title: X', 'tags: [research]', '---', 'body', ''].join('\n')
    );
    const second = importVault(db, root);
    t.equal(second.unchanged, 1, 'tags-only edit still hits unchanged path');
    const rows = db.prepare('SELECT tag FROM tags WHERE record_id = ?').all(recordId) as Array<{
      tag: string;
    }>;
    t.deepEqual(
      rows.map(r => r.tag),
      ['research'],
      'tag set tracks the new frontmatter'
    );
    db.close();
  } finally {
    cleanup();
  }
});

test('importer parses agent.summary and agent.derived_from_hash from FM', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/enriched.md',
      [
        '---',
        'title: Enriched',
        'tags: []',
        'agent:',
        '  summary: "One-line distillation of the document."',
        '  derived_from_hash: deadbeef',
        '  key_concepts: [a, b]',
        '---',
        'body content',
        ''
      ].join('\n')
    );
    writeMd(root, 'topics/plain.md', '---\ntitle: Plain\n---\nbody\n');

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);

    const repo = new RecordsRepository(db);
    const enriched = repo.getByPath('topics/enriched.md');
    t.equal(enriched?.agentSummary, 'One-line distillation of the document.', 'summary read');
    t.equal(enriched?.agentDerivedFromHash, 'deadbeef', 'derived_from_hash read');

    const plain = repo.getByPath('topics/plain.md');
    t.equal(plain?.agentSummary, null, 'no agent block → null summary');
    t.equal(plain?.agentDerivedFromHash, null, 'no agent block → null hash');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer treats malformed agent block as missing', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/bad.md',
      // agent: as a scalar string, not a mapping — must not crash, must default to null.
      ['---', 'title: Bad', 'agent: "not a mapping"', '---', 'body', ''].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    const r = repo.getByPath('topics/bad.md');
    t.equal(r?.agentSummary, null, 'string agent → null summary');
    t.equal(r?.agentDerivedFromHash, null, 'string agent → null hash');
    db.close();
  } finally {
    cleanup();
  }
});

test('summary-only edit triggers re-import (changes content_hash)', t => {
  const {root, cleanup} = setupVault();
  try {
    const initial = [
      '---',
      'title: T',
      'agent:',
      '  summary: "first summary"',
      '  derived_from_hash: aaaa',
      '---',
      'unchanged body',
      ''
    ].join('\n');
    writeMd(root, 'topics/t.md', initial);
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    const first = importVault(db, root);
    t.equal(first.inserted, 1, 'inserted on first pass');

    // Same body, different summary. content_hash must change because the
    // chunker input changed.
    const updated = initial.replace('first summary', 'second summary');
    writeMd(root, 'topics/t.md', updated);
    const second = importVault(db, root);
    t.equal(second.updated, 1, 'summary-only edit treated as changed');
    t.equal(second.unchanged, 0, 'not unchanged');

    const repo = new RecordsRepository(db);
    const r = repo.getByPath('topics/t.md');
    t.equal(r?.agentSummary, 'second summary', 'summary refreshed');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer files agent_enrichment_stale when derived_from_hash diverges', t => {
  const {root, cleanup} = setupVault();
  try {
    // The frontmatter parser preserves bytes after the closing `---\n`, so
    // the importer hashes whatever bytes the body has — trailing newline
    // included. Compose the file content body-first, then compute the hash
    // against the same bytes the importer will see.
    const writeWithMatchingHash = (summary: string, bodyBytes: string, hashOverride?: string) => {
      const fm = [
        '---',
        'title: Doc',
        'agent:',
        `  summary: ${JSON.stringify(summary)}`,
        '  derived_from_hash: ' + (hashOverride ?? bodyHash(bodyBytes)),
        '---',
        ''
      ].join('\n');
      writeMd(root, 'topics/d.md', fm + bodyBytes);
    };

    // First pass: agent block present, hash matches body — fresh.
    const body1 = 'first body content\n';
    writeWithMatchingHash('first summary', body1);
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    t.equal(pendingStaleCount(db), 0, 'no stale suggestion when hash matches');

    // Second pass: body edited, agent.derived_from_hash still old → stale.
    const body2 = 'edited body content (LLM has not seen this yet)\n';
    writeWithMatchingHash('first summary', body2, bodyHash(body1));
    importVault(db, root);
    t.equal(pendingStaleCount(db), 1, 'stale suggestion filed after body diverges');

    // Third pass: re-importing the same stale state must not duplicate.
    importVault(db, root);
    t.equal(pendingStaleCount(db), 1, 'idempotent — no duplicate stale suggestion');

    // Fourth pass: refresh the agent block to match the new body.
    writeWithMatchingHash('second summary (refreshed)', body2);
    importVault(db, root);
    t.equal(pendingStaleCount(db), 0, 'auto-resolved when hash matches body again');
    const accepted = db
      .prepare(
        `SELECT status, resolved_by FROM suggestions
         WHERE kind = 'agent_enrichment_stale'`
      )
      .all() as Array<{status: string; resolved_by: string}>;
    t.equal(accepted.length, 1, 'one stale row total (now resolved)');
    t.equal(accepted[0]?.status, 'accepted', 'resolved');
    t.equal(accepted[0]?.resolved_by, 'hash-matched', 'resolved_by signals auto-accept path');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer skips stale check when agent block missing or partial', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/none.md', '---\ntitle: No agent\n---\nbody\n');
    writeMd(
      root,
      'topics/partial.md',
      ['---', 'title: Partial', 'agent:', '  summary: "no hash"', '---', 'body', ''].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    t.equal(pendingStaleCount(db), 0, 'no stale suggestion for missing/partial agent');
    db.close();
  } finally {
    cleanup();
  }
});

const seedTagsTaxonomy = (db: DatabaseSync): void => {
  db.exec(`
    INSERT INTO tags_taxonomy (tag, description, added) VALUES
      ('design', null, '2026-04-29'),
      ('research', null, '2026-04-29'),
      ('storage', null, '2026-04-29');
    INSERT INTO tag_aliases (alias, canonical) VALUES
      ('storages', 'storage');
  `);
};

const pendingTagSuggestionCount = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM suggestions
           WHERE kind = 'tag_suggestion' AND status = 'pending'`
        )
        .get() as {n: number}
    ).n
  );

test('importer files tag_suggestion for agent.tags_suggested entries not on FM', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [research, storage]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);

    const rows = db
      .prepare(
        `SELECT json_extract(payload, '$.tag') AS tag,
                json_extract(payload, '$.record_id') AS record_id,
                status
           FROM suggestions
          WHERE kind = 'tag_suggestion'
          ORDER BY tag`
      )
      .all() as Array<{tag: string; record_id: string; status: string}>;
    t.equal(rows.length, 2, 'two tag_suggestion rows filed');
    t.deepEqual(
      rows.map(r => r.tag),
      ['research', 'storage'],
      'one per suggested tag not yet on FM'
    );
    t.ok(
      rows.every(r => r.status === 'pending'),
      'all pending'
    );

    // Re-import — idempotent on the pending pair.
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 2, 're-import does not duplicate');
    db.close();
  } finally {
    cleanup();
  }
});

test('tag_suggestion dedup spans all statuses (re-import after rejection does not refile)', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [research]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 1, 'one pending after first import');

    // Reject the suggestion (simulates the user saying "no, this tag doesn't fit").
    db.prepare(
      `UPDATE suggestions
          SET status = 'rejected',
              resolved_at = '2026-05-14T00:00:00.000Z',
              resolved_by = 'user-rejected'
        WHERE kind = 'tag_suggestion'
          AND status = 'pending'`
    ).run();
    const allCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'tag_suggestion'`).get() as {
        n: number;
      }
    ).n;
    t.equal(allCount, 1, 'one tag_suggestion row total after reject');
    t.equal(pendingTagSuggestionCount(db), 0, 'zero pending after reject');

    // Re-import — under the old pending-only dedup this refilled the same
    // (record_id, tag) shape and the rejection was meaningless. Under the
    // any-status dedup the rejected row blocks re-filing.
    importVault(db, root);
    const finalAllCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'tag_suggestion'`).get() as {
        n: number;
      }
    ).n;
    t.equal(finalAllCount, 1, 'still one row after re-import — rejection is durable');
    t.equal(pendingTagSuggestionCount(db), 0, 'still zero pending — no refile');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer skips filing tag_suggestion for tags already realized on FM', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design, research]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [design, research]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 0, 'no suggestions when all suggested tags realized');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer auto-accepts pending tag_suggestion when tag becomes realized', t => {
  const {root, cleanup} = setupVault();
  try {
    // Pass 1: research suggested but not on FM.
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [research]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 1, 'one pending suggestion after first import');

    // Pass 2: user (or agent) added research to FM tags. Suggestion auto-accepts.
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design, research]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [research]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 0, 'pending cleared on realization');
    const accepted = db
      .prepare(
        `SELECT status, resolved_by FROM suggestions
         WHERE kind = 'tag_suggestion'`
      )
      .all() as Array<{status: string; resolved_by: string}>;
    t.equal(accepted.length, 1);
    t.equal(accepted[0]?.status, 'accepted');
    t.equal(accepted[0]?.resolved_by, 'tag-realized', 'resolved_by signals realization path');
    db.close();
  } finally {
    cleanup();
  }
});

test('tag_suggestion auto-accept matches an alias-spelled payload (resolve before compare)', t => {
  const {root, cleanup} = setupVault();
  try {
    // Pass 1: `standard` suggested but not yet canonical or aliased, so it's
    // filed with the literal `standard` in the payload.
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [standard]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 1, 'one pending after first import');
    const filed = db
      .prepare(
        `SELECT json_extract(payload, '$.tag') AS tag FROM suggestions WHERE kind = 'tag_suggestion'`
      )
      .all() as Array<{tag: string}>;
    t.equal(filed[0]?.tag, 'standard', 'payload holds the literal alias spelling');

    // `standard` now becomes an alias of canonical `conventions`.
    db.exec(`
      INSERT INTO tags_taxonomy (tag, description, added) VALUES ('conventions', null, '2026-05-07');
      INSERT INTO tag_aliases (alias, canonical) VALUES ('standard', 'conventions');
    `);

    // Pass 2: user adds the alias `standard` to FM. TagsImporter stores the
    // canonical `conventions`; the pending suggestion (payload `standard`)
    // must auto-accept even though its payload tag != the realized canonical.
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design, standard]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [standard]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    importVault(db, root);
    t.equal(
      pendingTagSuggestionCount(db),
      0,
      'alias-spelled pending clears once canonical is realized'
    );
    const accepted = db
      .prepare(`SELECT status, resolved_by FROM suggestions WHERE kind = 'tag_suggestion'`)
      .all() as Array<{status: string; resolved_by: string}>;
    t.equal(accepted.length, 1, 'no duplicate filed');
    t.equal(accepted[0]?.status, 'accepted');
    t.equal(accepted[0]?.resolved_by, 'tag-realized');
    db.close();
  } finally {
    cleanup();
  }
});

test('tag_suggestion alias-resolves before comparison', t => {
  const {root, cleanup} = setupVault();
  try {
    // 'storages' (alias) resolves to 'storage' (canonical). FM has 'storage';
    // suggested 'storages' should auto-accept, not file a duplicate.
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [storage]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [storages]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 0, 'alias resolves to realized canonical, no pending');
    db.close();
  } finally {
    cleanup();
  }
});

test('tag_suggestion skipped when agent block missing or non-array tags_suggested', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/none.md', '---\ntitle: N\ntags: [design]\n---\nbody\n');
    writeMd(
      root,
      'topics/malformed.md',
      [
        '---',
        'title: M',
        'tags: [design]',
        'agent:',
        '  summary: "ok"',
        '  tags_suggested: "not an array"',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);
    t.equal(pendingTagSuggestionCount(db), 0, 'no suggestions when block missing or malformed');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer normalizes legacy status aliases per closed-enums design', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/a.md', '---\ntitle: A\nstatus: completed\n---\nbody A\n');
    writeMd(root, 'topics/b.md', '---\ntitle: B\nstatus: in-progress\n---\nbody B\n');
    writeMd(root, 'topics/c.md', '---\ntitle: C\nstatus: stub\n---\nbody C\n');
    writeMd(root, 'topics/d.md', '---\ntitle: D\nstatus: archive\n---\nbody D\n');
    writeMd(root, 'topics/e.md', '---\ntitle: E\nstatus: not-a-real-status\n---\nbody E\n');
    writeMd(root, 'topics/f.md', '---\ntitle: F\n---\nbody F\n');
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    t.equal(repo.getByPath('topics/a.md')?.status, 'done', 'completed -> done');
    t.equal(repo.getByPath('topics/b.md')?.status, 'active', 'in-progress -> active');
    t.equal(repo.getByPath('topics/c.md')?.status, 'draft', 'stub -> draft');
    t.equal(repo.getByPath('topics/d.md')?.status, 'archived', 'archive -> archived');
    t.equal(repo.getByPath('topics/e.md')?.status, 'active', 'unknown -> default active');
    t.equal(repo.getByPath('topics/f.md')?.status, 'active', 'absent -> default active');
    db.close();
  } finally {
    cleanup();
  }
});

test('importer normalizes named priority aliases; integers pass through', t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/low.md', '---\ntitle: L\npriority: low\n---\nbody\n');
    writeMd(root, 'topics/high.md', '---\ntitle: H\npriority: high\n---\nbody\n');
    writeMd(root, 'topics/critical.md', '---\ntitle: C\npriority: critical\n---\nbody\n');
    writeMd(root, 'topics/twenty-two.md', '---\ntitle: T\npriority: 22\n---\nbody\n');
    writeMd(root, 'topics/neg.md', '---\ntitle: N\npriority: -5\n---\nbody\n');
    writeMd(root, 'topics/junk.md', '---\ntitle: J\npriority: super-critical\n---\nbody\n');
    writeMd(root, 'topics/none.md', '---\ntitle: A\n---\nbody\n');
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    importVault(db, root);
    const repo = new RecordsRepository(db);
    t.equal(repo.getByPath('topics/low.md')?.priority, -1, 'low -> -1');
    t.equal(repo.getByPath('topics/high.md')?.priority, 1, 'high -> 1');
    t.equal(repo.getByPath('topics/critical.md')?.priority, 2, 'critical -> 2');
    t.equal(repo.getByPath('topics/twenty-two.md')?.priority, 22, 'open-ended int passes through');
    t.equal(repo.getByPath('topics/neg.md')?.priority, -5, 'negative int passes through');
    t.equal(repo.getByPath('topics/junk.md')?.priority, 0, 'unknown name -> default 0');
    t.equal(repo.getByPath('topics/none.md')?.priority, 0, 'absent -> default 0');
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

test('out-of-taxonomy suggested tag files a companion new_tag (origin: proposed)', t => {
  // The 2026-07-20 `blindspot` deadlock: a tag_suggestion naming a tag that
  // is neither canonical nor aliased could not be accepted (taxonomy-first)
  // and nothing routed the taxonomy question to new_tag. The companion
  // filing gives it the queue it needs; the sweep's new_tag-before-
  // tag_suggestion ordering then dissolves the deadlock.
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/x.md',
      [
        '---',
        'title: X',
        'tags: [design]',
        'agent:',
        '  summary: "a note"',
        '  tags_suggested: [research, blindspot]',
        '---',
        'body',
        ''
      ].join('\n')
    );
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    seedTagsTaxonomy(db);
    importVault(db, root);

    const newTags = db
      .prepare(
        `SELECT json_extract(payload, '$.tag') AS tag,
                json_extract(payload, '$.origin') AS origin,
                status
           FROM suggestions
          WHERE kind = 'new_tag'`
      )
      .all() as Array<{tag: string; origin: string | null; status: string}>;
    t.equal(newTags.length, 1, 'exactly one companion new_tag');
    t.equal(newTags[0]?.tag, 'blindspot', 'for the out-of-taxonomy tag only');
    t.equal(newTags[0]?.origin, 'proposed', 'origin marks it as not-on-FM');
    t.equal(newTags[0]?.status, 'pending', 'pending for triage');
    t.equal(pendingTagSuggestionCount(db), 2, 'both tag_suggestions still filed');

    importVault(db, root);
    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'new_tag'`)
      .get() as {n: number};
    t.equal(after.n, 1, 're-import does not duplicate the companion');
    db.close();
  } finally {
    cleanup();
  }
});
