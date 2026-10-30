import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeHttpBody, decodeHttpBodySync } from '../http-body.js';

const json = Buffer.from(JSON.stringify({ id: 1, title: 'delectus aut autem' }));

/** Frame `body` as HTTP/1.1 chunked transfer encoding, in `size`-byte chunks. */
function chunk(body: Buffer, size = 7): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < body.length; i += size) {
    const piece = body.subarray(i, i + size);
    parts.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('0\r\n\r\n'));
  return Buffer.concat(parts);
}

const decoders = [
  ['decodeHttpBodySync', (body: Buffer | undefined, headers: Record<string, string>) => Promise.resolve(decodeHttpBodySync(body, headers))],
  ['decodeHttpBody', decodeHttpBody],
] as const;

describe.each(decoders)('%s', (_name, decode) => {
  it('de-chunks and gunzips a gzip + chunked body (PILOT-944)', async () => {
    const wire = chunk(zlib.gzipSync(json));
    const decoded = await decode(wire, { 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' });
    expect(decoded?.toString()).toBe(json.toString());
  });

  it.each([
    ['gzip', zlib.gzipSync],
    ['x-gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync],
  ] as const)('decompresses Content-Encoding: %s', async (coding, compress) => {
    const decoded = await decode(compress(json), { 'content-encoding': coding });
    expect(decoded?.toString()).toBe(json.toString());
  });

  it('matches header names case-insensitively', async () => {
    const wire = chunk(zlib.brotliCompressSync(json));
    const decoded = await decode(wire, { 'Content-Encoding': 'BR', 'Transfer-Encoding': 'Chunked' });
    expect(decoded?.toString()).toBe(json.toString());
  });

  it('de-chunks an uncompressed body', async () => {
    expect((await decode(chunk(json), { 'transfer-encoding': 'chunked' }))?.toString()).toBe(json.toString());
  });

  it('returns identity and unlabelled bodies as they are', async () => {
    expect(await decode(json, {})).toBe(json);
    expect(await decode(json, { 'content-encoding': 'identity' })).toBe(json);
  });

  it('keeps the bytes when it cannot decompress them', async () => {
    const truncated = zlib.gzipSync(json).subarray(0, 12);
    expect(await decode(truncated, { 'content-encoding': 'gzip' })).toBe(truncated);
    const notGzip = Buffer.from('plainly not gzip');
    expect(await decode(notGzip, { 'content-encoding': 'gzip' })).toBe(notGzip);
  });

  it('de-chunks but leaves codings it does not know (zstd, stacked)', async () => {
    const inner = Buffer.from('opaque');
    expect((await decode(chunk(inner), { 'content-encoding': 'zstd', 'transfer-encoding': 'chunked' }))?.toString()).toBe('opaque');
    const stacked = zlib.gzipSync(json);
    expect(await decode(stacked, { 'content-encoding': 'gzip, br' })).toBe(stacked);
  });

  it('passes empty and missing bodies through', async () => {
    expect(await decode(undefined, { 'content-encoding': 'gzip' })).toBeUndefined();
    const empty = Buffer.alloc(0);
    expect(await decode(empty, { 'content-encoding': 'gzip' })).toBe(empty);
  });
});
