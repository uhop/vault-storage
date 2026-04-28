import {RECORD_TYPES, type RecordType} from '../records/types.ts';

/**
 * Derive a RecordType from a vault-relative path per the folder defaults in
 * design/closed-enums.md § folder-defaults inference.
 *
 * Path is forward-slash normalized; segments use POSIX semantics.
 *
 * Precedence (highest to lowest):
 *   - root `_index.md`                      → 'index'
 *   - `_about.md` anywhere                  → 'meta'
 *   - `projects/<name>/state.md`            → 'state'
 *   - `projects/<name>/<sub>/...`           → sub-type by sub
 *   - `projects/<name>/...`                 → 'project' (catch-all)
 *   - top-level folder default              → permanent / log / query / fleeting
 *   - everything else                       → 'permanent'
 *
 * Callers should prefer an explicit `type` from frontmatter; this is only the
 * fallback when frontmatter is missing or doesn't supply `type`.
 */
export const typeFromPath = (vaultRelativePath: string): RecordType => {
  const path = vaultRelativePath.replace(/^\/+/, '').replace(/\\/g, '/');
  const parts = path.split('/');
  const file = parts[parts.length - 1] ?? '';

  if (path === '_index.md') return 'index';
  if (file === '_about.md') return 'meta';

  const top = parts[0];

  if (top === 'projects' && parts.length >= 3) {
    if (file === 'state.md') return 'state';
    if (parts.length >= 4) {
      const sub = parts[2];
      switch (sub) {
        case 'ideas':
          return 'idea';
        case 'design':
          return 'design';
        case 'plan':
          return 'plan';
        case 'queue':
          return 'queue-item';
        case 'research':
          return 'research';
        case 'bugs':
          return 'bug-report';
      }
    }
    return 'project';
  }

  switch (top) {
    case 'topics':
      return 'permanent';
    case 'logs':
      return 'log';
    case 'queries':
      return 'query';
    case 'raw':
      return 'fleeting';
    default:
      return 'permanent';
  }
};

const RECORD_TYPE_SET: ReadonlySet<string> = new Set(RECORD_TYPES);

/** Type guard for runtime validation of a candidate type string. */
export const isRecordType = (value: unknown): value is RecordType =>
  typeof value === 'string' && RECORD_TYPE_SET.has(value);
