export interface PaginationOpts {
  /** Hard cap server-side; clamps without erroring per api-surface § Pagination. */
  maxLimit?: number;
  defaultLimit?: number;
}

export interface Pagination {
  offset: number;
  limit: number;
}

export const parsePagination = (
  query: Record<string, string>,
  opts: PaginationOpts = {}
): Pagination => {
  const maxLimit = opts.maxLimit ?? 100;
  const defaultLimit = opts.defaultLimit ?? 20;

  const offsetRaw = query['offset'];
  const limitRaw = query['limit'];

  const offset = offsetRaw === undefined ? 0 : Math.max(0, Number.parseInt(offsetRaw, 10) || 0);
  const limitParsed = limitRaw === undefined ? defaultLimit : Number.parseInt(limitRaw, 10);
  const limit = Math.min(
    maxLimit,
    Math.max(1, Number.isFinite(limitParsed) ? limitParsed : defaultLimit)
  );

  return {offset, limit};
};

/** Split a comma-separated query value into a trimmed string array. Empty input → []. */
export const splitCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
};
