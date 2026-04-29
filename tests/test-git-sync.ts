import test from 'tape-six';
import {execSync} from 'node:child_process';
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
