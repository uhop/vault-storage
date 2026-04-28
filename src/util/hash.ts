import {createHash} from 'node:crypto';

/** SHA-256 of the UTF-8 bytes of `text`, returned as lowercase hex. */
export const contentHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
