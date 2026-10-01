// The state only the database holds, exported into the vault's repository
// (D121, D122), so a rebuild or an adoption keeps it: the tag taxonomy with
// its aliases, each note's record id by path, and the suggestion decisions a
// rebuild would ask again. Written just before a commit, and read back into a
// fresh database before its first import (D123).

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {
  DEFAULT_SNOOZE_DAYS,
  PAYLOAD_PATHS,
  snoozeCutoff,
  SuggestionFiler,
  type KindPayloads,
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

const SEED_HINT = `fix the line, or move ${STATE_DIR}/ aside to start without the saved state`;

const lineError = (name: string, line: number, message: string, cause?: unknown): SyntaxError =>
  new SyntaxError(
    `${STATE_DIR}/${name}:${line}: ${message}; ${SEED_HINT}`,
    cause === undefined ? undefined : {cause}
  );

interface StateLine<T> {
  line: number;
  value: T;
}

/**
 * Each line of a state file read through `parse`, which names what is wrong
 * with a line; null when the file is absent.
 */
const readStateFile = <T>(
  dir: string,
  name: string,
  parse: (value: Record<string, unknown>) => T | string
): StateLine<T>[] | null => {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const lines: StateLine<T>[] = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (!text) return;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (err) {
        throw lineError(name, i + 1, 'not JSON', err);
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw lineError(name, i + 1, 'not an object');
      }
      const parsed = parse(value as Record<string, unknown>);
      if (typeof parsed === 'string') throw lineError(name, i + 1, parsed);
      lines.push({line: i + 1, value: parsed});
    });
  return lines;
};

const isString = (value: unknown): value is string => typeof value === 'string';

interface TagLine {
  tag: string;
  description: string | null;
  added: string;
  origin: string;
  aliases: string[];
}

const parseTag = ({tag, description, added, origin, aliases}: Record<string, unknown>) => {
  if (!isString(tag) || !isString(added) || !isString(origin)) {
    return 'tag, added, and origin must be strings';
  }
  if (description !== null && !isString(description)) {
    return 'description must be a string or null';
  }
  if (!Array.isArray(aliases) || !aliases.every(isString)) {
    return 'aliases must be an array of strings';
  }
  return {tag, description, added, origin, aliases} satisfies TagLine;
};

const parseRecord = ({path, id}: Record<string, unknown>) =>
  isString(path) && isString(id) ? {path, id} : 'path and id must be strings';

const SPECS_BY_KIND = new Map(DECISION_SPECS.map(spec => [spec.kind, spec]));

interface DecisionLine {
  kind: SuggestionKind;
  fields: Record<string, string | number | null>;
  status: 'accepted' | 'rejected';
  by: string | null;
  at: string;
}

const parseDecision = (line: Record<string, unknown>): DecisionLine | string => {
  const spec = SPECS_BY_KIND.get(line['kind'] as SuggestionKind);
  if (!spec) return `unknown kind: ${String(line['kind'])}`;
  const fields: DecisionLine['fields'] = {};
  for (const [name] of spec.identity) {
    const value = line[name];
    if (!isString(value)) return `${name} must be a string`;
    fields[name] = value;
  }
  for (const [name] of spec.carried ?? []) {
    const value = line[name];
    if (value !== null && typeof value !== 'number') return `${name} must be a number or null`;
    fields[name] = value;
  }
  const {status, resolved_by: by, resolved_at: at} = line;
  if (status !== 'accepted' && status !== 'rejected') return 'status must be accepted or rejected';
  if (by !== null && !isString(by)) return 'resolved_by must be a string or null';
  if (!isString(at)) return 'resolved_at must be a string';
  return {kind: spec.kind, fields, status, by, at};
};

export interface SeedSummary {
  tags: number;
  aliases: number;
  records: number;
  decisions: number;
}

/**
 * Read the state files into a fresh database, one with no records and no
 * suggestions, before its first import (D123): the taxonomy and its aliases
 * replaced, each path's record id kept for the import to take, and each
 * decision filed already resolved. Null when the database is not fresh or
 * the vault has no saved state; a line it cannot read throws before anything
 * is written.
 */
export const seedVaultState = (db: DatabaseSync, vaultDataPath: string): SeedSummary | null => {
  const dir = join(vaultDataPath, STATE_DIR);
  if (!existsSync(dir)) return null;
  const {used} = db
    .prepare('SELECT EXISTS (SELECT 1 FROM records) OR EXISTS (SELECT 1 FROM suggestions) AS used')
    .get() as {used: number};
  if (used) return null;

  const tags = readStateFile(dir, 'tags.jsonl', parseTag);
  const records = readStateFile(dir, 'records.jsonl', parseRecord) ?? [];
  const decisions = readStateFile(dir, 'suggestions.jsonl', parseDecision) ?? [];
  const pathById = new Map(records.map(({value}) => [value.id, value.path]));
  const summary: SeedSummary = {tags: 0, aliases: 0, records: 0, decisions: 0};

  const each = <T>(name: string, lines: StateLine<T>[], write: (value: T) => void): void => {
    for (const {line, value} of lines) {
      try {
        write(value);
      } catch (err) {
        throw lineError(name, line, (err as Error).message, err);
      }
    }
  };

  db.exec('BEGIN');
  try {
    if (tags) {
      db.exec('DELETE FROM tag_aliases; DELETE FROM tags_taxonomy');
      const tag = db.prepare(
        'INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES (?, ?, ?, ?)'
      );
      each('tags.jsonl', tags, t => {
        tag.run(t.tag, t.description, t.added, t.origin);
        ++summary.tags;
      });
      const alias = db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)');
      each('tags.jsonl', tags, t => {
        for (const a of t.aliases) {
          alias.run(a, t.tag);
          ++summary.aliases;
        }
      });
    }

    const id = db.prepare('INSERT INTO seeded_record_ids (file_path, record_id) VALUES (?, ?)');
    each('records.jsonl', records, r => {
      id.run(r.path, r.id);
      ++summary.records;
    });

    const filers = new Map<SuggestionKind, SuggestionFiler>();
    each('suggestions.jsonl', decisions, d => {
      let filer = filers.get(d.kind);
      if (!filer) filers.set(d.kind, (filer = new SuggestionFiler(db, d.kind)));
      const payload: Record<string, unknown> = {...d.fields};
      for (const {kinds, idField, pathField} of PAYLOAD_PATHS) {
        const path = kinds.includes(d.kind) && pathById.get(String(d.fields[idField]));
        if (path) payload[pathField] = path;
      }
      if (
        filer.file(payload as unknown as KindPayloads[SuggestionKind], d.at, {
          resolved: {status: d.status, by: d.by}
        })
      ) {
        ++summary.decisions;
      }
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return summary;
};

/** Drop the seeded record ids no import took, paths with no note (D123); answers how many. */
export const dropSeededIds = (db: DatabaseSync): number =>
  Number(db.prepare('DELETE FROM seeded_record_ids').run().changes);
