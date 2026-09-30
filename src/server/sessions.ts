// A project's session records (D105): `projects/<name>/sessions.md`, one
// bullet per session end, appended by the SessionEnd hook in claude-config.
// Markdown holds the record, so nothing lives only in the database; the
// bullet's shape is the contract between the hook and this parser.

export interface SessionRecord {
  /** When the session ended, ISO 8601. */
  ended: string;
  /** `<host>/<session-prefix>`, the lease holder id. */
  holder: string;
  started: string;
  reason: string;
  /** The commits that landed in the checkout during the session, short shas. */
  commits: string[];
  /** The vault notes the session wrote, as paths. */
  wrote: string[];
  /** The log the session wrote, or null when it wrote none. */
  log: string | null;
}

const BULLET =
  /^- \*\*(\S+)\*\* (\S+): started (\S+), ended by ([a-z_-]+), commits: \d+(?: \(([^)]*)\))?, wrote: \d+(?: \(([^)]*)\))?, log: (\S+?)\.?$/;

const list = (group: string | undefined): string[] =>
  group === undefined || group === 'none'
    ? []
    : group
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);

/** Every well-formed bullet of a sessions note, newest first. */
export const parseSessions = (body: string): SessionRecord[] => {
  const out: SessionRecord[] = [];
  for (const line of body.split('\n')) {
    const m = BULLET.exec(line.trimEnd());
    if (!m) continue;
    out.push({
      ended: m[1]!,
      holder: m[2]!,
      started: m[3]!,
      reason: m[4]!,
      commits: list(m[5]),
      wrote: list(m[6]),
      log: m[7] === 'none' ? null : m[7]!
    });
  }
  return out.sort((a, b) => (a.ended < b.ended ? 1 : a.ended > b.ended ? -1 : 0));
};

/** The bullet the hook writes; the parser's inverse, kept here so the tests pin both. */
export const formatSession = (s: SessionRecord): string =>
  `- **${s.ended}** ${s.holder}: started ${s.started}, ended by ${s.reason}, commits: ${s.commits.length}${
    s.commits.length ? ` (${s.commits.join(', ')})` : ''
  }, wrote: ${s.wrote.length}${s.wrote.length ? ` (${s.wrote.join(', ')})` : ''}, log: ${s.log ?? 'none'}.`;
