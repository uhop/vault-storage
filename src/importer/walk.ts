import {readdirSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

export interface MarkdownFile {
  /** Vault-relative path with forward slashes. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.obsidian']);
// Root-only: the coordination spool (agent-coordination design) is not vault
// content, but a nested `x/handoff/` is ordinary content and still indexes.
const ROOT_SKIP_DIRS: ReadonlySet<string> = new Set(['handoff']);

function* walkInner(root: string, dir: string): Generator<MarkdownFile> {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (dir === root && ROOT_SKIP_DIRS.has(entry.name)) continue;
      yield* walkInner(root, abs);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = relative(root, abs).split(sep).join('/');
      yield {relativePath: rel, absolutePath: abs};
    }
  }
}

/**
 * Yield every `.md` file under `root` (recursive). Skips `.git`, `node_modules`,
 * and `.obsidian` directories at any depth, plus the root-level `handoff/`
 * spool. Vault-relative paths are normalized to use `/`.
 */
export const walkMarkdown = (root: string): Generator<MarkdownFile> => walkInner(root, root);
