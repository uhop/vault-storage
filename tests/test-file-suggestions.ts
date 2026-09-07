import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {
  LINK_REMOVED,
  repathPendingSuggestions,
  SuggestionFiler
} from '../src/importer/file-suggestions.ts';

const NOW = '2026-07-24T00:00:00Z';

const setup = () => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return db;
};

test('edge_type filing dedupes across target-record recreation (2026-07-12 dupe)', async t => {
  const db = setup();
  try {
    const filer = new SuggestionFiler(db, 'edge_type');
    const payload = (toRecord: string) => ({
      from_record: 'rec-a',
      from_path: 'topics/a.md',
      to_record: toRecord,
      to_path: 'topics/b.md',
      classifier_type: 'cites' as const,
      context: 'ctx'
    });

    t.equal(filer.file(payload('rec-b-old'), NOW), true, 'first filing lands');
    t.equal(filer.file(payload('rec-b-old'), NOW), false, 'identical refile blocked (pending)');
    // The consolidation shape: the target was deleted + recreated, so the
    // link resolves to a fresh record_id while the old suggestion (whose
    // subject is the UNTOUCHED from-record) is still pending with a dangling
    // to_record. Same link, same paths — must not file a second copy.
    t.equal(
      filer.file(payload('rec-b-new'), NOW),
      false,
      'same (from_record, to_path) blocked despite a new to_record'
    );

    // A genuinely different link from the same source still files.
    t.equal(
      filer.file(
        {
          from_record: 'rec-a',
          from_path: 'topics/a.md',
          to_record: 'rec-c',
          to_path: 'topics/c.md',
          classifier_type: 'cites',
          context: 'ctx'
        },
        NOW
      ),
      true,
      'different target path files normally'
    );
  } finally {
    db.close();
  }
});

test('repathPendingSuggestions rewrites payload paths for a moved record', async t => {
  const db = setup();
  try {
    const edges = new SuggestionFiler(db, 'edge_type');
    const tags = new SuggestionFiler(db, 'tag_suggestion');
    const stale = new SuggestionFiler(db, 'agent_enrichment_stale');

    edges.file(
      {
        from_record: 'rec-m',
        from_path: 'topics/moved.md',
        to_record: 'rec-t',
        to_path: 'topics/target.md',
        classifier_type: 'cites',
        context: 'ctx'
      },
      NOW
    );
    edges.file(
      {
        from_record: 'rec-o',
        from_path: 'topics/other.md',
        to_record: 'rec-m',
        to_path: 'topics/moved.md',
        classifier_type: 'cites',
        context: 'ctx'
      },
      NOW
    );
    tags.file({tag: 'demo', record_id: 'rec-m', file_path: 'topics/moved.md'}, NOW);
    stale.file(
      {
        record_id: 'rec-m',
        file_path: 'topics/moved.md',
        agent_derived_from_hash: 'h1',
        current_body_hash: 'h2'
      },
      NOW
    );
    // A resolved row must NOT be rewritten — history keeps filing-time paths.
    tags.file({tag: 'done', record_id: 'rec-m', file_path: 'topics/moved.md'}, NOW);
    tags.accept({tag: 'done', record_id: 'rec-m'}, 'test', NOW);

    const changed = repathPendingSuggestions(db, 'rec-m', 'topics/relocated.md');
    t.equal(changed, 4, 'four pending payload paths rewritten (from, to, 2× file_path)');

    const rows = db
      .prepare(`SELECT kind, status, payload FROM suggestions ORDER BY kind, created`)
      .all() as Array<{kind: string; status: string; payload: string}>;
    for (const row of rows) {
      const p = JSON.parse(row.payload) as Record<string, string>;
      if (row.status === 'accepted') {
        t.equal(p['file_path'], 'topics/moved.md', 'resolved row keeps its filing-time path');
        continue;
      }
      const paths = [p['file_path'], p['from_path'], p['to_path']].filter(Boolean);
      t.notOk(
        paths.includes('topics/moved.md') &&
          (p['record_id'] === 'rec-m' ||
            p['from_record'] === 'rec-m' ||
            p['to_record'] === 'rec-m'),
        `${row.kind}: no stale path remains for the moved record`
      );
    }
    const edgeIn = rows.find(r => r.kind === 'edge_type' && r.payload.includes('rec-o'));
    t.ok(
      edgeIn?.payload.includes('"to_path":"topics/relocated.md"'),
      'inbound edge suggestion re-pathed on the to side'
    );
    const edgeOut = rows.find(r => r.kind === 'edge_type' && r.payload.includes('"rec-t"'));
    t.ok(
      edgeOut?.payload.includes('"from_path":"topics/relocated.md"'),
      'outbound edge suggestion re-pathed on the from side'
    );
  } finally {
    db.close();
  }
});

test('a link-removed rejection does not block re-filing; a reviewer rejection does', async t => {
  const db = setup();
  try {
    const filer = new SuggestionFiler(db, 'edge_type');
    const payload = {
      from_record: 'rec-a',
      from_path: 'topics/a.md',
      to_record: 'rec-b',
      to_path: 'topics/b.md',
      classifier_type: 'cites' as const,
      context: 'ctx'
    };
    t.equal(filer.file(payload, NOW), true, 'first filing lands');
    const first = filer.pending({from_record: 'rec-a'});
    t.equal(first.length, 1, 'one pending');
    t.equal(filer.rejectById(first[0]!.id, LINK_REMOVED, NOW), true, 'rejected as link-removed');
    t.equal(
      filer.rejectById(first[0]!.id, LINK_REMOVED, NOW),
      false,
      'a settled row is left alone'
    );
    t.equal(filer.file(payload, NOW), true, 'the pair re-files: a moot question is not a verdict');

    const second = filer.pending({from_record: 'rec-a'});
    t.equal(second.length, 1, 'one pending again');
    t.equal(filer.rejectById(second[0]!.id, 'agent', NOW), true, 'rejected by a reviewer');
    t.equal(filer.file(payload, NOW), false, 'a verdict blocks for good');
  } finally {
    db.close();
  }
});

test('a rejection with a NULL resolved_by still blocks re-filing (the 2026-09-07 re-file wave)', async t => {
  const db = setup();
  try {
    const filer = new SuggestionFiler(db, 'edge_type');
    const payload = {
      from_record: 'rec-a',
      from_path: 'topics/a.md',
      to_record: 'rec-b',
      to_path: 'topics/b.md',
      classifier_type: 'cites' as const,
      context: 'ctx'
    };
    t.equal(filer.file(payload, NOW), true, 'first filing lands');
    // The shape most historical rejections have: status flipped, no resolver recorded.
    db.prepare(
      `UPDATE suggestions SET status = 'rejected', resolved_at = ?, resolved_by = NULL`
    ).run(NOW);
    t.equal(filer.file(payload, NOW), false, 'a NULL resolved_by rejection is still a verdict');
    db.prepare(`UPDATE suggestions SET resolved_by = ''`).run();
    t.equal(filer.file(payload, NOW), false, 'an empty resolved_by rejection blocks too');
  } finally {
    db.close();
  }
});

test('the filer stamps payload.evidence per kind, and a caller-supplied evidence wins', async t => {
  const db = setup();
  try {
    const read = (kind: string) =>
      (
        db
          .prepare('SELECT payload FROM suggestions WHERE kind = ? ORDER BY created, id')
          .all(kind) as Array<{payload: string}>
      ).map(r => (JSON.parse(r.payload) as {evidence: unknown}).evidence);
    new SuggestionFiler(db, 'edge_type').file(
      {
        from_record: 'a',
        from_path: 'a.md',
        to_record: 'b',
        to_path: 'b.md',
        classifier_type: 'cites',
        context: 'c'
      },
      NOW
    );
    new SuggestionFiler(db, 'duplicate').file(
      {a_record: 'a', b_record: 'b', a_path: 'a.md', b_path: 'b.md', distance: 0.1} as never,
      NOW
    );
    new SuggestionFiler(db, 'tag_suggestion').file(
      {tag: 't', record_id: 'a', file_path: 'a.md'},
      NOW
    );
    new SuggestionFiler(db, 'archive_candidate').file(
      {record_id: 'a', file_path: 'a.md', rule: 'log > 90d'} as never,
      NOW
    );
    new SuggestionFiler(db, 'agent_enrichment_stale').file(
      {record_id: 'a', file_path: 'a.md', agent_derived_from_hash: 'x', current_body_hash: 'y'},
      NOW
    );
    t.deepEqual(read('edge_type'), [{source: 'structural', asserted: true}]);
    t.deepEqual(read('duplicate'), [{source: 'vector', asserted: false}]);
    t.deepEqual(read('tag_suggestion'), [{source: 'agent', asserted: false}]);
    t.deepEqual(read('archive_candidate'), [{source: 'metric', asserted: true}]);
    t.deepEqual(read('agent_enrichment_stale'), [{source: 'structural', asserted: true}]);

    new SuggestionFiler(db, 'edge_type').file(
      {
        from_record: 'a',
        from_path: 'a.md',
        to_record: 'c',
        to_path: 'c.md',
        classifier_type: 'cites',
        context: 'c',
        evidence: {source: 'lexical', asserted: true}
      },
      NOW
    );
    t.deepEqual(
      read('edge_type')[1],
      {source: 'lexical', asserted: true},
      'explicit evidence kept'
    );
  } finally {
    db.close();
  }
});
