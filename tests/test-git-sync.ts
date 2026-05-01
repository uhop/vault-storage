import test from 'tape-six';
import {execFileSync, execSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startGitSync} from '../src/server/git-sync.ts';

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
  execSync(
    'git -c user.name=Seed -c user.email=seed@local commit -q -m initial',
    {cwd: root, env: {...process.env, HOME: root}}
  );
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
