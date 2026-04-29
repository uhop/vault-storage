import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {syncFromObsidian} from '../src/migration/sync.ts';
import {SyncBaselineRepository, decideSync} from '../src/migration/sync-update.ts';
import {contentHash} from '../src/util/hash.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = (): {source: string; target: string; cleanup: () => void} => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-storage-sync-test-'));
  const source = join(dir, 'obsidian');
  const target = join(dir, 'vault-data');
  mkdirSync(source, {recursive: true});
  mkdirSync(target, {recursive: true});
  return {source, target, cleanup: () => rmSync(dir, {recursive: true, force: true})};
};

const fm = (lines: Record<string, unknown>, body: string): string => {
  const yaml: string[] = ['---'];
  for (const [k, v] of Object.entries(lines)) {
    if (Array.isArray(v)) yaml.push(`${k}: [${(v as unknown[]).join(', ')}]`);
    else yaml.push(`${k}: ${v}`);
  }
  yaml.push('---');
  return yaml.join('\n') + '\n' + body + (body.endsWith('\n') ? '' : '\n');
};

test('decideSync: new when target is absent', t => {
  const r = decideSync({transformed: 'hello', target: null, targetIsAtomized: false, baseline: null});
  t.equal(r.action, 'new', 'new action');
  t.equal(r.contentToWrite, 'hello', 'writes the transformed content');
  t.ok(r.newBaselineHash, 'records a new baseline hash');
});

test('decideSync: unchanged when source matches target byte-for-byte', t => {
  const r = decideSync({
    transformed: 'hello',
    target: 'hello',
    targetIsAtomized: false,
    baseline: null
  });
  t.equal(r.action, 'unchanged', 'unchanged');
  t.equal(r.contentToWrite, undefined, 'no write');
});

test('decideSync: skipped_locally_newer when no baseline and target differs', t => {
  const r = decideSync({
    transformed: 'new',
    target: 'old',
    targetIsAtomized: false,
    baseline: null
  });
  t.equal(r.action, 'skipped_locally_newer', 'skipped (no baseline)');
});

test('decideSync: skipped_locally_newer when target diverged from baseline', t => {
  const r = decideSync({
    transformed: 'sourceV2',
    target: 'localEditV1',
    targetIsAtomized: false,
    baseline: 'hash-of-the-original-not-the-current'
  });
  t.equal(r.action, 'skipped_locally_newer', 'local edit detected');
});

test('decideSync: updated when target matches baseline', t => {
  const target = 'baseline-content';
  const r = decideSync({
    transformed: 'newSource',
    target,
    targetIsAtomized: false,
    baseline: contentHash(target)
  });
  t.equal(r.action, 'updated', 'updated');
  t.equal(r.contentToWrite, 'newSource', 'writes the new source');
});

test('decideSync: skipped_atomized takes precedence over everything', t => {
  const r = decideSync({
    transformed: 'src',
    target: null,
    targetIsAtomized: true,
    baseline: null
  });
  t.equal(r.action, 'skipped_atomized', 'atomized target skipped');
});

test('SyncBaselineRepository: get/upsert/listPaths/delete', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const repo = new SyncBaselineRepository(db);

  t.equal(repo.get('a.md'), null, 'unknown path → null');
  repo.upsert('a.md', 'hash1', '2026-04-29');
  t.equal(repo.get('a.md'), 'hash1', 'after upsert');
  repo.upsert('a.md', 'hash2', '2026-04-30');
  t.equal(repo.get('a.md'), 'hash2', 'upsert overwrites');
  repo.upsert('b.md', 'hashB', '2026-04-30');
  t.deepEqual(repo.listPaths().sort(), ['a.md', 'b.md'], 'listPaths covers both');
  repo.delete('a.md');
  t.equal(repo.get('a.md'), null, 'after delete');
  db.close();
});

test('syncFromObsidian: writes new file and records baseline', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha body.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      const summary = syncFromObsidian({source, target, db, isoDate: '2026-04-29'});
      t.equal(summary.total, 1, 'one source file');
      t.equal(summary.new, 1, 'one new');
      t.equal(summary.updated, 0, 'zero updated');
      t.ok(existsSync(join(target, 'topics/alpha.md')), 'target file exists');
      const baseline = new SyncBaselineRepository(db);
      t.ok(baseline.get('topics/alpha.md'), 'baseline recorded');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: idempotent on a second pass', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha body.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      syncFromObsidian({source, target, db, isoDate: '2026-04-29'});
      const second = syncFromObsidian({source, target, db, isoDate: '2026-04-30'});
      t.equal(second.new, 0, 'second pass: no new');
      t.equal(second.updated, 0, 'second pass: no updated');
      t.equal(second.unchanged, 1, 'second pass: unchanged');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: detects local edit and skips', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha v1.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      // First sync: target gets v1, baseline recorded.
      syncFromObsidian({source, target, db, isoDate: '2026-04-29'});
      // Local edit on the target side.
      writeMd(target, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha LOCAL.'));
      // Source also changed.
      writeMd(source, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha v2.'));

      const summary = syncFromObsidian({source, target, db, isoDate: '2026-04-30'});
      t.equal(summary.skippedLocallyNewer, 1, 'skipped due to local edit');
      const onDisk = readFileSync(join(target, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('Alpha LOCAL.'), 'target left untouched');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: updates target when only source changed', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha v1.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      syncFromObsidian({source, target, db, isoDate: '2026-04-29'});
      writeMd(source, 'topics/alpha.md', fm({title: 'Alpha v2', tags: []}, 'Alpha v2.'));
      const summary = syncFromObsidian({source, target, db, isoDate: '2026-04-30'});
      t.equal(summary.updated, 1, 'updated');
      const onDisk = readFileSync(join(target, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('Alpha v2.'), 'target reflects source v2');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: dry_run does not write or update baseline', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha', tags: []}, 'Alpha body.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      const summary = syncFromObsidian({source, target, db, isoDate: '2026-04-29', dryRun: true});
      t.equal(summary.new, 1, 'reports as new');
      t.equal(existsSync(join(target, 'topics/alpha.md')), false, 'target NOT written');
      const baseline = new SyncBaselineRepository(db);
      t.equal(baseline.get('topics/alpha.md'), null, 'baseline NOT recorded');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: skips atomized target', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'projects/demo/decisions.md', fm({title: 'Decisions'}, 'Source.'));
    // Target was previously atomized into a folder of pieces.
    writeMd(
      target,
      'projects/demo/decisions/_about.md',
      fm({title: 'Decisions', type: 'meta'}, 'about.')
    );
    writeMd(
      target,
      'projects/demo/decisions/first.md',
      fm({title: 'First', type: 'design'}, 'piece.')
    );

    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      const summary = syncFromObsidian({source, target, db, isoDate: '2026-04-29'});
      t.equal(summary.skippedAtomized, 1, 'atomized target skipped');
      t.equal(existsSync(join(target, 'projects/demo/decisions.md')), false, 'no new flat file');
      t.equal(
        existsSync(join(target, 'projects/demo/decisions/_about.md')),
        true,
        'atomized folder preserved'
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: reports removed_in_source for paths the source no longer has', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha'}, 'Alpha.'));
    writeMd(source, 'topics/beta.md', fm({title: 'Beta'}, 'Beta.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      syncFromObsidian({source, target, db, isoDate: '2026-04-29'});
      // User deleted beta.md from Obsidian.
      rmSync(join(source, 'topics/beta.md'));
      const summary = syncFromObsidian({source, target, db, isoDate: '2026-04-30'});
      t.equal(summary.removedInSource, 1, 'one removed in source');
      const removed = summary.files.find(f => f.action === 'removed_in_source');
      t.equal(removed?.relativePath, 'topics/beta.md', 'reports beta.md as removed');
      // We don't auto-delete from target.
      t.equal(existsSync(join(target, 'topics/beta.md')), true, 'target left in place');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('syncFromObsidian: writes per-pass log when writeLog=true', t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha'}, 'Alpha.'));
    const db = openDatabase({path: ':memory:'});
    runMigrations(db);
    try {
      const summary = syncFromObsidian({
        source,
        target,
        db,
        isoDate: '2026-04-29',
        writeLog: true
      });
      t.ok(summary.logPath, 'log path returned');
      t.ok(summary.logPath!.startsWith('logs/sync/'), 'log under logs/sync/');
      const logAbs = join(target, summary.logPath!);
      t.ok(existsSync(logAbs), 'log file written');
      const content = readFileSync(logAbs, 'utf8');
      t.ok(content.includes('## new'), 'log lists new section');
      t.ok(content.includes('topics/alpha.md'), 'log mentions the synced file');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});
