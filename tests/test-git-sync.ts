import test from 'tape-six';
import {execFileSync, execSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isWithinWorkHours, startGitSync} from '../src/server/git-sync.ts';

const initRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'vault-git-sync-'));
  execSync('git init -q -b main', {cwd: root});
  execSync('git config user.email tester@example.com', {cwd: root});
  execSync('git config user.name Tester', {cwd: root});
  // Initial commit so HEAD exists.
  writeFileSync(join(root, 'README.md'), '# vault\n');
  execSync('git add -A', {cwd: root});
  execSync('git commit -q -m initial', {cwd: root});
  return root;
};

const initBareRepo = (): string => {
  // Repo with no user.name/user.email set — neither in this repo nor globally
  // (HOME points at the empty repo dir so git can't pick up the test runner's
  // ~/.gitconfig). Mirrors the production container's `node@<hash>` state.
  const root = mkdtempSync(join(tmpdir(), 'vault-git-sync-bare-'));
  execSync('git init -q -b main', {cwd: root, env: {...process.env, HOME: root}});
  // Seed a commit using one-shot `-c` flags so HEAD exists without persisting
  // identity in the repo's config.
  writeFileSync(join(root, 'README.md'), '# vault\n');
  execSync('git add -A', {cwd: root, env: {...process.env, HOME: root}});
  execSync('git -c user.name=Seed -c user.email=seed@local commit -q -m initial', {
    cwd: root,
    env: {...process.env, HOME: root}
  });
  return root;
};

const cleanup = (root: string): void => rmSync(root, {recursive: true, force: true});

const log = (cwd: string): string[] =>
  execSync('git log --format=%s', {cwd}).toString().trim().split('\n').filter(Boolean);

test('git-sync commits dirty changes via syncNow', async t => {
  const root = initRepo();
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    log: () => {},
    onError: () => {}
  });
  try {
    mkdirSync(join(root, 'topics'), {recursive: true});
    writeFileSync(join(root, 'topics/new.md'), '---\ntitle: New\n---\nbody\n');
    await handle.syncNow();
    const commits = log(root);
    t.equal(commits.length, 2, 'one new commit added');
    t.ok(commits[0]?.startsWith('vault-storage auto-commit'), 'commit subject');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync is a no-op on a clean tree', async t => {
  const root = initRepo();
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    log: () => {},
    onError: () => {}
  });
  try {
    await handle.syncNow();
    t.equal(log(root).length, 1, 'only the initial commit');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync commits without a global gitconfig (container scenario)', async t => {
  const root = initBareRepo();
  const errors: string[] = [];
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    log: () => {},
    onError: err => errors.push(err instanceof Error ? err.message : String(err))
  });
  try {
    writeFileSync(join(root, 'note.md'), 'hello\n');
    // syncNow runs against a HOME with no ~/.gitconfig, so the only way commit
    // succeeds is if git-sync passes -c user.name/-c user.email itself.
    const prevHome = process.env['HOME'];
    process.env['HOME'] = root;
    try {
      await handle.syncNow();
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
    t.deepEqual(errors, [], 'no errors reported');
    const commits = execSync('git log --format=%s', {
      cwd: root,
      env: {...process.env, HOME: root}
    })
      .toString()
      .trim()
      .split('\n');
    t.equal(commits.length, 2, 'auto-commit added on top of seed');
    t.ok(commits[0]?.startsWith('vault-storage auto-commit'), 'commit subject');
    const author = execSync('git log -1 --format=%ae', {
      cwd: root,
      env: {...process.env, HOME: root}
    })
      .toString()
      .trim();
    t.equal(author, 'vault-storage@localhost', 'default author email applied');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync respects authorName / authorEmail overrides', async t => {
  const root = initBareRepo();
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    authorName: 'Custom Bot',
    authorEmail: 'bot@example.org',
    log: () => {},
    onError: () => {}
  });
  try {
    writeFileSync(join(root, 'note.md'), 'hi\n');
    const prevHome = process.env['HOME'];
    process.env['HOME'] = root;
    try {
      await handle.syncNow();
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
    const author = execFileSync('git', ['log', '-1', '--format=%an|%ae'], {
      cwd: root,
      env: {...process.env, HOME: root}
    })
      .toString()
      .trim();
    t.equal(author, 'Custom Bot|bot@example.org', 'override applied');
  } finally {
    handle.close();
    cleanup(root);
  }
});

// --- C8.1: backoff + work-hours window --------------------------------

test('isWithinWorkHours: standard non-wrapping window', t => {
  // 09:00–18:00 — the README default.
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T09:00:00'), '09:00', '18:00'),
    true,
    'inclusive at start'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T13:30:00'), '09:00', '18:00'),
    true,
    'midday inside'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T17:59:00'), '09:00', '18:00'),
    true,
    'one minute before close'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T18:00:00'), '09:00', '18:00'),
    false,
    'exclusive at end'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T08:59:00'), '09:00', '18:00'),
    false,
    'one minute before open'
  );
  t.equal(isWithinWorkHours(new Date('2026-05-06T03:00:00'), '09:00', '18:00'), false, 'pre-dawn');
});

test('isWithinWorkHours: wrap-around window (overnight)', t => {
  // 22:00–06:00 — overnight on-call window.
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T22:00:00'), '22:00', '06:00'),
    true,
    'at start, after midnight wrap'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T23:30:00'), '22:00', '06:00'),
    true,
    'late evening'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T02:00:00'), '22:00', '06:00'),
    true,
    'past midnight'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T05:59:00'), '22:00', '06:00'),
    true,
    'one minute before close'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T06:00:00'), '22:00', '06:00'),
    false,
    'exclusive at end'
  );
  t.equal(
    isWithinWorkHours(new Date('2026-05-06T12:00:00'), '22:00', '06:00'),
    false,
    'midday outside'
  );
});

test('isWithinWorkHours: empty window (start === end) is always false', t => {
  t.equal(isWithinWorkHours(new Date('2026-05-06T12:00:00'), '12:00', '12:00'), false);
  t.equal(isWithinWorkHours(new Date('2026-05-06T12:00:00'), '00:00', '00:00'), false);
});

test('git-sync syncNow runs commit even outside the work-hours window', async t => {
  const root = initRepo();
  // Window that's guaranteed to be in the past — manual trigger must
  // bypass it. Pick 00:00–00:01 unless the test happens to run during
  // that minute, in which case reverse the window.
  const localHour = new Date().getHours();
  const window = localHour === 0 ? {start: '12:00', end: '12:01'} : {start: '00:00', end: '00:01'};
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    intervalMaxMs: 7_200_000,
    workHours: window,
    log: () => {},
    onError: () => {}
  });
  try {
    writeFileSync(join(root, 'forced.md'), 'hello\n');
    await handle.syncNow();
    const commits = log(root);
    t.equal(commits.length, 2, 'manual syncNow committed despite being outside the window');
    t.ok(commits[0]?.startsWith('vault-storage auto-commit'), 'commit subject');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync respects intervalMaxMs in the constructor without blowing up', async t => {
  // Smoke test: backoff config is accepted and a commit still works on
  // the manual path. The actual interval-doubling is internal state we
  // don't expose, but we verify the config doesn't break basic flow.
  const root = initRepo();
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    intervalMaxMs: 7_200_000,
    log: () => {},
    onError: () => {}
  });
  try {
    writeFileSync(join(root, 'a.md'), 'a\n');
    await handle.syncNow();
    t.equal(log(root).length, 2, 'commit landed with backoff config enabled');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync degrades gracefully when path is not a repo', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-git-sync-noinit-'));
  try {
    const handle = startGitSync({
      vaultDataPath: root,
      intervalMs: 60_000,
      log: () => {},
      onError: () => {}
    });
    // Should not throw.
    await handle.syncNow();
    handle.close();
    t.pass('no-repo path tolerated');
  } finally {
    cleanup(root);
  }
});

test('git-sync removes a stale index.lock and commits on the retry', async t => {
  const root = initRepo();
  const errors: string[] = [];
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    log: () => {},
    onError: err => errors.push(String(err))
  });
  try {
    writeFileSync(join(root, 'note.md'), '---\ntitle: Note\n---\nbody\n');
    const lockPath = join(root, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    const past = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, past, past);

    await handle.syncNow();

    t.equal(log(root).length, 2, 'commit landed despite the stale lock');
    t.notOk(existsSync(lockPath), 'stale lock removed');
    t.equal(errors.length, 0, 'recovery is not an error');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync leaves a fresh index.lock alone and reports the failure', async t => {
  const root = initRepo();
  const errors: string[] = [];
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    log: () => {},
    onError: err => errors.push(String(err))
  });
  try {
    writeFileSync(join(root, 'note.md'), '---\ntitle: Note\n---\nbody\n');
    const lockPath = join(root, '.git', 'index.lock');
    writeFileSync(lockPath, '');

    await handle.syncNow();

    t.equal(log(root).length, 1, 'no commit while the lock is fresh');
    t.ok(existsSync(lockPath), 'fresh lock left in place');
    t.equal(errors.length, 1, 'failure surfaced to onError');
    t.ok(errors[0]?.includes('index.lock'), 'error names the lock');
  } finally {
    handle.close();
    cleanup(root);
  }
});

test('git-sync failure ledger: streak recorded in meta, cleared on success', async t => {
  const root = initRepo();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const readMeta = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      {value: string} | undefined;
    return row?.value ?? null;
  };
  const handle = startGitSync({
    vaultDataPath: root,
    intervalMs: 60_000,
    // A 1h staleness floor keeps the just-planted lock "fresh" for the
    // whole test, so every poll fails without triggering recovery.
    lockStaleMs: 3_600_000,
    db,
    log: () => {},
    onError: () => {}
  });
  try {
    writeFileSync(join(root, 'note.md'), '---\ntitle: Note\n---\nbody\n');
    const lockPath = join(root, '.git', 'index.lock');
    writeFileSync(lockPath, '');

    await handle.syncNow();
    await handle.syncNow();
    await handle.syncNow();

    t.equal(readMeta('git_sync_consecutive_failures'), '3', 'streak counts every failed poll');
    t.ok(readMeta('git_sync_last_error')?.includes('index.lock'), 'last error preserved');
    t.ok(readMeta('git_sync_failing_since'), 'first-failure timestamp recorded');
    const since = readMeta('git_sync_failing_since');
    await handle.syncNow();
    t.equal(readMeta('git_sync_failing_since'), since, 'failing_since pins the streak start');

    rmSync(lockPath);
    await handle.syncNow();

    t.equal(log(root).length, 2, 'commit landed once the lock was gone');
    t.equal(readMeta('git_sync_consecutive_failures'), null, 'streak cleared on success');
    t.equal(readMeta('git_sync_last_error'), null, 'last error cleared');
    t.equal(readMeta('git_sync_failing_since'), null, 'failing_since cleared');
  } finally {
    handle.close();
    db.close();
    cleanup(root);
  }
});
