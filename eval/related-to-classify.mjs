// The related-to classification harness (queue item "Classify the generic
// related-to edges into real types, and measure whether Jev can do it"):
// labelled pairs from the vault's typed edges and its judged edge_type
// rejections, the related-to population to classify, and three cheap arms
// against a Sonnet reference. Reads the vault through its API (D72) and keeps
// every data file outside the repository.
//
//   node eval/related-to-classify.mjs sample --out <dir> [--per-type 40] [--negatives 100] [--related 100] [--seed 7]
//   node eval/related-to-classify.mjs ask --out <dir> --arm choice|nouls [--set eval|related] [--limit N]
//   node eval/related-to-classify.mjs rules --out <dir>
//   node eval/related-to-classify.mjs reference --out <dir> [--batch 20]     # writes the batches a judge answers
//   node eval/related-to-classify.mjs score --out <dir>
//
// Needs VAULT_API_URL and VAULT_API_TOKEN; `ask` needs TYPESAFE_API_KEY.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const OUT = opt('--out', '');
const MODEL = 'jev-latest';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6;
const CONCURRENCY = 6;
const SUMMARY_MAX = 700;
const THRESHOLDS = [0.5, 0.7, 0.9];

// The stored vocabulary; basis-for is the declaration alias (target derived from source).
export const TYPES = [
  'supersedes',
  'revises',
  'derived-from',
  'caused-by',
  'fixed-by',
  'rejected-because',
  'applies-to',
  'contradicts'
];
const LABELLED_TYPES = TYPES;

// Source-relative descriptions, from the /vault-review-edges table (the same
// text a judging agent reads), phrased as what the source note says of the target.
export const OPTIONS = {
  supersedes:
    'The source replaces or obsoletes the target: it is the newer version, and the target is out of date because of it',
  revises:
    'The source amends or refines the target without replacing it: a correction, an update, or an extension the target should now be read with',
  'derived-from':
    'The source builds on, extends, or is grounded in the target: the target is where its material or idea came from, a strong intellectual debt',
  'basis-for':
    'The target was derived from the source: the source records where its material went, promoted or generalized or captured into the target',
  'caused-by': 'The source describes a state or an outcome that the target produced or explains',
  'fixed-by': 'The source describes a problem that the target resolves',
  'rejected-because':
    'The source records a rejection, a decision not to do something, whose reason is the target',
  'applies-to':
    "The source's content applies to or is relevant to the target's domain: a rule, a finding, or a technique that the target is a case of",
  contradicts: 'The source disagrees with the target: the two make claims that cannot both hold',
  none: 'A loose conceptual link and nothing more specific: the two touch the same subject, one merely refers to the other, or no relation above fits'
};

const DOCUMENT =
  "two notes from one person's knowledge vault: the source note and the target note, each given as its path, its record type, its title, and the summary an agent wrote of it; the vault keeps typed edges from a source note to a target note";

// ─── vault API ──────────────────────────────────────────────────────────────
const vault = async path => {
  const base = process.env.VAULT_API_URL;
  const token = process.env.VAULT_API_TOKEN;
  if (!base || !token) throw new Error('VAULT_API_URL and VAULT_API_TOKEN are required');
  const res = await fetch(base.replace(/\/$/, '') + path, {
    headers: {Authorization: `Bearer ${token}`}
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
const paged = async (path, limit = 100) => {
  const items = [];
  for (let offset = 0; ; offset += limit) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await vault(`${path}${sep}limit=${limit}&offset=${offset}`);
    items.push(...(page.items ?? []));
    if ((page.items ?? []).length < limit) break;
  }
  return items;
};

// ─── files ──────────────────────────────────────────────────────────────────
const need = () => {
  if (!OUT) {
    process.stderr.write('--out <dir> is required\n');
    process.exit(2);
  }
  mkdirSync(OUT, {recursive: true});
};
const readJson = name => JSON.parse(readFileSync(join(OUT, name), 'utf8'));
const writeJson = (name, data) =>
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 1) + '\n');

// Mulberry32: a seeded shuffle so the sample is reproducible.
const rng = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = (arr, random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; --i) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ─── sample ─────────────────────────────────────────────────────────────────
const sample = async () => {
  need();
  const perType = Number(opt('--per-type', 40));
  const negatives = Number(opt('--negatives', 100));
  const relatedN = Number(opt('--related', 100));
  const random = rng(Number(opt('--seed', 7)));

  process.stderr.write('records…\n');
  const records = await paged('/sections?fields=record_id,file_path,title,type,agent_summary');
  const byId = new Map(records.map(r => [r.record_id, r]));

  const typed = [];
  for (const type of LABELLED_TYPES) {
    const edges = await paged(`/edges?type=${type}`);
    for (const e of edges)
      typed.push({from: e.from.record_id, to: e.to.record_id, label: type, source: 'edge'});
    process.stderr.write(`${type}: ${edges.length}\n`);
  }

  process.stderr.write('rejected edge_type suggestions…\n');
  const rejected = await paged('/suggestions?kind=edge_type&status=rejected');
  const judged = rejected.filter(s => /^sweep-|^agent|^nuke\/|^croc\//.test(s.resolved_by ?? ''));
  const negs = judged.map(s => ({
    from: s.payload.from_record,
    to: s.payload.to_record,
    label: 'none',
    source: `reject:${s.resolved_by}`
  }));
  process.stderr.write(`rejected ${rejected.length}, judged ${judged.length}\n`);

  process.stderr.write('related-to…\n');
  const related = await paged('/edges?type=related-to');

  const known = p => byId.has(p.from) && byId.has(p.to) && p.from !== p.to;
  const evalPairs = [];
  for (const type of LABELLED_TYPES) {
    const pool = shuffle(
      typed.filter(p => p.label === type && known(p)),
      random
    );
    evalPairs.push(...pool.slice(0, perType));
  }
  evalPairs.push(...shuffle(negs.filter(known), random).slice(0, negatives));
  const relatedPairs = shuffle(
    related
      .map(e => ({from: e.from.record_id, to: e.to.record_id, label: null, source: 'related-to'}))
      .filter(known),
    random
  ).slice(0, relatedN);

  const brief = id => {
    const r = byId.get(id);
    return {
      record_id: id,
      path: r.file_path,
      type: r.type,
      title: r.title,
      summary: (r.agent_summary ?? '').slice(0, SUMMARY_MAX)
    };
  };
  const withIds = (pairs, prefix) =>
    pairs.map((p, i) => ({
      id: `${prefix}${i}`,
      ...p,
      source_note: brief(p.from),
      target_note: brief(p.to)
    }));
  const out = {
    built_at: new Date().toISOString(),
    counts: {
      records: records.length,
      typed: Object.fromEntries(
        LABELLED_TYPES.map(t => [t, typed.filter(p => p.label === t).length])
      ),
      rejected: rejected.length,
      judged_rejections: judged.length,
      related_to: related.length
    },
    eval: withIds(evalPairs, 'e'),
    related: withIds(relatedPairs, 'r')
  };
  writeJson('sample.json', out);
  process.stderr.write(
    `eval ${out.eval.length} pairs (${LABELLED_TYPES.map(t => `${t} ${out.eval.filter(p => p.label === t).length}`).join(', ')}, none ${out.eval.filter(p => p.label === 'none').length}); related ${out.related.length}\n`
  );
};

// ─── Jev ────────────────────────────────────────────────────────────────────
const stateOf = p => ({document: DOCUMENT, source_note: p.source_note, target_note: p.target_note});

const questionsFor = arm => {
  if (arm === 'choice') {
    return {
      relation: {
        type: 'choice',
        instructions: 'How does the source note relate to the target note?',
        criteria: OPTIONS
      }
    };
  }
  const q = {};
  for (const [type, text] of Object.entries(OPTIONS)) {
    if (type === 'none') continue;
    q[type] = {
      type: 'noul',
      instructions: `Does the source note relate to the target note this way: ${text}?`,
      criteria: {true: text, false: OPTIONS.none}
    };
  }
  return q;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const askOne = async (key, state, questions) => {
  const body = JSON.stringify({state, model: MODEL, questions});
  let delay = 500;
  for (let attempt = 0; ; ++attempt) {
    const t0 = performance.now();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body
    });
    const ms = performance.now() - t0;
    const text = await res.text();
    if (res.ok) return {status: res.status, ms, response: JSON.parse(text)};
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    return {status: res.status, ms, error: text.slice(0, 2000)};
  }
};

const ask = async () => {
  need();
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    process.stderr.write('TYPESAFE_API_KEY is not set\n');
    process.exit(2);
  }
  const arm = opt('--arm', '');
  if (arm !== 'choice' && arm !== 'nouls') {
    process.stderr.write('--arm choice|nouls\n');
    process.exit(2);
  }
  const set = opt('--set', 'eval');
  const limit = Number(opt('--limit', 0));
  const pairs = readJson('sample.json')[set];
  const todo = limit ? pairs.slice(0, limit) : pairs;
  const questions = questionsFor(arm);
  const out = [];
  const t0 = performance.now();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const p = todo[i];
      const r = await askOne(key, stateOf(p), questions);
      const answers = r.response?.answers ?? {};
      out[i] = {
        id: p.id,
        status: r.status,
        ms: Math.round(r.ms),
        tokens: r.response?.usage?.input_tokens ?? 0,
        ...(arm === 'choice'
          ? {
              choice: answers.relation?.choice ?? null,
              probabilities: answers.relation?.probabilities ?? null,
              confidence: answers.relation?.confidence ?? null
            }
          : {nouls: Object.fromEntries(Object.entries(answers).map(([t, a]) => [t, a.noul]))}),
        ...(r.error ? {error: r.error} : {})
      };
      if ((i + 1) % 25 === 0) process.stderr.write(`${i + 1}/${todo.length}\n`);
    }
  };
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  const wall = performance.now() - t0;
  const tokens = out.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const lat = out.map(r => r.ms).sort((a, b) => a - b);
  const pct = q => lat[Math.min(lat.length - 1, Math.floor((q / 100) * lat.length))];
  writeJson(`answers-${arm}-${set}.json`, {
    model: MODEL,
    arm,
    set,
    asked_at: new Date().toISOString(),
    wall_ms: Math.round(wall),
    concurrency: CONCURRENCY,
    tokens,
    cost_usd: tokens * PRICE_PER_INPUT_TOKEN,
    results: out
  });
  process.stderr.write(
    `${arm}/${set}: ${out.length} asked, ${out.filter(r => r.error).length} errors, ${tokens} tokens ($${(tokens * PRICE_PER_INPUT_TOKEN).toFixed(4)}), wall ${(wall / 1000).toFixed(1)}s, p50 ${pct(50)}ms p95 ${pct(95)}ms\n`
  );
};

// ─── rules: the majority label per (source type, target type) pair, fitted on
// the labelled pairs outside the eval sample ─────────────────────────────────
const rules = async () => {
  need();
  const s = readJson('sample.json');
  const evalIds = new Set(s.eval.map(p => `${p.from}|${p.to}`));
  const records = await paged('/sections?fields=record_id,type');
  const typeOf = new Map(records.map(r => [r.record_id, r.type]));
  const table = new Map();
  for (const type of LABELLED_TYPES) {
    for (const e of await paged(`/edges?type=${type}`)) {
      if (evalIds.has(`${e.from.record_id}|${e.to.record_id}`)) continue;
      const k = `${typeOf.get(e.from.record_id)}→${typeOf.get(e.to.record_id)}`;
      const m = table.get(k) ?? new Map();
      m.set(type, (m.get(type) ?? 0) + 1);
      table.set(k, m);
    }
  }
  const majority = {};
  for (const [k, m] of table) {
    const [best, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    majority[k] = {type: best, share: n / total, n: total};
  }
  const predict = pairs =>
    pairs.map(p => {
      const k = `${p.source_note.type}→${p.target_note.type}`;
      const m = majority[k];
      return {
        id: p.id,
        key: k,
        choice: m && m.share >= 0.5 && m.n >= 5 ? m.type : 'none',
        prior: m ?? null
      };
    });
  writeJson('answers-rules.json', {
    fitted_at: new Date().toISOString(),
    table: majority,
    eval: predict(s.eval),
    related: predict(s.related)
  });
  process.stderr.write(`rules: ${Object.keys(majority).length} record-type pairs in the table\n`);
};

// ─── reference: batches for a judging agent, answered as {id: type} ─────────
const reference = () => {
  need();
  const s = readJson('sample.json');
  const batch = Number(opt('--batch', 20));
  const pairs = [...s.eval, ...s.related];
  const batches = [];
  for (let i = 0; i < pairs.length; i += batch) {
    batches.push(
      pairs
        .slice(i, i + batch)
        .map(p => ({id: p.id, source_note: p.source_note, target_note: p.target_note}))
    );
  }
  batches.forEach((b, i) => writeJson(`reference-batch-${i}.json`, {options: OPTIONS, pairs: b}));
  process.stderr.write(
    `${batches.length} batches of up to ${batch} pairs; answers go in reference-answers.json as {id: type}\n`
  );
};

// ─── score ──────────────────────────────────────────────────────────────────
const canon = t => (t === 'basis-for' ? 'basis-for' : t);
const confusion = (pairs, predict) => {
  const labels = [...LABELLED_TYPES, 'none'];
  const m = {};
  for (const l of labels)
    m[l] = Object.fromEntries([...labels, 'basis-for', 'other'].map(x => [x, 0]));
  for (const p of pairs) {
    const pred = predict(p);
    const col =
      pred === null ? 'other' : labels.includes(pred) || pred === 'basis-for' ? pred : 'other';
    m[p.label][col]++;
  }
  return m;
};
const perType = (pairs, predict) => {
  const out = {};
  for (const t of [...LABELLED_TYPES, 'none']) {
    let tp = 0,
      fp = 0,
      fn = 0;
    for (const p of pairs) {
      const pred = canon(predict(p));
      if (pred === t && p.label === t) tp++;
      else if (pred === t) fp++;
      else if (p.label === t) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    out[t] = {tp, fp, fn, precision, recall};
  }
  const correct = pairs.filter(p => canon(predict(p)) === p.label).length;
  return {accuracy: correct / pairs.length, n: pairs.length, types: out};
};

const score = () => {
  need();
  const s = readJson('sample.json');
  const byId = new Map(s.eval.map(p => [p.id, p]));
  const arms = {};
  const load = name => (existsSync(join(OUT, name)) ? readJson(name) : null);

  const choice = load('answers-choice-eval.json');
  if (choice) {
    const ans = new Map(choice.results.map(r => [r.id, r]));
    arms.choice = {
      ...perType(s.eval, p => ans.get(p.id)?.choice ?? null),
      confusion: confusion(s.eval, p => ans.get(p.id)?.choice ?? null),
      cost_usd: choice.cost_usd,
      wall_ms: choice.wall_ms
    };
    for (const th of THRESHOLDS) {
      const pick = p => {
        const a = ans.get(p.id);
        if (!a?.choice) return null;
        return (a.probabilities?.[a.choice] ?? 0) >= th ? a.choice : 'none';
      };
      arms[`choice≥${th}`] = perType(s.eval, pick);
    }
  }
  const nouls = load('answers-nouls-eval.json');
  if (nouls) {
    const ans = new Map(nouls.results.map(r => [r.id, r]));
    for (const th of THRESHOLDS) {
      const pick = p => {
        const a = ans.get(p.id)?.nouls;
        if (!a) return null;
        const [best, v] = Object.entries(a).sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
        return v >= th ? best : 'none';
      };
      arms[`nouls≥${th}`] = {
        ...perType(s.eval, pick),
        ...(th === 0.5 ? {confusion: confusion(s.eval, pick)} : {})
      };
    }
    arms['nouls≥0.5'].cost_usd = nouls.cost_usd;
    arms['nouls≥0.5'].wall_ms = nouls.wall_ms;
  }
  const rulesAns = load('answers-rules.json');
  if (rulesAns) {
    const ans = new Map(rulesAns.eval.map(r => [r.id, r.choice]));
    arms.rules = {
      ...perType(s.eval, p => ans.get(p.id) ?? 'none'),
      confusion: confusion(s.eval, p => ans.get(p.id) ?? 'none')
    };
  }
  const ref = load('reference-answers.json');
  if (ref) {
    arms.reference = {
      ...perType(
        s.eval.filter(p => p.id in ref),
        p => ref[p.id] ?? null
      ),
      confusion: confusion(
        s.eval.filter(p => p.id in ref),
        p => ref[p.id] ?? null
      )
    };
  }
  const floor = {...perType(s.eval, () => 'none')};
  arms['always-none'] = floor;

  // The related-to population: what each arm proposes, and agreement with the reference.
  const related = {};
  const dist = pick => {
    const d = {};
    for (const p of s.related) {
      const c = canon(pick(p)) ?? 'unanswered';
      d[c] = (d[c] ?? 0) + 1;
    }
    return d;
  };
  const choiceR = load('answers-choice-related.json');
  if (choiceR) {
    const ans = new Map(choiceR.results.map(r => [r.id, r]));
    related.choice = dist(p => ans.get(p.id)?.choice ?? null);
    related['choice≥0.7'] = dist(p => {
      const a = ans.get(p.id);
      return a?.choice && (a.probabilities?.[a.choice] ?? 0) >= 0.7 ? a.choice : 'none';
    });
    if (ref) {
      const both = s.related.filter(p => p.id in ref && ans.get(p.id)?.choice);
      related.choice_vs_reference = {
        n: both.length,
        agree: both.filter(p => canon(ans.get(p.id).choice) === canon(ref[p.id])).length
      };
    }
  }
  const noulsR = load('answers-nouls-related.json');
  if (noulsR) {
    const ans = new Map(noulsR.results.map(r => [r.id, r]));
    related['nouls≥0.7'] = dist(p => {
      const a = ans.get(p.id)?.nouls;
      if (!a) return null;
      const [best, v] = Object.entries(a).sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
      return v >= 0.7 ? best : 'none';
    });
  }
  if (rulesAns)
    related.rules = dist(
      p => new Map(rulesAns.related.map(r => [r.id, r.choice])).get(p.id) ?? 'none'
    );
  if (ref) related.reference = dist(p => ref[p.id] ?? null);

  const report = {
    scored_at: new Date().toISOString(),
    counts: s.counts,
    eval_n: s.eval.length,
    arms,
    related
  };
  writeJson('score.json', report);
  const row = (name, a) =>
    `${name.padEnd(14)} acc ${(a.accuracy * 100).toFixed(1).padStart(5)}%  ` +
    [...LABELLED_TYPES, 'none']
      .map(t => {
        const x = a.types[t];
        const f = v => (v === null ? '  – ' : (v * 100).toFixed(0).padStart(3) + '%');
        return `${t.slice(0, 8)} P${f(x.precision)}/R${f(x.recall)}`;
      })
      .join('  ');
  process.stdout.write(
    Object.entries(arms)
      .map(([n, a]) => row(n, a))
      .join('\n') + '\n'
  );
  process.stdout.write('related-to proposals: ' + JSON.stringify(related) + '\n');
};

const main = async () => {
  if (cmd === 'sample') return sample();
  if (cmd === 'ask') return ask();
  if (cmd === 'rules') return rules();
  if (cmd === 'reference') return reference();
  if (cmd === 'score') return score();
  process.stderr.write(
    'usage: related-to-classify.mjs sample|ask|rules|reference|score --out <dir> …\n'
  );
  process.exit(2);
};
main().catch(e => {
  process.stderr.write(String(e.stack ?? e) + '\n');
  process.exit(1);
});
