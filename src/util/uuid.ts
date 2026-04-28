import {randomBytes} from 'node:crypto';

/**
 * Generate a UUIDv7 per RFC 9562: 48-bit Unix timestamp (ms) + version 7 +
 * 74 random bits + variant 10. Lexicographic order tracks generation time,
 * which is what the records table uses for cheap by-time queries.
 */
export const uuidv7 = (): string => {
  const ts = Date.now();
  const buf = randomBytes(16);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Big-endian 48-bit timestamp in bytes 0..5.
  view.setUint16(0, Math.floor(ts / 0x100000000), false);
  view.setUint32(2, ts >>> 0, false);

  // Version 7 in the upper nibble of byte 6; variant 10 in the upper two bits of byte 8.
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);

  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
