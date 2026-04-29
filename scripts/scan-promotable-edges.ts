// One-off: scan every body wikilink in the live DB for broader keyword cues
// than the strict classifier matches. Outputs candidate (source, target, suggestedType, snippet)
// rows for human/LLM review.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {WikilinkResolver} from '../src/importer/resolver.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {maskCodeRegions} from '../src/markdown/wikilinks.ts';
import type {VaultRecord} from '../src/records/types.ts';

const dataPath = process.env['VAULT_DATA_PATH'] ?? '/media/raid/Vault-Data/';
const dbPath = process.env['VAULT_DB_PATH'] ?? join(dataPath, '.vault-storage', 'vault.sqlite');
const db = new DatabaseSync(dbPath, {readOnly: true});

const rows = db.prepare('SELECT record_id, file_path, parent_path, sequence_key, type, body, content_hash, created, updated, last_referenced, decay_score, status, priority, archived_at FROM records').all() as Array<{record_id: string; file_path: string; parent_path: string | null; sequence_key: number | null; type: string; body: string; content_hash: string; created: string; updated: string; last_referenced: string | null; decay_score: number; status: string; priority: number; archived_at: string | null}>;

const records: VaultRecord[] = rows.map(r => ({
  recordId: r.record_id, filePath: r.file_path, parentPath: r.parent_path,
  sequenceKey: r.sequence_key, type: r.type as VaultRecord['type'], body: r.body,
  contentHash: r.content_hash, created: r.created, updated: r.updated,
  lastReferenced: r.last_referenced, decayScore: r.decay_score,
  status: r.status as VaultRecord['status'], priority: r.priority,
  archivedAt: r.archived_at, title: null
}));

const resolver = new WikilinkResolver(records);
const recordById = new Map(records.map(r => [r.recordId, r]));

// Broader patterns than classify-wikilinks.ts. Tune the windows so we catch the cue
// even when phrased loosely ("which supersedes [[X]]", "→ [[X]]" after a finding, etc.).
type Pattern = {type: string; re: RegExp; side: 'pre' | 'post'};
const PATTERNS: Pattern[] = [
  // supersedes / replaces — strong cues
  {type: 'supersedes', side: 'pre', re: /\b(?:supersedes?|superseded by|replaces?|replaced by|obsoletes?)\s*$/i},
  {type: 'supersedes', side: 'post', re: /^\s*(?:supersedes?|replaces?|obsoletes?)\b/i},
  {type: 'supersedes', side: 'pre', re: /\b(?:in favor of|in favour of)\s*$/i},

  // revises — refines, amends, clarifies
  {type: 'revises', side: 'pre', re: /\b(?:revises?|refines?|amends?|clarifies)\s*$/i},
  {type: 'revises', side: 'post', re: /^\s*(?:revises?|refines?|amends?|clarifies)\b/i},

  // derived-from
  {type: 'derived-from', side: 'pre', re: /\b(?:derived from|based on|builds on|builds upon|extracted from|extends|extending|follows from|informed by|drawn from|distilled from|inherits from)\s*$/i},
  {type: 'derived-from', side: 'post', re: /^\s*(?:is derived from|builds on|extends)\b/i},

  // caused-by
  {type: 'caused-by', side: 'pre', re: /\b(?:caused by|triggered by|provoked by|due to|because of|resulting from|stemming from|root cause:?)\s*$/i},

  // fixed-by
  {type: 'fixed-by', side: 'pre', re: /\b(?:fixed by|resolved by|patched by|addressed by|closed by)\s*$/i},
  {type: 'fixed-by', side: 'post', re: /^\s*(?:fixes?|resolves?|addresses?|closes?)\b/i},

  // rejected-because
  {type: 'rejected-because', side: 'pre', re: /\b(?:rejected because|rejected because of|rejected in favor of|abandoned in favor of|ruled out by)\s*$/i},

  // applies-to
  {type: 'applies-to', side: 'pre', re: /\b(?:applies to|relevant to|applicable to|governs|governing)\s*$/i},
  {type: 'applies-to', side: 'post', re: /^\s*(?:applies to|is relevant to|governs)\b/i},

  // contradicts
  {type: 'contradicts', side: 'pre', re: /\b(?:contradicts?|disagrees with|conflicts with|inconsistent with|tension with|in tension with)\s*$/i},
  {type: 'contradicts', side: 'post', re: /^\s*(?:contradicts?|disagrees with|conflicts with)\b/i}
];

const WIKILINK_RE = /\[\[([^\]\n|[]+?)(?:\|[^\]]*)?\]\]/g;
const W_BEFORE = 80;
const W_AFTER = 60;

interface Candidate {
  fromPath: string;
  toPath: string;
  suggested: string;
  snippet: string;
  pattern: string;
}

const candidates: Candidate[] = [];
let scanned = 0;

for (const record of records) {
  const abs = join(dataPath, record.filePath);
  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const {body} = parseFrontmatter(source);
  const masked = maskCodeRegions(body);

  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (!target || target.startsWith('#')) continue;
    scanned++;

    const at = m.index ?? 0;
    const before = body.slice(Math.max(0, at - W_BEFORE), at);
    const after = body.slice(at + m[0].length, at + m[0].length + W_AFTER);
    const beforeMasked = masked.slice(Math.max(0, at - W_BEFORE), at);
    const afterMasked = masked.slice(at + m[0].length, at + m[0].length + W_AFTER);

    const resolved = resolver.resolve(target);
    if (!resolved || resolved === record.recordId) continue;

    for (const p of PATTERNS) {
      const ctx = p.side === 'pre' ? beforeMasked : afterMasked;
      if (p.re.test(ctx)) {
        const toRecord = recordById.get(resolved);
        candidates.push({
          fromPath: record.filePath,
          toPath: toRecord?.filePath ?? '<unknown>',
          suggested: p.type,
          pattern: p.re.source,
          snippet: `…${before.replace(/\s+/g, ' ').slice(-60)}[[${target}]]${after.replace(/\s+/g, ' ').slice(0, 40)}…`
        });
        break;
      }
    }
  }
}

console.log(`Scanned ${scanned} body wikilinks, found ${candidates.length} promotion candidates.\n`);

const byType = new Map<string, number>();
for (const c of candidates) byType.set(c.suggested, (byType.get(c.suggested) ?? 0) + 1);
console.log('By suggested type:');
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${n}`);
}
console.log('');

console.log('Candidates:');
for (const c of candidates) {
  console.log(`[${c.suggested}] ${c.fromPath} → ${c.toPath}`);
  console.log(`  ${c.snippet}`);
}

db.close();
