import yaml from 'yaml';

export interface Frontmatter {
  /** Parsed YAML object. Empty when the source has no frontmatter block. */
  data: Record<string, unknown>;
  /** Markdown body with the frontmatter block stripped. */
  body: string;
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Split a markdown source into its YAML frontmatter and body. Files without a
 * leading `---\n...\n---` block (legacy raw notes per design constraint C5)
 * return `data: {}` and the original text as `body`.
 */
export const parseFrontmatter = (source: string): Frontmatter => {
  const match = FRONTMATTER_BLOCK.exec(source);
  if (!match) return {data: {}, body: source};

  const yamlText = match[1] ?? '';
  const parsed = yaml.parse(yamlText);
  const data =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return {data, body: source.slice(match[0].length)};
};

/**
 * Reassemble a markdown source from frontmatter + body. Empty `data` produces
 * a body-only document — no `---` block is emitted.
 */
export const serializeFrontmatter = (fm: Frontmatter): string => {
  if (Object.keys(fm.data).length === 0) return fm.body;
  const yamlText = yaml.stringify(fm.data, {lineWidth: 0}).replace(/\s+$/, '');
  return `---\n${yamlText}\n---\n${fm.body}`;
};
