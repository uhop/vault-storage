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

    await t.test('related-to is auto-mirrored per target', t => {
      // Symmetric types fan out a mirror for each unique target, so beta and
      // gamma both gain a related-to back to alpha.
      const betaIn = edges.listInbound(alpha!.recordId).filter(e => e.type === 'related-to');
      t.ok(
        betaIn.some(e => e.fromId === beta!.recordId),
        'beta → alpha mirror exists'
      );
      t.ok(
        betaIn.some(e => e.fromId === gamma!.recordId),
        'gamma → alpha mirror exists'
      );
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

    await t.test('gamma has only the related-to mirror back to alpha', t => {
      const out = edges.listOutbound(gamma!.recordId);
      t.equal(out.length, 1, 'one outbound edge — the mirror');
      t.equal(out[0]?.type, 'related-to');
      t.equal(out[0]?.toId, alpha!.recordId);
    });
  } finally {
    teardown(fx);
  }
});

test('buildEdges GCs edges that no longer have a backing wikilink', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'topics/a.md',
      [
        '---',
        'title: A',
        'related:',
        '  - "[[topics/b]]"',
        '---',
        'A cites [[topics/b]].',
        ''
      ].join('\n')
    );
    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\n---\nplain\n');

    const first = importVault(fx.db, fx.root);
    t.ok(first.edges.edgesCreated >= 2, 'initial edges written');
    t.equal(first.edges.edgesDeleted, 0, 'nothing to GC on a fresh build');

    // Edit topics/a.md to remove all references to topics/b.
    writeMd(
      fx.root,
      'topics/a.md',
      ['---', 'title: A', '---', 'A no longer mentions B.', ''].join('\n')
    );
    const second = importVault(fx.db, fx.root);
    t.ok(second.edges.edgesDeleted >= 2, 'stale edges (cites + related-to + mirror) collected');

    const edges = new EdgesRepository(fx.db);
    const records = new RecordsRepository(fx.db);
    const a = records.getByPath('topics/a.md');
    const b = records.getByPath('topics/b.md');
    const between = edges
      .listOutbound(a!.recordId)
      .filter(e => e.toId === b!.recordId)
      .concat(edges.listOutbound(b!.recordId).filter(e => e.toId === a!.recordId));
    t.equal(between.length, 0, 'no edges between a ↔ b after the GC pass');
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
    // related: → related-to, plus auto-mirror (related-to is symmetric per edge-taxonomy).
    t.equal(first.edges.edgesCreated, 2, 'one edge + auto-mirror on initial import');

    const second = buildEdges(fx.db, {vaultRoot: fx.root});
    t.equal(second.edgesCreated, 2, 're-run reports the upserts (idempotent at DB level)');

    const edges = new EdgesRepository(fx.db);
    const records = new RecordsRepository(fx.db);
    const x = records.getByPath('topics/x.md');
    const y = records.getByPath('topics/y.md');
    t.equal(edges.listOutbound(x!.recordId).length, 1, 'x has one outbound (→ y)');
    t.equal(edges.listOutbound(y!.recordId).length, 1, 'y has one outbound mirror (→ x)');
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

test('default-cites edges file pending edge_type suggestions (idempotent)', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'a.md',
      ['---', 'title: A', '---', 'A mentions [[b]] in passing.', ''].join('\n')
    );
    writeMd(fx.root, 'b.md', '---\ntitle: B\n---\nbody\n');

    const first = importVault(fx.db, fx.root);
    t.equal(first.edges.suggestionsFiled, 1, 'one suggestion filed for the default-cites edge');

    const records = new RecordsRepository(fx.db);
    const a = records.getByPath('a.md');
    const b = records.getByPath('b.md');

    const rows = fx.db
      .prepare(
        `SELECT id, kind, subject_id, payload, status FROM suggestions WHERE kind = 'edge_type'`
      )
      .all() as Array<{
      id: string;
      kind: string;
      subject_id: string;
      payload: string;
      status: string;
    }>;
    t.equal(rows.length, 1, 'exactly one suggestion row');
    t.equal(rows[0]?.subject_id, a!.recordId, 'subject_id is the source record');
    t.equal(rows[0]?.status, 'pending', 'status pending');
    const payload = JSON.parse(rows[0]!.payload) as {
      from_record: string;
      to_record: string;
      from_path: string;
      to_path: string;
      classifier_type: string;
      context: string;
    };
    t.equal(payload.from_record, a!.recordId, 'payload.from_record');
    t.equal(payload.to_record, b!.recordId, 'payload.to_record');
    t.equal(payload.from_path, 'a.md', 'payload.from_path');
    t.equal(payload.to_path, 'b.md', 'payload.to_path');
    t.equal(payload.classifier_type, 'cites', 'classifier_type recorded');
    t.ok(payload.context.includes('mentions [[b]]'), 'context surrounds the wikilink');

    const second = importVault(fx.db, fx.root);
    t.equal(second.edges.suggestionsFiled, 0, 're-import files no new suggestions');
    const after = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'edge_type'`)
      .get() as {n: number};
    t.equal(after.n, 1, 'still exactly one suggestion');
  } finally {
    teardown(fx);
  }
});

test('default-cites from a log/query source skips edge_type filing (DEFAULT_SKIP_EDGE_TYPE_FILING_FROM)', async t => {
  // Logs and queries by convention `cites` topic/project notes. Filing a
  // review queue entry per such wikilink just adds noise (the 2026-05-03
  // session produced 5 noisy log→topic suggestions in a single PUT before
  // this skip landed). Edges still get written; only the suggestion is
  // suppressed.
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/2026-05-03-some-session.md',
      [
        '---',
        'title: Some session',
        'type: log',
        '---',
        'Closed bug per [[topics/bge-nan]] and updated [[projects/p/learnings]].',
        ''
      ].join('\n')
    );
    writeMd(fx.root, 'topics/bge-nan.md', '---\ntitle: BGE NaN\ntype: permanent\n---\nbody\n');
    writeMd(
      fx.root,
      'projects/p/learnings.md',
      '---\ntitle: P learnings\ntype: project\n---\nbody\n'
    );

    const summary = importVault(fx.db, fx.root);
    t.equal(summary.edges.suggestionsFiled, 0, 'no suggestions filed from a log source');
    t.equal(
      summary.edges.suggestionsSkippedByType,
      2,
      'both default-cites links from the log are counted as skipped-by-type'
    );

    // The edges themselves still landed.
    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const log = records.getByPath('logs/2026-05-03-some-session.md');
    const outbound = edges.listOutbound(log!.recordId);
    t.equal(outbound.length, 2, 'two outbound edges written despite skip');
    t.ok(
      outbound.every(e => e.type === 'cites'),
      'edges land as cites (skip suppresses filing only)'
    );

    const sugRows = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'edge_type'`)
      .get() as {n: number};
    t.equal(sugRows.n, 0, 'no edge_type rows in the suggestions table');
  } finally {
    teardown(fx);
  }
});

test('source types outside the skip set still file edge_type suggestions', async t => {
  // Sanity: the skip is type-specific. A `permanent` topic source citing
  // another permanent topic still files (these are the genuinely
  // interesting cases for review — could be `derived-from`, `applies-to`,
  // etc.).
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'topics/a.md',
      ['---', 'title: A', 'type: permanent', '---', 'A mentions [[topics/b]].', ''].join('\n')
    );
    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\ntype: permanent\n---\nbody\n');

    const summary = importVault(fx.db, fx.root);
    t.equal(summary.edges.suggestionsFiled, 1, 'topic→topic still files');
    t.equal(summary.edges.suggestionsSkippedByType, 0);
  } finally {
    teardown(fx);
  }
});

test('skipEdgeTypeFilingFromTypes option overrides the default set', async t => {
  // Pass an empty set to file for all types (legacy behavior). Test by
  // calling buildEdges directly so we can pass the option.
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/x.md',
      ['---', 'title: X', 'type: log', '---', 'See [[topics/y]].', ''].join('\n')
    );
    writeMd(fx.root, 'topics/y.md', '---\ntitle: Y\ntype: permanent\n---\nbody\n');

    importVault(fx.db, fx.root);
    // importVault uses default skip set → 0 filed. Re-run buildEdges with
    // empty skip set to verify the override fires.
    const summary = buildEdges(fx.db, {
      vaultRoot: fx.root,
      skipEdgeTypeFilingFromTypes: new Set()
    });
    t.equal(summary.suggestionsFiled, 1, 'empty skip set fires for log source');
    t.equal(summary.suggestionsSkippedByType, 0, 'no suppressed-by-type rows');
  } finally {
    teardown(fx);
  }
});

test('keyword-cued body wikilinks are NOT filed as suggestions', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'a.md',
      ['---', 'title: A', '---', 'A is derived from [[b]] and supersedes [[c]].', ''].join('\n')
    );
    writeMd(fx.root, 'b.md', '---\ntitle: B\n---\nbody\n');
    writeMd(fx.root, 'c.md', '---\ntitle: C\n---\nbody\n');

    const summary = importVault(fx.db, fx.root);
    t.equal(summary.edges.suggestionsFiled, 0, 'classified edges never trigger suggestions');

    const n = (
      fx.db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'edge_type'`).get() as {
        n: number;
      }
    ).n;
    t.equal(n, 0, 'no suggestions in DB');
  } finally {
    teardown(fx);
  }
});

test('frontmatter `edges:` overrides default-cites and skips suggestion-filing', async t => {
  const fx = setup();
  try {
    // First import: default-cites + suggestion filed.
    writeMd(
      fx.root,
      'a.md',
      ['---', 'title: A', '---', 'A mentions [[b]] vaguely.', ''].join('\n')
    );
    writeMd(fx.root, 'b.md', '---\ntitle: B\n---\nbody\n');

    const first = importVault(fx.db, fx.root);
    t.equal(first.edges.suggestionsFiled, 1, 'first pass files a suggestion');
    t.equal(first.edges.fmOverridesApplied, 0, 'no FM overrides yet');

    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const a = records.getByPath('a.md');
    const b = records.getByPath('b.md');

    const beforeOverride = edges.listOutbound(a!.recordId).find(e => e.toId === b!.recordId);
    t.equal(beforeOverride?.type, 'cites', 'edge starts as default cites');

    // Agent's resolution: write `edges: { b: derived-from }` into a.md frontmatter,
    // then re-import. The override pins the edge type and clears the queue.
    writeMd(
      fx.root,
      'a.md',
      [
        '---',
        'title: A',
        'edges:',
        '  b: derived-from',
        '---',
        'A mentions [[b]] vaguely.',
        ''
      ].join('\n')
    );

    const second = importVault(fx.db, fx.root);
    t.equal(second.edges.fmOverridesApplied, 1, 'FM override applied once');
    t.equal(second.edges.suggestionsFiled, 0, 'no new suggestions after override');

    const afterOverride = edges.listOutbound(a!.recordId).find(e => e.toId === b!.recordId);
    t.equal(afterOverride?.type, 'derived-from', 'edge promoted to derived-from');

    const stale = edges
      .listOutbound(a!.recordId)
      .find(e => e.toId === b!.recordId && e.type === 'cites');
    t.equal(stale, undefined, 'old cites edge GC-collected');

    // The previously-pending suggestion auto-resolves to accepted when the FM
    // override is applied — clears the queue without requiring an explicit
    // POST /suggestions/{id}/accept call.
    const sugg = fx.db
      .prepare(`SELECT status, resolved_by FROM suggestions WHERE kind = 'edge_type'`)
      .get() as {status: string; resolved_by: string | null};
    t.equal(sugg.status, 'accepted', 'pending suggestion auto-resolved to accepted');
    t.equal(sugg.resolved_by, 'fm-override', 'resolved_by attributes the auto-promotion');
  } finally {
    teardown(fx);
  }
});

test('FM `edges:` with explicit cites prevents suggestion-filing for that pair', async t => {
  const fx = setup();
  try {
    // The user reviewed the link and decided cites is correct — explicit
    // `b: cites` clears it from the review queue without changing the type.
    writeMd(
      fx.root,
      'a.md',
      ['---', 'title: A', 'edges:', '  b: cites', '---', 'A mentions [[b]] in passing.', ''].join(
        '\n'
      )
    );
    writeMd(fx.root, 'b.md', '---\ntitle: B\n---\nbody\n');

    const summary = importVault(fx.db, fx.root);
    t.equal(summary.edges.suggestionsFiled, 0, 'explicit cites entry skips filing');

    const n = (
      fx.db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'edge_type'`).get() as {
        n: number;
      }
    ).n;
    t.equal(n, 0, 'no suggestion filed for reviewed-as-cites');

    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const a = records.getByPath('a.md');
    const b = records.getByPath('b.md');
    const edge = edges.listOutbound(a!.recordId).find(e => e.toId === b!.recordId);
    t.equal(edge?.type, 'cites', 'edge stays as cites');
  } finally {
    teardown(fx);
  }
});

test('archived records contribute no outbound edges; inbound to them still resolves', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      '_index.md',
      [
        '---',
        'title: Master Index (archived)',
        'status: archived',
        'related:',
        '  - "[[topics/alpha]]"',
        '---',
        'See [[topics/alpha]] and [[topics/beta]].',
        ''
      ].join('\n')
    );
    writeMd(
      fx.root,
      'topics/alpha.md',
      ['---', 'title: Alpha', '---', 'Alpha cites [[_index]] for historical context.', ''].join(
        '\n'
      )
    );
    writeMd(fx.root, 'topics/beta.md', '---\ntitle: Beta\n---\nNo links.\n');

    const summary = importVault(fx.db, fx.root);
    t.equal(summary.edges.archivedSkipped, 1, 'one archived record skipped');

    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const idx = records.getByPath('_index.md');
    const alpha = records.getByPath('topics/alpha.md');
    t.ok(idx && alpha, 'records imported');

    t.equal(edges.listOutbound(idx!.recordId).length, 0, 'no outbound edges from archived note');

    const inbound = edges.listOutbound(alpha!.recordId).find(e => e.toId === idx!.recordId);
    t.ok(inbound, 'inbound to archived note still resolves (alpha → _index)');
    t.equal(inbound?.type, 'cites', 'inbound classified as cites');
  } finally {
    teardown(fx);
  }
});

test('buildEdges deletes stale outbound edges when a record is archived after the fact', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'hub.md',
      ['---', 'title: Hub', '---', 'Cites [[topics/a]] and [[topics/b]].', ''].join('\n')
    );
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\n');
    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\n---\n');

    importVault(fx.db, fx.root);

    const records = new RecordsRepository(fx.db);
    const edges = new EdgesRepository(fx.db);
    const hub = records.getByPath('hub.md');
    t.equal(edges.listOutbound(hub!.recordId).length, 2, 'two outbound before archiving');

    // Flip status to archived and re-import.
    writeMd(
      fx.root,
      'hub.md',
      [
        '---',
        'title: Hub',
        'status: archived',
        '---',
        'Cites [[topics/a]] and [[topics/b]].',
        ''
      ].join('\n')
    );
    const second = importVault(fx.db, fx.root);
    t.equal(second.edges.archivedSkipped, 1);
    t.ok(second.edges.edgesDeleted >= 2, "stale outbound GC'd on next pass");

    t.equal(edges.listOutbound(hub!.recordId).length, 0, 'archived note has no outbound');
  } finally {
    teardown(fx);
  }
});
