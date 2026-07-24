import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {repathPendingSuggestions, SuggestionFiler} from '../src/importer/file-suggestions.ts';

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
