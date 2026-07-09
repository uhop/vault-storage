import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';

/**
 * Constant-time bearer token check. Returns true iff the request carries
 * `Authorization: Bearer <expected>`. Empty / malformed / wrong tokens all
 * return false without leaking timing info on the comparison itself.
 * Parsed without a regex: the header is attacker-controlled pre-auth.
 */
export const checkBearer = (req: IncomingMessage, expected: string): boolean => {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer')) return false;
  let i = 6;
  while (i < header.length && (header[i] === ' ' || header[i] === '\t')) ++i;
  if (i === 6 || i === header.length) return false;

  const got = Buffer.from(header.slice(i), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
};
