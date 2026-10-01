// The state only the database holds, exported into the vault's repository
// (D121), so a rebuild or an adoption keeps it: the tag taxonomy with its
// aliases, and each note's record id by path. Written just before a commit.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';

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

const BUILDERS: ReadonlyArray<[string, (db: DatabaseSync) => string]> = [
  ['tags.jsonl', tagsFile],
  ['records.jsonl', recordsFile]
];

/** The state files as they should read now, by name within {@link STATE_DIR}. */
export const stateFiles = (db: DatabaseSync): Map<string, string> =>
  new Map(BUILDERS.map(([name, build]) => [name, build(db)]));

/**
 * Write each state file whose content changed; answers the vault-relative
 * paths written. Yields between files: building both at croc's size holds the
 * loop for about 7 ms (D121).
 */
export const exportVaultState = async (
  db: DatabaseSync,
  vaultDataPath: string
): Promise<string[]> => {
  const dir = join(vaultDataPath, STATE_DIR);
  mkdirSync(dir, {recursive: true});
  const written: string[] = [];
  for (const [name, build] of BUILDERS) {
    const content = build(db);
    const path = join(dir, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      writeFileSync(path, content);
      written.push(`${STATE_DIR}/${name}`);
    }
    await nextTurn();
  }
  return written;
};
