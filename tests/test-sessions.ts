import test from 'tape-six';
import {formatSession, parseSessions, type SessionRecord} from '../src/server/sessions.ts';

const full: SessionRecord = {
  ended: '2026-09-30T02:45:10Z',
  holder: 'nuke/d71261c1',
  started: '2026-09-29T22:26:05Z',
  reason: 'exit',
  commits: ['23a3c9a', 'd7f8d92'],
  wrote: ['projects/vault-storage/decisions.md', 'logs/2026-09-29-vault-storage-x.md'],
  log: 'logs/2026-09-29-vault-storage-x.md'
};
const bare: SessionRecord = {
  ended: '2026-09-30T03:00:00Z',
  holder: 'mba/0a1b2c3d',
  started: '2026-09-30T02:50:00Z',
  reason: 'other',
  commits: [],
  wrote: [],
  log: null
};

test('a session bullet round-trips through format and parse', t => {
  t.equal(
    formatSession(full),
    '- **2026-09-30T02:45:10Z** nuke/d71261c1: started 2026-09-29T22:26:05Z, ended by exit, commits: 2 (23a3c9a, d7f8d92), wrote: 2 (projects/vault-storage/decisions.md, logs/2026-09-29-vault-storage-x.md), log: logs/2026-09-29-vault-storage-x.md.'
  );
  t.equal(
    formatSession(bare),
    '- **2026-09-30T03:00:00Z** mba/0a1b2c3d: started 2026-09-30T02:50:00Z, ended by other, commits: 0, wrote: 0, log: none.'
  );
  t.deepEqual(
    parseSessions([formatSession(full), formatSession(bare)].join('\n')),
    [bare, full],
    'newest first'
  );
});

test('parse skips what is not a session bullet and tolerates a missing period', t => {
  const body = [
    'Sessions of vs-demo, one bullet each, appended by the SessionEnd hook.',
    '',
    '## Sessions',
    '',
    '- A stray bullet.',
    formatSession(full).slice(0, -1),
    '- **not-a-date** x: started y, ended by z',
    ''
  ].join('\n');
  t.deepEqual(parseSessions(body), [full]);
});
