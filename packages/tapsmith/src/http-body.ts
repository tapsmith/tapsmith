/**
 * Decoding of HTTP bodies captured by the network proxy.
 *
 * The proxy hands over the bytes as they crossed the wire: chunk-framed per
 * `Transfer-Encoding` and compressed per `Content-Encoding`. Traces and the
 * live network events (`device.waitForResponse()`, `device.on('response')`)
 * both show the decoded body, the way Playwright's `response.body()` does,
 * and leave the headers as they were sent.
 */

import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

/** Case-insensitive header lookup. HTTP header names are case-insensitive
 * per RFC 7230 §3.2, and the on-device collectors have historically mixed
 * casing (`Transfer-Encoding`, `transfer-encoding`, `Transfer-encoding`). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return undefined;
}

/** Strip HTTP/1.1 chunked transfer encoding framing from a body.
 * Returns the original buffer if parsing fails. */
function dechunkHttpBody(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < body.length) {
    const lineEnd = body.indexOf('\r\n', pos);
    if (lineEnd === -1) return body;
    const sizeHex = body.subarray(pos, lineEnd).toString('ascii').split(';')[0].trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) return body;
    pos = lineEnd + 2;
    if (size === 0) break;
    if (pos + size > body.length) return body;
    parts.push(body.subarray(pos, pos + size));
    pos += size;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
  }
  return Buffer.concat(parts);
}

type Coding = 'gzip' | 'deflate' | 'br';

/** The body with its chunk framing removed, and the compression still to
 * undo — none for identity, a missing header, or a coding this module does
 * not decode (zstd, stacked codings such as `gzip, br`), which stay as they are. */
function unframe(body: Buffer, headers: Record<string, string>): { body: Buffer; coding?: Coding } {
  let unframed = body;
  const te = (headerValue(headers, 'transfer-encoding') ?? '').toLowerCase();
  if (te.split(',').map((s) => s.trim()).includes('chunked')) {
    unframed = dechunkHttpBody(unframed);
  }
  const ce = (headerValue(headers, 'content-encoding') ?? '').toLowerCase().trim();
  if (ce === 'gzip' || ce === 'x-gzip') return { body: unframed, coding: 'gzip' };
  if (ce === 'deflate' || ce === 'br') return { body: unframed, coding: ce };
  return { body: unframed };
}

/** Decode a captured HTTP body: strip chunked framing per Transfer-Encoding,
 * then decompress per Content-Encoding. Falls back to the de-chunked bytes
 * when they cannot be decompressed (a cut-off or corrupt stream). */
export async function decodeHttpBody(body: Buffer | undefined, headers: Record<string, string>): Promise<Buffer | undefined> {
  if (!body || body.length === 0) return body;
  const { body: unframed, coding } = unframe(body, headers);
  try {
    if (coding === 'gzip') return await gunzip(unframed);
    if (coding === 'deflate') return await inflate(unframed);
    if (coding === 'br') return await brotliDecompress(unframed);
  } catch {
    // Keep the bytes as they are.
  }
  return unframed;
}

/** {@link decodeHttpBody}, synchronously — for a body read on demand from a
 * live network event, which has to hand the bytes back from a property read. */
export function decodeHttpBodySync(body: Buffer | undefined, headers: Record<string, string>): Buffer | undefined {
  if (!body || body.length === 0) return body;
  const { body: unframed, coding } = unframe(body, headers);
  try {
    if (coding === 'gzip') return zlib.gunzipSync(unframed);
    if (coding === 'deflate') return zlib.inflateSync(unframed);
    if (coding === 'br') return zlib.brotliDecompressSync(unframed);
  } catch {
    // Keep the bytes as they are.
  }
  return unframed;
}
