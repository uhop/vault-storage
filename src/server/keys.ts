// Named keys (D135). VAULT_API_TOKEN stays valid as an implicit person key, so
// a server with no key file works as before. Resolve once, check a recall where
// a session is created: ~/Open/articles/design/web-apps-authorization.md.

import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, isAbsolute} from 'node:path';
import {uuidv7} from '../util/uuid.ts';
import {sendError} from './responses.ts';
import type {RequestContext} from './router.ts';

export const KEY_KINDS = ['person', 'agent', 'system'] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

/** What a request carries after its key resolves; every consumer reads only this. */
export interface Session {
  key_id: string;
  name: string;
  kind: KeyKind;
  email: string | null;
}

interface StoredKey {
  id: string;
  name: string;
  kind: KeyKind;
  email: string | null;
  hash: string;
  created: string;
  expires_at: string | null;
  recalled_at: string | null;
}

/** A key as the routes show it: everything but the hash. */
export type KeyView = Omit<StoredKey, 'hash'> & {status: 'active' | 'expired' | 'recalled'};

export const LEGACY_KEY_ID = 'legacy';

const SECRET_PREFIX = 'vsk_';
const RELOAD_EVERY_MS = 1000;

const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const statusOf = (key: StoredKey, now: string): KeyView['status'] =>
  key.recalled_at !== null
    ? 'recalled'
    : key.expires_at !== null && key.expires_at <= now
      ? 'expired'
      : 'active';

const viewOf = (key: StoredKey, now: string): KeyView => {
  const {hash: _hash, ...rest} = key;
  return {...rest, status: statusOf(key, now)};
};

const sessionOf = (key: StoredKey): Session => ({
  key_id: key.id,
  name: key.name,
  kind: key.kind,
  email: key.email
});

export interface KeyStoreOptions {
  /** The key file; null keeps only the legacy token (an in-memory test server). */
  path: string | null;
  /** VAULT_API_TOKEN, accepted as the implicit person key. */
  legacyToken?: string | null;
  /** A key file under this directory gets a `.gitignore` of `*` beside it. */
  vaultDataPath?: string;
  /** How often the request path checks the file for a change; default a second. */
  reloadEveryMs?: number;
}

export class KeyStore {
  readonly #path: string | null;
  readonly #legacy: Buffer | null;
  readonly #legacySession: Session;
  readonly #vaultDataPath: string | null;
  readonly #reloadEveryMs: number;
  #byHash = new Map<string, StoredKey>();
  #sessions = new Map<string, {session: Session; expiresAt: number | null}>();
  #mtimeMs = -1;
  #checkedAt = 0;

  constructor(opts: KeyStoreOptions) {
    this.#path = opts.path;
    this.#legacy = opts.legacyToken ? Buffer.from(opts.legacyToken, 'utf8') : null;
    this.#legacySession = {
      key_id: LEGACY_KEY_ID,
      name: 'operator',
      kind: 'person',
      email: null
    };
    this.#vaultDataPath = opts.vaultDataPath ?? null;
    this.#reloadEveryMs = opts.reloadEveryMs ?? RELOAD_EVERY_MS;
    this.#reload(true);
  }

  get path(): string | null {
    return this.#path;
  }

  /** The session for a presented secret, or null when no active key matches it. */
  resolve(secret: string | null): Session | null {
    if (!secret) return null;
    this.#reload(false);
    const cached = this.#sessions.get(secret);
    if (cached) {
      if (cached.expiresAt === null || cached.expiresAt > Date.now()) return cached.session;
      this.#sessions.delete(secret);
    }
    if (this.#legacy !== null) {
      const got = Buffer.from(secret, 'utf8');
      if (got.length === this.#legacy.length && timingSafeEqual(got, this.#legacy)) {
        this.#sessions.set(secret, {session: this.#legacySession, expiresAt: null});
        return this.#legacySession;
      }
    }
    const key = this.#byHash.get(hashOf(secret));
    if (!key || statusOf(key, new Date().toISOString()) !== 'active') return null;
    const session = sessionOf(key);
    this.#sessions.set(secret, {
      session,
      expiresAt: key.expires_at === null ? null : Date.parse(key.expires_at)
    });
    return session;
  }

  list(): KeyView[] {
    this.#reload(true);
    const now = new Date().toISOString();
    return [...this.#byHash.values()].map(k => viewOf(k, now));
  }

  /** A new key; the secret is in this answer only. */
  create(fields: {name: string; kind: KeyKind; email: string | null; expires_at: string | null}): {
    key: KeyView;
    secret: string;
  } {
    if (this.#path === null) throw new Error('no key file is configured');
    this.#reload(true);
    const secret = SECRET_PREFIX + randomBytes(32).toString('base64url');
    const key: StoredKey = {
      id: uuidv7(),
      ...fields,
      hash: hashOf(secret),
      created: new Date().toISOString(),
      recalled_at: null
    };
    this.#write([...this.#byHash.values(), key]);
    return {key: viewOf(key, key.created), secret};
  }

  /** Mark a key recalled; null when no such key. Its sessions end at once. */
  recall(id: string): KeyView | null {
    if (this.#path === null) return null;
    this.#reload(true);
    const keys = [...this.#byHash.values()];
    const key = keys.find(k => k.id === id);
    if (!key) return null;
    const now = new Date().toISOString();
    if (key.recalled_at === null) {
      key.recalled_at = now;
      this.#write(keys);
    }
    return viewOf(key, now);
  }

  #write(keys: StoredKey[]): void {
    const path = this.#path!;
    const dir = dirname(path);
    mkdirSync(dir, {recursive: true});
    // Never committed: a key file inside the vault gets a `*` .gitignore, as the handoff spool does.
    if (this.#vaultDataPath !== null) {
      const rel = relative(this.#vaultDataPath, dir);
      const inside = !rel.startsWith('..') && !isAbsolute(rel);
      const ignore = join(dir, '.gitignore');
      if (inside && !existsSync(ignore)) writeFileSync(ignore, '*\n');
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({keys}, null, 2) + '\n', {mode: 0o600});
    renameSync(tmp, path);
    this.#reload(true);
  }

  // Throttled to once a second on the request path; a write or a listing forces it.
  #reload(force: boolean): void {
    if (this.#path === null) return;
    const now = Date.now();
    if (!force && now - this.#checkedAt < this.#reloadEveryMs) return;
    this.#checkedAt = now;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.#path).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    if (mtimeMs === this.#mtimeMs) return;
    this.#mtimeMs = mtimeMs;
    const byHash = new Map<string, StoredKey>();
    if (mtimeMs > 0) {
      try {
        const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as {keys?: StoredKey[]};
        for (const key of parsed.keys ?? []) byHash.set(key.hash, key);
      } catch (err) {
        // Fails closed: a file that cannot be read accepts no key of its own.
        process.stderr.write(
          `keys: ${this.#path} unreadable, no file keys accepted: ${(err as Error).message}\n`
        );
        byHash.clear();
      }
    }
    this.#byHash = byHash;
    // A changed file ends every session but the legacy key's; the next request resolves again.
    for (const [secret, {session}] of this.#sessions)
      if (session.key_id !== LEGACY_KEY_ID) this.#sessions.delete(secret);
  }
}

/** The bearer token of a request, or null; parsed without a regex, since the header is pre-auth. */
export const bearerOf = (header: string | undefined): string | null => {
  if (typeof header !== 'string' || !header.startsWith('Bearer')) return null;
  let i = 6;
  while (i < header.length && (header[i] === ' ' || header[i] === '\t')) ++i;
  if (i === 6 || i === header.length) return null;
  return header.slice(i);
};

/**
 * True when the caller's key is a person's; otherwise answers 403 `forbidden`
 * naming the act. The closed list of person-only acts (D135): the key routes
 * and a forced lease release.
 */
export const requirePerson = (ctx: RequestContext, act: string): boolean => {
  if (ctx.session?.kind === 'person') return true;
  sendError(
    ctx.res,
    403,
    'forbidden',
    `${act} needs a person's key; this request's key is ${ctx.session ? `"${ctx.session.name}" (${ctx.session.kind})` : 'unknown'}`
  );
  return false;
};
