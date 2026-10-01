import test from 'tape-six';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureVaultMarker, MARKER_FILE, MARKER_FORMAT} from '../src/vault-marker.ts';

const withVault = (fn: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'vault-marker-'));
  try {
    fn(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
};

test('vault marker: written when absent, read back after', t => {
  withVault(root => {
    const first = ensureVaultMarker(root, new Date('2026-09-30T12:00:00Z'));
    t.equal(first.created, true);
    t.deepEqual(
      {...first.marker, vault_id: typeof first.marker.vault_id},
      {
        app: 'vault-storage',
        format: MARKER_FORMAT,
        vault_id: 'string',
        created: '2026-09-30T12:00:00.000Z'
      }
    );
    t.deepEqual(JSON.parse(readFileSync(join(root, MARKER_FILE), 'utf8')), first.marker);

    const second = ensureVaultMarker(root);
    t.equal(second.created, false);
    t.equal(second.marker.vault_id, first.marker.vault_id, 'the id stays');
  });
});

test('vault marker: a newer format stops the start', t => {
  withVault(root => {
    writeFileSync(
      join(root, MARKER_FILE),
      JSON.stringify({app: 'vault-storage', format: MARKER_FORMAT + 1, vault_id: 'x', created: 'y'})
    );
    t.throws(() => ensureVaultMarker(root), RangeError);
  });
});

test('vault marker: a file that is not a marker stops the start and stays as it was', t => {
  withVault(root => {
    const path = join(root, MARKER_FILE);
    for (const text of [
      '{not json',
      '{"app": "other", "format": 1, "vault_id": "x", "created": "y"}',
      '[]'
    ]) {
      writeFileSync(path, text);
      t.throws(() => ensureVaultMarker(root), SyntaxError, text);
      t.equal(readFileSync(path, 'utf8'), text, 'not overwritten');
    }
  });
});
