import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {contentHash} from '../util/hash.ts';

/** What a draft edits: the whole document, its frontmatter, or one section. */
export type DraftUnit =
  | {kind: 'document'}
  | {kind: 'frontmatter'}
  | {kind: 'section'; heading: string; occurrence: number};

export interface Draft {
  id: string;
  path: string;
  unit: DraftUnit;
  /** The hash of the text the draft started from, to tell a stale draft on restore. */
  base_hash: string;
  text: string;
  updated: string;
}

export const DRAFT_ID_RE = /^[0-9a-f]{32}$/;

const unitKey = (unit: DraftUnit): string =>
  unit.kind === 'section' ? `section\t${unit.heading}\t${unit.occurrence}` : unit.kind;

export const draftId = (path: string, unit: DraftUnit): string =>
  contentHash(`${path}\t${unitKey(unit)}`).slice(0, 32);

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Unsaved edits, one JSON file per note and unit, next to the database and
 * outside the note tree: they survive a restart, and they are never indexed
 * or committed (D60). A draft is replaced whole on every save.
 */
export class DraftStore {
  readonly dir: string;
  #tmp = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  async put(input: Omit<Draft, 'id' | 'updated'>, now = new Date()): Promise<Draft> {
    const draft: Draft = {
      id: draftId(input.path, input.unit),
      path: input.path,
      unit: input.unit,
      base_hash: input.base_hash,
      text: input.text,
      updated: now.toISOString()
    };
    await mkdir(this.dir, {recursive: true});
    // A rename replaces the file whole, so a reader never sees half a draft.
    const tmp = join(this.dir, `${draft.id}.${process.pid}.${++this.#tmp}.tmp`);
    await writeFile(tmp, JSON.stringify(draft), 'utf8');
    await rename(tmp, join(this.dir, `${draft.id}.json`));
    return draft;
  }

  /** Every draft, or those for one note, the most recently saved first. */
  async list(path?: string): Promise<Draft[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const drafts: Draft[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let draft: Draft;
      try {
        draft = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as Draft;
      } catch {
        continue;
      }
      if (path === undefined || draft.path === path) drafts.push(draft);
    }
    return drafts.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** True when a draft was removed, false when there was none. */
  async remove(id: string): Promise<boolean> {
    try {
      await rm(join(this.dir, `${id}.json`));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }
}
