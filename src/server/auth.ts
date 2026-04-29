import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';

const BEARER = /^Bearer\s+(.+)$/;

/**
 * Constant-time bearer token check. Returns true iff the request carries
 * `Authorization: Bearer <expected>`. Empty / malformed / wrong tokens all
 * return false without leaking timing info on the comparison itself.
 */
export const checkBearer = (req: IncomingMessage, expected: string): boolean => {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const match = BEARER.exec(header);
  if (!match || !match[1]) return false;

  const got = Buffer.from(match[1], 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
};
