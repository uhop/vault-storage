// The state only the database holds, exported into the vault's repository
// (D121, D122), so a rebuild or an adoption keeps it: the tag taxonomy with
// its aliases, each note's record id by path, and the suggestion decisions a
// rebuild would ask again. Written just before a commit.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {
  DEFAULT_SNOOZE_DAYS,
  snoozeCutoff,
  type SuggestionKind
} from './importer/file-suggestions.ts';

export const STATE_DIR = '.vault-storage-state';

const jsonl = (rows: readonly unknown[]): string =>
  rows.map(row => `${JSON.stringify(row)}\n`).join('');

/** Each tag with its description, origin, date, and aliases, by tag. */
const tagsFile = (db: DatabaseSync): string => {
  const aliases = new Map<string, string[]>();
  for (const {alias, canonical} of db
    .prepare('SELECT alias, canonical FROM tag_aliases ORDER BY alias')
    .all() as {alias: string; canonical: string}[]) {
    const list = aliases.get(canonical);
    if (list) list.push(alias);
    else aliases.set(canonical, [alias]);
  }
  const tags = db
    .prepare('SELECT tag, description, added, origin FROM tags_taxonomy ORDER BY tag')
    .all() as {tag: string; description: string | null; added: string; origin: string}[];
  return jsonl(tags.map(t => ({...t, aliases: aliases.get(t.tag) ?? []})));
};

/** Each note's path and record id, by path. */
const recordsFile = (db: DatabaseSync): string =>
  jsonl(
    (
      db.prepare('SELECT file_path, record_id FROM records ORDER BY file_path').all() as {
        file_path: string;
        record_id: string;
      }[]
    ).map(r => ({path: r.file_path, id: r.record_id}))
  );

const field = (key: string): string => `json_extract(payload, '$.${key}')`;

const LIVE = 'IN (SELECT record_id FROM records)';
const TAG = field('tag');
const RECORD = field('record_id');
const PAIR_A = `min(${field('a_record')}, ${field('b_record')})`;
const PAIR_B = `max(${field('a_record')}, ${field('b_record')})`;

type Columns = ReadonlyArray<readonly [name: string, expression: string]>;

interface DecisionSpec {
  kind: SuggestionKind;
  /** The identity as the filer matches it. */
  identity: Columns;
  /** Values carried beside the identity. */
  carried?: Columns;
  statuses: string;
  /**
   * Kept when this holds of a decision. It tests the identity, or a snooze
   * cutoff that the latest decision passes whenever any does, so it runs
   * before the latest is picked (D122).
   */
  keep: string;
  /** `keep` binds the snooze cutoff to its `?`. */
  snoozed?: boolean;
}

/**
 * Each test is a superset of the filer's own condition, judged on the
 * database alone, so a rebuild never re-asks a decision the file dropped
 * (D122). A tag suggestion's exact test needs the note's frontmatter.
 */
const DECISION_SPECS: readonly DecisionSpec[] = [
  {
    kind: 'archive_candidate',
    identity: [['record_id', 'subject_id']],
    statuses: `'rejected'`,
    keep: `resolved_at >= ? AND subject_id ${LIVE}`,
    snoozed: true
  },
  {
    kind: 'compaction_candidate',
    identity: [['folder_path', field('folder_path')]],
    statuses: `'rejected'`,
    keep: 'resolved_at >= ?',
    snoozed: true
  },
  {
    kind: 'duplicate',
    identity: [
      ['a_record', PAIR_A],
      ['b_record', PAIR_B]
    ],
    statuses: `'accepted', 'rejected'`,
    keep: `${PAIR_A} ${LIVE} AND ${PAIR_B} ${LIVE}`
  },
  ...(['inefficiency_detected', 'infrastructure_upgrade'] as const).map(kind => ({
    kind,
    identity: [['signal', field('signal')]] as const,
    carried: [['current', field('current')]] as const,
    statuses: `'accepted', 'rejected'`,
    keep: 'TRUE'
  })),
  {
    kind: 'new_tag',
    identity: [
      ['tag', TAG],
      ['record_id', RECORD]
    ],
    statuses: `'accepted', 'rejected'`,
    keep: `${RECORD} ${LIVE}
       AND ${TAG} NOT IN (SELECT tag FROM tags_taxonomy)
       AND ${TAG} NOT IN (SELECT alias FROM tag_aliases)`
  },
  {
    kind: 'tag_suggestion',
    identity: [
      ['tag', TAG],
      ['record_id', RECORD]
    ],
    statuses: `'accepted', 'rejected'`,
    keep: `${RECORD} ${LIVE} AND NOT EXISTS (
         SELECT 1 FROM tags t
          WHERE t.record_id = ${RECORD}
            AND t.tag = coalesce((SELECT canonical FROM tag_aliases WHERE alias = ${TAG}), ${TAG}))`
  }
];

const names = (columns: Columns): string => columns.map(([name]) => name).join(', ');

/** Per identity, the latest of `spec.kind`'s decisions that `spec.keep` keeps. */
const decisionsQuery = (spec: DecisionSpec): string => {
  const columns = [...spec.identity, ...(spec.carried ?? [])];
  return `SELECT ${names(columns)}, status, resolved_by, resolved_at
    FROM (SELECT ${columns.map(([name, expr]) => `${expr} AS ${name}`).join(', ')},
                 status, resolved_by, resolved_at,
                 row_number() OVER (PARTITION BY ${spec.identity.map(([, expr]) => expr).join(', ')}
                                    ORDER BY resolved_at DESC, id DESC) AS n
            FROM suggestions
           WHERE kind = '${spec.kind}' AND status IN (${spec.statuses}) AND ${spec.keep})
   WHERE n = 1
   ORDER BY ${names(spec.identity)}`;
};

/** The suggestion decisions a rebuild would ask again, by kind and identity. */
const suggestionsFile = (db: DatabaseSync, now: string): string => {
  const cutoff = snoozeCutoff(now, DEFAULT_SNOOZE_DAYS);
  const lines: unknown[] = [];
  for (const spec of DECISION_SPECS) {
    const params: SQLInputValue[] = spec.snoozed ? [cutoff] : [];
    for (const row of db.prepare(decisionsQuery(spec)).all(...params)) {
      lines.push({kind: spec.kind, ...row});
    }
  }
  return jsonl(lines);
};

const BUILDERS: ReadonlyArray<[string, (db: DatabaseSync, now: string) => string]> = [
  ['tags.jsonl', tagsFile],
  ['records.jsonl', recordsFile],
  ['suggestions.jsonl', suggestionsFile]
];

/** The state files as they should read at `now`, by name within {@link STATE_DIR}. */
export const stateFiles = (
  db: DatabaseSync,
  now: string = new Date().toISOString()
): Map<string, string> => new Map(BUILDERS.map(([name, build]) => [name, build(db, now)]));

/**
 * Write each state file whose content changed; answers the vault-relative
 * paths written. Yields between files: building all three on croc's data
 * takes about 14 ms (D122).
 */
export const exportVaultState = async (
  db: DatabaseSync,
  vaultDataPath: string,
  now: string = new Date().toISOString()
): Promise<string[]> => {
  const dir = join(vaultDataPath, STATE_DIR);
  mkdirSync(dir, {recursive: true});
  const written: string[] = [];
  for (const [name, build] of BUILDERS) {
    const content = build(db, now);
    const path = join(dir, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      writeFileSync(path, content);
      written.push(`${STATE_DIR}/${name}`);
    }
    await nextTurn();
  }
  return written;
};
