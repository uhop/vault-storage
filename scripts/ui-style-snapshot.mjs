#!/usr/bin/env node
// Rendered-comparison gate for CSS changes under static/ui: a computed-style snapshot of every
// page over an in-process server and a fixture vault, and the diff of two snapshots.
//   node scripts/ui-style-snapshot.mjs snapshot <dir>
//   node scripts/ui-style-snapshot.mjs diff <before-dir> <after-dir> [--ignore=prop,prop]
// A position:fixed probe carrying one element per shared class is appended to each page, so a rule
// the page never exercises naturally still shows in the diff; probe differences are listed apart
// from natural ones.
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pw from 'playwright';

const PAGES = [
  'agents',
  'archive-review',
  'fleet',
  'folder',
  'index',
  'lint-review',
  'note',
  'projects',
  'raw',
  'search',
  'tags'
];
const TOKEN = 'snapshot-token';
const root = new URL('..', import.meta.url);

const fm = o =>
  '---\n' +
  Object.entries(o)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`)
    .join('\n') +
  '\n---\n';
const dates = {created: '2026-09-01', updated: '2026-09-03'};
const FIXTURES = {
  'topics/alpha.md':
    fm({title: 'Alpha', tags: ['alpha', 'demo'], type: 'permanent', status: 'active', ...dates}) +
    'Alpha links to [[topics/beta]] and [[projects/demo/queue]].\n\n## Section\n\nBody with `code`.\n',
  'topics/beta.md':
    fm({title: 'Beta', tags: ['beta', 'demo'], type: 'permanent', status: 'active', ...dates}) +
    'Beta links back to [[topics/alpha]].\n',
  'projects/demo/queue.md':
    fm({
      title: 'demo — Queue',
      tags: ['demo', 'queue'],
      type: 'project',
      status: 'active',
      ...dates
    }) +
    'Outstanding work for demo.\n\n## Active\n\n- **Do the thing.** A body with [[topics/alpha]].\n\n## Backlog\n\n- **Later thing.** Deferred.\n\n## Watching\n\n(empty)\n',
  'projects/demo/state.md':
    fm({
      title: 'demo — State',
      tags: ['demo', 'state'],
      type: 'project',
      status: 'active',
      ...dates
    }) + 'Baseline.\n',
  'raw/draft.md':
    fm({title: 'A draft', tags: ['raw'], type: 'fleeting', status: 'active', ...dates}) +
    'Draft body.\n',
  'logs/2026-09-01-demo.md':
    fm({title: 'demo — log', tags: ['demo', 'log'], type: 'log', status: 'active', ...dates}) +
    'Log body.\n'
};

const snapshotPage = () => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position: fixed; left: 0; top: 0; visibility: hidden';
  probe.innerHTML =
    '<div class="err">e</div><div class="empty">m</div><span class="spinner"></span>' +
    '<button>b</button><button class="primary">p</button><button class="danger">d</button>' +
    '<button disabled>x</button><div class="footer">f</div><h2>h</h2><section></section>' +
    '<table><tr><th>t</th><td>d</td></tr></table><div class="ok">ok</div>';
  document.body.appendChild(probe);
  const skip = new Set([
    'SCRIPT',
    'STYLE',
    'LINK',
    'META',
    'TITLE',
    'HEAD',
    'TEMPLATE',
    'NOSCRIPT'
  ]);
  const pathOf = el => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      let i = 0;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) ++i;
      parts.unshift(`${e.tagName.toLowerCase()}[${i}]`);
    }
    return parts.join('/');
  };
  const out = {};
  for (const el of document.querySelectorAll('*')) {
    if (skip.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const css = {};
    for (let i = 0; i < cs.length; ++i) css[cs[i]] = cs.getPropertyValue(cs[i]);
    const r = el.getBoundingClientRect();
    out[pathOf(el)] = {
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className : '',
      probe: probe.contains(el),
      css,
      rect: [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100)
    };
  }
  return out;
};

const snapshot = async out => {
  const {openDatabase} = await import(new URL('src/db/connection.ts', root));
  const {runMigrations} = await import(new URL('src/db/migrate.ts', root));
  const {FakeEmbedder} = await import(new URL('src/embeddings/fake.ts', root));
  const {importVault} = await import(new URL('src/importer/import.ts', root));
  const {startServer} = await import(new URL('src/server/server.ts', root));
  mkdirSync(out, {recursive: true});
  const vault = mkdtempSync(join(tmpdir(), 'ui-style-snapshot-'));
  for (const [p, s] of Object.entries(FIXTURES)) {
    mkdirSync(join(vault, p, '..'), {recursive: true});
    writeFileSync(join(vault, p), s);
  }
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vault);
  const env = {
    vaultDataPath: vault,
    vaultIngestPath: null,
    vaultDbPath: ':memory:',
    apiToken: TOKEN,
    host: '127.0.0.1',
    port: 0,
    autoReindex: false,
    autoWatch: false,
    watchDebounceMs: 1500,
    embedder: 'fake',
    embedderRetentionMs: 1_800_000,
    embedderMaxBatch: 8,
    autoCommit: false,
    autoPush: false,
    commitIntervalMs: 60000,
    commitIntervalMaxMs: 0,
    workHoursStart: null,
    workHoursEnd: null,
    gitAuthorName: 'vault-storage',
    gitAuthorEmail: 'vault-storage@localhost',
    uiStaticPath: new URL('static/ui', root).pathname,
    embedAnomalyLogPath: '',
    memoryReportIntervalMs: 0
  };
  const handle = await startServer({
    db,
    env,
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const base = `http://127.0.0.1:${handle.server.address().port}`;
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: {width: 1280, height: 900},
      colorScheme: 'light'
    });
    await ctx.addInitScript(t => localStorage.setItem('vault.token', t), TOKEN);
    for (const name of PAGES) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(`${base}/ui/${name}.html`, {waitUntil: 'networkidle'});
      await page.waitForTimeout(800);
      const snap = await page.evaluate(snapshotPage);
      writeFileSync(join(out, `${name}.json`), JSON.stringify(snap));
      console.log(
        `${name}: ${Object.keys(snap).length} elements${errors.length ? `, ${errors.length} page errors` : ''}`
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await handle.close();
    db.close();
    rmSync(vault, {recursive: true, force: true});
  }
};

const diff = (a, b, ignore) => {
  let natural = 0;
  for (const f of readdirSync(a)
    .filter(f => f.endsWith('.json'))
    .sort()) {
    const before = JSON.parse(readFileSync(join(a, f), 'utf8'));
    const after = JSON.parse(readFileSync(join(b, f), 'utf8'));
    const rows = {probe: [], natural: []};
    for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const x = before[p],
        y = after[p];
      if (!x || !y) {
        rows.natural.push(`${p}: ${x ? 'removed' : 'added'}`);
        continue;
      }
      const changed = [];
      for (const k of new Set([...Object.keys(x.css), ...Object.keys(y.css)])) {
        if (!ignore.has(k) && x.css[k] !== y.css[k])
          changed.push(`${k}: ${x.css[k]} → ${y.css[k]}`);
      }
      if (x.rect.join() !== y.rect.join())
        changed.push(`rect: ${x.rect.join(',')} → ${y.rect.join(',')}`);
      if (!changed.length) continue;
      const label = `<${x.tag}${x.cls ? '.' + x.cls.replace(/\s+/g, '.') : ''}>`;
      if (y.probe) rows.probe.push(`${label}: ${changed.length} properties`);
      else rows.natural.push(`${p} ${label}\n      ${changed.join('\n      ')}`);
    }
    natural += rows.natural.length;
    console.log(
      `\n${f.replace('.json', '')}: probe=${rows.probe.length} natural=${rows.natural.length}`
    );
    for (const l of rows.probe) console.log(`  probe ${l}`);
    for (const l of rows.natural) console.log(`  ${l}`);
  }
  console.log(`\nnatural elements differing: ${natural}`);
  return natural;
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'snapshot' && args[0]) {
  await snapshot(args[0]);
} else if (cmd === 'diff' && args[0] && args[1]) {
  const opt = args.find(a => a.startsWith('--ignore='));
  const ignore = new Set(['transform', ...(opt ? opt.slice('--ignore='.length).split(',') : [])]);
  process.exitCode = diff(args[0], args[1], ignore) ? 1 : 0;
} else {
  console.error(
    'usage: ui-style-snapshot.mjs snapshot <dir> | diff <before> <after> [--ignore=prop,prop]'
  );
  process.exitCode = 2;
}
