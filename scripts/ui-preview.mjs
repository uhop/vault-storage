#!/usr/bin/env node
// Screenshot preview of the UI pages over a copy of the live vault's state documents:
// an in-process server on a fixture directory, one shot per spec, and for each shot the
// horizontal overflow, page errors, console errors, every response of 400 or above, and every
// request the page's <head> started that `api()` never adopted (a URL out of step with the page).
// `ui-style-snapshot.mjs` answers a different question (computed styles over synthetic
// fixtures, for CSS diffs); this shows what a change looks like on real data at any width.
//   node scripts/ui-preview.mjs fixture <dir>    # copy state documents from VAULT_API_URL (read-only GETs)
//   node scripts/ui-preview.mjs shoot <fixture> <out> [--measure=SELECTOR] [SHOT ...]
// A SHOT is name|path|width|scheme[|hover selector], e.g. fleet-400|fleet.html?view=packages|400|light;
// --measure prints the selector's top offset per shot. The fixture is live vault content:
// keep it in a scratch directory, never in the repository (the fixture command refuses one).
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import pw from 'playwright';

const root = new URL('..', import.meta.url);
const TOKEN = 'preview-token';
const DEFAULT_SHOTS = [
  'fleet-1280|fleet.html|1280|light',
  'fleet-packages-400|fleet.html?view=packages|400|light',
  'projects-400|projects.html|400|light',
  'index-1280|index.html|1280|dark',
  'search-400|search.html|400|light',
  'tags-1280|tags.html|1280|light',
  'agents-1280|agents.html|1280|light'
];

const usage = () => {
  console.error(
    'usage: ui-preview.mjs fixture <dir> | shoot <fixture> <out> [--measure=SELECTOR] [SHOT ...]'
  );
  process.exit(2);
};

const insideRepo = dir => (resolve(dir) + sep).startsWith(resolve(fileURLToPath(root)) + sep);

const fixture = async dir => {
  const {VAULT_API_URL: base, VAULT_API_TOKEN: token} = process.env;
  if (!base || !token) {
    console.error('ui-preview: VAULT_API_URL and VAULT_API_TOKEN must be set');
    process.exit(2);
  }
  if (insideRepo(dir)) {
    console.error('ui-preview: the fixture is live vault content — keep it outside the repository');
    process.exit(2);
  }
  const get = async path => {
    const r = await fetch(`${base}/vault/${path}`, {headers: {Authorization: `Bearer ${token}`}});
    return r.status === 200 ? r.text() : null;
  };
  const copied = new Set();
  const copy = async (path, wanted) => {
    if (copied.has(path)) return;
    const text = await get(path);
    if (text === null || !wanted(text)) return;
    mkdirSync(join(dir, dirname(path)), {recursive: true});
    writeFileSync(join(dir, path), text);
    copied.add(path);
  };
  const listing = JSON.parse((await get('projects/')) ?? '{"files": []}');
  const hasBlock = text => /^## (?:GitHub|Packages)\s*$/m.test(text);
  for (const entry of listing.files) {
    if (!entry.endsWith('/')) continue;
    await copy(`projects/${entry}state.md`, hasBlock);
    // projects.html probes every project's queue; a project with one on the live vault has one here.
    await copy(`projects/${entry}queue.md`, () => true);
  }
  await copy('projects/agent-workflow/fleet-status.md', () => true);
  await copy('projects/agent-workflow/state.md', () => true);
  console.log(`fixture: ${copied.size} documents in ${dir}`);
};

const parseShot = spec => {
  const [name, path, width, scheme, hover] = spec.split('|');
  const w = Number(width);
  if (!name || !path || !Number.isInteger(w) || w <= 0 || !['light', 'dark'].includes(scheme))
    usage();
  return {name, path, width: w, scheme, hover: hover || null};
};

const shoot = async (fixtureDir, out, measure, shots) => {
  const {openDatabase} = await import(new URL('src/db/connection.ts', root));
  const {runMigrations} = await import(new URL('src/db/migrate.ts', root));
  const {FakeEmbedder} = await import(new URL('src/embeddings/fake.ts', root));
  const {importVault} = await import(new URL('src/importer/import.ts', root));
  const {startServer} = await import(new URL('src/server/server.ts', root));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  // The importer reports every unknown tag on stderr, one line per fixture file; the
  // fixture's tags are the live vault's, so the report is noise here.
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    importVault(db, fixtureDir);
  } finally {
    process.stderr.write = stderrWrite;
  }
  const env = {
    vaultDataPath: fixtureDir,
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
  mkdirSync(out, {recursive: true});
  const browser = await pw.chromium.launch();
  let failed = 0;
  try {
    for (const shot of shots) {
      const ctx = await browser.newContext({
        viewport: {width: shot.width, height: 900},
        colorScheme: shot.scheme
      });
      await ctx.addInitScript(t => localStorage.setItem('vault.token', t), TOKEN);
      const page = await ctx.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      const responses = [];
      page.on('pageerror', e => pageErrors.push(String(e)));
      page.on('console', m => {
        // A failed resource is reported once, from the response list, with its URL.
        if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
          consoleErrors.push(m.text());
      });
      page.on('response', r => {
        if (r.status() >= 400) responses.push(`${r.status()} ${r.url().replace(base, '')}`);
      });
      let overflow = null;
      let measured = null;
      let unadopted = [];
      try {
        await page.goto(`${base}/ui/${shot.path}`, {waitUntil: 'networkidle'});
        await page.waitForTimeout(800);
        unadopted = await page.evaluate(() => [...(window.__early?.keys() ?? [])]);
        if (shot.hover) {
          await page.hover(shot.hover);
          await page.waitForTimeout(300);
        }
        overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        if (measure) {
          measured = await page.evaluate(sel => {
            const el = document.querySelector(sel);
            return el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null;
          }, measure);
        }
        await page.screenshot({path: join(out, `${shot.name}.png`), fullPage: true});
      } catch (err) {
        pageErrors.push(err instanceof Error ? err.message : String(err));
      }
      const problems =
        pageErrors.length + consoleErrors.length + responses.length + unadopted.length;
      if (problems > 0) ++failed;
      console.log(
        `${shot.name}: ${shot.width}px ${shot.scheme}, overflow ${overflow}px` +
          (measure ? `, ${measure} top ${measured}` : '') +
          (problems > 0 ? '' : ', clean')
      );
      for (const e of pageErrors) console.log(`  page error: ${e}`);
      for (const e of consoleErrors) console.log(`  console error: ${e}`);
      for (const r of responses) console.log(`  response: ${r}`);
      for (const u of unadopted) console.log(`  head request never adopted: ${u}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await handle.close();
    db.close();
  }
  console.log(
    `ui-preview: ${shots.length} shots in ${out}` + (failed > 0 ? `, ${failed} with problems` : '')
  );
  process.exit(failed > 0 ? 1 : 0);
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'fixture' && args.length === 1) {
  await fixture(args[0]);
} else if (cmd === 'shoot' && args.length >= 2) {
  const [fixtureDir, out, ...rest] = args;
  const flags = rest.filter(a => a.startsWith('--'));
  const measureFlag = flags.find(a => a.startsWith('--measure='));
  if (flags.some(a => !a.startsWith('--measure='))) usage();
  const specs = rest.filter(a => !a.startsWith('--'));
  await shoot(
    fixtureDir,
    out,
    measureFlag ? measureFlag.slice('--measure='.length) : null,
    (specs.length > 0 ? specs : DEFAULT_SHOTS).map(parseShot)
  );
} else {
  usage();
}
