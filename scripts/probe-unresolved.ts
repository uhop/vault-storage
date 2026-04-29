// One-off probe: enumerate unresolved wikilinks in the live DB.
// Run: VAULT_DATA_PATH=/media/raid/Vault-Data/ node --experimental-strip-types scripts/probe-unresolved.ts
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {WikilinkResolver} from '../src/importer/resolver.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {extractWikilinks, extractRelatedFromFrontmatter} from '../src/markdown/wikilinks.ts';
import type {VaultRecord} from '../src/records/types.ts';

const dataPath = process.env['VAULT_DATA_PATH'] ?? '/media/raid/Vault-Data/';
const dbPath = process.env['VAULT_DB_PATH'] ?? join(dataPath, '.vault-storage', 'vault.sqlite');
const db = new DatabaseSync(dbPath, {readOnly: true});

const rows = db.prepare('SELECT record_id, file_path, parent_path, sequence_key, type, body, content_hash, created, updated, last_referenced, decay_score, status, priority, archived_at FROM records').all() as Array<{record_id: string; file_path: string; parent_path: string | null; sequence_key: number | null; type: string; body: string; content_hash: string; created: string; updated: string; last_referenced: string | null; decay_score: number; status: string; priority: number; archived_at: string | null}>;

const records: VaultRecord[] = rows.map(r => ({
  recordId: r.record_id,
  filePath: r.file_path,
  parentPath: r.parent_path,
  sequenceKey: r.sequence_key,
  type: r.type as VaultRecord['type'],
  body: r.body,
  contentHash: r.content_hash,
  created: r.created,
  updated: r.updated,
  lastReferenced: r.last_referenced,
  decayScore: r.decay_score,
  status: r.status as VaultRecord['status'],
  priority: r.priority,
  archivedAt: r.archived_at,
  title: null
}));

const resolver = new WikilinkResolver(records);

const unresolvedCounts = new Map<string, {count: number; samples: string[]}>();
let totalLinks = 0;
let totalUnresolved = 0;

for (const record of records) {
  const abs = join(dataPath, record.filePath);
  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const {data, body} = parseFrontmatter(source);
  const fmTargets = extractRelatedFromFrontmatter(data);
  const bodyTargets = extractWikilinks(body);

  for (const target of [...fmTargets, ...bodyTargets]) {
    totalLinks++;
    const resolved = resolver.resolve(target);
    if (!resolved) {
      totalUnresolved++;
      const cur = unresolvedCounts.get(target) ?? {count: 0, samples: []};
      cur.count++;
      if (cur.samples.length < 3) cur.samples.push(record.filePath);
      unresolvedCounts.set(target, cur);
    }
  }
}

const sorted = [...unresolvedCounts.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`Total wikilinks: ${totalLinks}`);
console.log(`Unresolved: ${totalUnresolved} (${((totalUnresolved / totalLinks) * 100).toFixed(1)}%)`);
console.log(`Distinct unresolved targets: ${sorted.length}`);
console.log('');
console.log('Top 50 unresolved targets:');
for (const [target, info] of sorted.slice(0, 50)) {
  console.log(`  ${info.count}x  [[${target}]]   e.g. ${info.samples[0]}`);
}

db.close();
