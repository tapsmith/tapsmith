// ─── Network image preview helpers ───
//
// Pure decisions behind the Network tab's image preview, kept free of DOM so
// they can be unit-tested: which bytes are an image, and whether the captured
// bytes are the whole image.
//
// The bodies the viewer receives are already decoded: the runner strips
// chunked framing and undoes gzip/deflate/br before storing them
// (`decodeHttpBody` in http-body.ts), but leaves the headers as they were sent.
// So Content-Encoding and Transfer-Encoding describe the wire, not these
// bytes, and the recorded sizes are wire sizes.

import { isBodyPlaceholder } from '../../trace/body-placeholder.js';

/** Image types a browser `<img>` renders, keyed by their MIME type. */
const RENDERABLE_IMAGE_TYPES = new Map([
  ['image/png', 'image/png'],
  ['image/x-png', 'image/png'],
  ['image/apng', 'image/apng'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['image/avif', 'image/avif'],
  ['image/bmp', 'image/bmp'],
  ['image/x-bmp', 'image/bmp'],
  ['image/x-ms-bmp', 'image/bmp'],
  ['image/x-icon', 'image/x-icon'],
  ['image/vnd.microsoft.icon', 'image/x-icon'],
  ['image/ico', 'image/x-icon'],
  ['image/icon', 'image/x-icon'],
  ['image/svg+xml', 'image/svg+xml'],
  ['image/svg', 'image/svg+xml'],
]);

/** Declared types that say nothing about the bytes, so sniffing may name
 * them. A specific non-image type (`application/x-protobuf`) is believed:
 * short signatures such as JPEG's three bytes turn up in other binary data. */
const GENERIC_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/unknown',
  'application/x-unknown',
  'unknown/unknown',
]);

/** Bytes of each body the daemon stores (`MAX_BODY_SIZE` in
 * tapsmith-core's network_proxy.rs). It counts every wire byte regardless. */
const MAX_CAPTURED_BODY_BYTES = 1_048_576;

/** Case-insensitive header lookup — captured header names keep the casing the
 * app or server sent. */
export function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/** The bare MIME type of a Content-Type value, lower-cased, parameters dropped. */
function bareMimeType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

/** Identify an image by its leading bytes. Catches bodies served with a wrong
 * or generic content type (`application/octet-stream`, `binary/octet-stream`),
 * which CDNs and object stores do routinely. */
export function sniffImageType(body: Uint8Array): string | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => body[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // RIFF....WEBP
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/** A declared renderable image type, normalised, or null. */
function declaredImageType(contentType: string): string | null {
  return RENDERABLE_IMAGE_TYPES.get(bareMimeType(contentType)) ?? null;
}

/** Whether the wire form differs from the stored bytes — compressed or
 * chunked — so the recorded wire size cannot be compared with their length. */
function isWireFramed(headers: Record<string, string>): boolean {
  const encoded = (headerValue(headers, 'content-encoding') ?? '')
    .split(',')
    .some(c => { const t = c.trim().toLowerCase(); return t !== '' && t !== 'identity'; });
  return encoded || isChunked(headers);
}

function isChunked(headers: Record<string, string>): boolean {
  return (headerValue(headers, 'transfer-encoding') ?? '')
    .split(',')
    .some(c => c.trim().toLowerCase() === 'chunked');
}

export type ImagePlan =
  /** Not an image: render the body as text / decoded, as before. */
  | { kind: 'none' }
  /** Render the bytes as an image of this type. */
  | { kind: 'preview'; mimeType: string }
  /** An image, but one the viewer cannot show — say why, then show raw. */
  | { kind: 'unavailable'; mimeType: string; reason: ImageUnavailableReason };

export type ImageUnavailableReason =
  | { code: 'unsupported-type' }
  | { code: 'undecoded'; encoding: string }
  | { code: 'truncated'; captured: number; declared: number }
  | { code: 'partial-content' }
  | { code: 'in-flight'; direction: 'request' | 'response' }
  /** The bytes stop before the format's own end marker. */
  | { code: 'incomplete' }
  /** UI mode swapped the body for a size marker; the trace archive has it. */
  | { code: 'not-live' };

interface ImagePlanInput {
  body: Uint8Array
  /** The body's own Content-Type (request or response side). */
  contentType: string
  /** The body's own headers, as sent on the wire. */
  headers: Record<string, string>
  /** The byte count the capture recorded for this body (a wire size). */
  declaredBytes: number
  /** The body may still have been arriving when the capture was taken. */
  inFlight: boolean
  direction: 'request' | 'response'
  /** The exchange's HTTP status (0 while pending). */
  status: number
}

/** Decide whether and how to preview a body as an image.
 *
 * A declared renderable image type wins; otherwise the bytes are sniffed. A
 * declared type the browser cannot render (TIFF, HEIC) is reported rather
 * than attempted. So is a body the capture holds only part of: browsers paint
 * whatever decodes, and a half-picture would pass for the real thing. */
export function imagePlan({ body, contentType, headers, declaredBytes, inFlight, direction, status }: ImagePlanInput): ImagePlan {
  const declaredType = declaredImageType(contentType);
  // A raster image labelled SVG (a PNG fallback served for a .svg URL) would
  // fail in the SVG path, which parses markup; the browser draws raster bytes
  // whatever their label, so the bytes decide. Other mislabels need nothing:
  // <img> sniffs among raster formats itself.
  const sniffed = declaredType === 'image/svg+xml' || GENERIC_TYPES.has(bareMimeType(contentType)) ? sniffImageType(body) : null;
  const mimeType = (declaredType === 'image/svg+xml' ? sniffed : null) ?? declaredType ?? sniffed;
  if (!mimeType) {
    const declared = bareMimeType(contentType);
    if (!declared.startsWith('image/')) return { kind: 'none' };
    // The marker stands in for any oversized image, displayable or not; the
    // archive has the real body either way.
    const reason: ImageUnavailableReason = isBodyPlaceholder(body) ? { code: 'not-live' } : { code: 'unsupported-type' };
    return { kind: 'unavailable', mimeType: declared, reason };
  }
  const unavailable = (reason: ImageUnavailableReason): ImagePlan => ({ kind: 'unavailable', mimeType, reason });

  if (isBodyPlaceholder(body)) return unavailable({ code: 'not-live' });

  // Still arriving explains a short body better than anything below: a live
  // chunked stream always ends mid-chunk and a live gzip stream can't be
  // decompressed yet, so those checks would misname it.
  if (inFlight) return unavailable({ code: 'in-flight', direction });

  // The runner hands back the framed bytes when the last chunk is cut short.
  // Checked before leftover compression: a chunk-size line can pass for a
  // zlib header ("8000\r\n" does).
  if (hasLeftoverChunkFraming(body, mimeType, headers)) return unavailable({ code: 'incomplete' });
  const encoding = undecodedEncoding(body, mimeType, headers);
  if (encoding) return unavailable({ code: 'undecoded', encoding });

  // A 206 carries one slice of the resource, with a Content-Length that
  // matches the slice — complete as a body, partial as an image.
  // A 206 answering an open-ended `Range: bytes=0-` holds the whole resource.
  if (direction === 'response' && status === 206 && !coversWholeResource(headerValue(headers, 'content-range'))) {
    return unavailable({ code: 'partial-content' });
  }
  const truncated = truncatedFrom(body.length, declaredBytes, headers);
  if (truncated) return unavailable({ code: 'truncated', ...truncated });
  // The sizes can't vouch for every body — a chunked stream dropped on a
  // chunk boundary dechunks cleanly, and an upload answered early has no
  // in-flight signal — but PNG, JPEG, GIF and WebP say so themselves.
  if (endsEarly(body, mimeType)) return unavailable({ code: 'incomplete' });
  return { kind: 'preview', mimeType };
}

/** Whether a Content-Range (`bytes first-last/complete`) spans the whole
 * resource. An unknown complete length (`/*`) can't be shown to. */
function coversWholeResource(contentRange: string | undefined): boolean {
  // RFC 9110's form is `bytes 0-99/100`; tolerate the `bytes=` and spacing
  // variants some servers emit.
  const match = contentRange?.trim().match(/^bytes\s*[\s=]\s*(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/i);
  if (!match) return false;
  const [first, last, complete] = match.slice(1).map(Number);
  return first === 0 && last === complete - 1;
}

/** Whether TextDecoder (the WHATWG Encoding Standard) knows this label. */
function isKnownEncoding(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/** The `charset` parameter of a Content-Type, lower-cased, or undefined. */
export function contentTypeCharset(contentType: string): string | undefined {
  return contentType.match(/;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i)?.[1].toLowerCase();
}

/** The character encoding of an XML document, in the order XML over HTTP
 * resolves it (RFC 7303): a byte-order mark, else the HTTP `charset`, else
 * the XML declaration's `encoding`, else UTF-8.
 *
 * A UTF-16 label with no BOM is believed only when the bytes look like UTF-16
 * (ASCII characters carry a zero byte). An ASCII-readable declaration naming
 * UTF-16 is a known mislabel of UTF-8 files — reading it as UTF-16 would turn
 * the whole document into CJK mojibake. */
export function xmlEncoding(body: Uint8Array, charset?: string): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  // The declaration is ASCII in every ASCII-compatible encoding.
  let head = '';
  for (let i = 0; i < Math.min(body.length, 256); i++) head += String.fromCharCode(body[i]);
  const declared = head.match(/^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/)?.[1].toLowerCase();
  // A transport charset the decoder doesn't know (`binary`, from servers that
  // label by `file -i`) is skipped, as browsers skip it, for the declaration.
  const label = (charset && isKnownEncoding(charset) ? charset.toLowerCase() : undefined) ?? declared ?? 'utf-8';
  if (label.startsWith('utf-16') || label === 'ucs-2' || label === 'unicode') {
    if (body[0] === 0 && body[1] !== 0) return 'utf-16be';
    if (body[0] !== 0 && body[1] === 0) return 'utf-16le';
    return 'utf-8';
  }
  return label;
}

/** Whether a chunked body still starts with a chunk-size line where the
 * image's signature should be. */
function hasLeftoverChunkFraming(body: Uint8Array, mimeType: string, headers: Record<string, string>): boolean {
  if (!isChunked(headers) || hasSignature(body, mimeType)) return false;
  // Room for a chunk-size line with extensions.
  const head = new TextDecoder().decode(body.subarray(0, 1024));
  // Padding around the size is tolerated, as the runner's dechunker trims it.
  return /^[ \t]*[0-9a-f]+[ \t]*(;[^\r\n]*)?\r\n/i.test(head);
}

/** Size an SVG with no intrinsic dimensions is drawn at — the CSS default
 * for a replaced element. */
const SVG_DEFAULT_SIZE = { width: 300, height: 150 };

/** CSS px in each absolute unit (CSS Values and Units, 96 px per inch). */
const CSS_PX_PER_UNIT: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/** The size to rasterise an SVG at, from its root's `width`, `height` and
 * `viewBox` attributes, and whether the SVG declared that size itself.
 *
 * Absolute width and height (unitless or px) are the SVG's own size. Without
 * both, engines disagree — Chromium invents 150 × 150, Firefox and WebKit
 * report zero and may refuse to draw — so the SVG is given an explicit size:
 * the one declared dimension, or the default width, with the other taken from
 * the viewBox's aspect ratio (else the default's). */
export function svgRasterSize(width: string | null, height: string | null, viewBox: string | null): {
  width: number
  height: number
  declared: boolean
} {
  const absolute = (value: string | null) => {
    // A CSS length in an absolute unit (tools write mm, pt, in as often as
    // px), converted to CSS px; relative units (%, em, ex) are no size of
    // the SVG's own.
    // No space between number and unit: CSS rejects "10 px", so browsers
    // treat it as no size at all.
    const match = value?.match(/^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q)?\s*$/i);
    if (!match) return null;
    const n = parseFloat(match[1]) * (CSS_PX_PER_UNIT[(match[2] ?? 'px').toLowerCase()] ?? 1);
    return n > 0 && Number.isFinite(n) ? n : null;
  };
  const w = absolute(width);
  const h = absolute(height);
  if (w !== null && h !== null) return { width: w, height: h, declared: true };
  const box = (viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  const aspect = box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : null;
  if (w !== null) return { width: w, height: aspect ? w / aspect : SVG_DEFAULT_SIZE.height, declared: false };
  if (h !== null) return { width: aspect ? h * aspect : SVG_DEFAULT_SIZE.width, height: h, declared: false };
  const fallbackWidth = SVG_DEFAULT_SIZE.width;
  return { width: fallbackWidth, height: aspect ? fallbackWidth / aspect : SVG_DEFAULT_SIZE.height, declared: false };
}

/** Whether the bytes carry the signature of this image type. */
function hasSignature(body: Uint8Array, mimeType: string): boolean {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => body[i + j] === b);
  switch (mimeType) {
    case 'image/png':
    case 'image/apng':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return sniffImageType(body) !== null;
    case 'image/bmp': return at(0, [0x42, 0x4d]);
    case 'image/x-icon': return at(0, [0, 0, 1, 0]);
    case 'image/avif': return at(4, [0x66, 0x74, 0x79, 0x70]); // ....ftyp
    case 'image/svg+xml': return looksLikeMarkup(body);
    default: return false;
  }
}

/** Whether the bytes stop before the image's own end, judged by the format
 * the bytes are (whatever the header claimed). PNG and JPEG are walked
 * structurally rather than searched for their end marker, because cameras
 * append data after it (Samsung SEFT trailers, Motion Photo videos, MPF
 * secondary images) and an EXIF thumbnail carries an end marker of its own
 * near the start. A body whose structure doesn't parse is not judged here —
 * the browser's decoder has the last word on those. */
function endsEarly(body: Uint8Array, mimeType: string): boolean {
  switch (sniffImageType(body)) {
    case 'image/png': return pngEndsEarly(body);
    case 'image/jpeg': return jpegEndsEarly(body);
    case 'image/gif': return gifEndsEarly(body);
    // RIFF length counts everything after its own 8 bytes.
    case 'image/webp': return body.length < u32le(body, 4) + 8;
  }
  // Formats without a sniffable signature, judged when declared: both state
  // their extent in a header.
  if (mimeType === 'image/bmp' && hasSignature(body, mimeType) && body.length >= 6) {
    return body.length < u32le(body, 2); // BITMAPFILEHEADER bfSize
  }
  if (mimeType === 'image/x-icon' && hasSignature(body, mimeType) && body.length >= 6) {
    // ICONDIR, then one 16-byte entry per image: size at +8, offset at +12.
    const count = body[4] | (body[5] << 8);
    let end = 6 + count * 16;
    for (let i = 0; i < count && 6 + i * 16 + 16 <= body.length; i++) {
      const entry = 6 + i * 16;
      end = Math.max(end, u32le(body, entry + 12) + u32le(body, entry + 8));
    }
    return body.length < end;
  }
  return false;
}

const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** Walk GIF blocks to the trailer: the header, logical screen descriptor and
 * global colour table, then image descriptors (with any local colour table
 * and LZW sub-blocks) and extensions (with sub-blocks). */
function gifEndsEarly(body: Uint8Array): boolean {
  const colourTable = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  /** Past the sub-blocks' terminator, or -1 when the body ends inside them. */
  const skipSubBlocks = (pos: number) => {
    while (pos < body.length && body[pos] !== 0) pos += body[pos] + 1;
    return pos < body.length ? pos + 1 : -1;
  };
  let pos = 13 + colourTable(body[10]);
  let sawImage = false;
  while (pos < body.length) {
    const block = body[pos];
    if (block === 0x3b) return false; // trailer
    if (block === 0x2c) { // image descriptor
      if (pos + 10 > body.length) return true;
      pos = skipSubBlocks(pos + 10 + colourTable(body[pos + 9]) + 1); // +1: LZW minimum code size
      sawImage = true;
    } else if (block === 0x21) { // extension: introducer, label, sub-blocks
      pos = skipSubBlocks(pos + 2);
    } else {
      return false; // not a structure we can follow
    }
    if (pos < 0) return true; // cut inside a block
  }
  // Every block closed. Some encoders and optimisers drop the trailer, and
  // browsers draw the image without it; only a GIF with no image is short.
  return !sawImage;
}

const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];

/** Walk PNG chunks (length, type, data, CRC) from the signature to IEND. */
function pngEndsEarly(body: Uint8Array): boolean {
  let pos = 8;
  while (pos + 8 <= body.length) {
    const length = u32be(body, pos);
    const isIend = body[pos + 4] === 0x49 && body[pos + 5] === 0x45 && body[pos + 6] === 0x4e && body[pos + 7] === 0x44;
    if (isIend) return false;
    pos += 12 + length;
  }
  return true;
}

/** Walk JPEG marker segments to the first scan, then its entropy-coded data
 * to EOI. Inside scan data 0xFF is followed by 0x00 (stuffing), a restart
 * marker, or fill 0xFF; any other marker (another scan's tables in a
 * progressive JPEG) resumes the segment walk. */
function jpegEndsEarly(body: Uint8Array): boolean {
  let pos = 2;
  while (pos + 1 < body.length) {
    if (body[pos] !== 0xff) return false; // not a structure we can follow
    const marker = body[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0xd9) return false; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; } // no length
    if (pos + 4 > body.length) return true;
    const segmentEnd = pos + 2 + u16be(body, pos + 2);
    if (marker !== 0xda) { pos = segmentEnd; continue; }
    // Start of scan: skip its header, then scan the entropy-coded data.
    let i = segmentEnd;
    for (; i + 1 < body.length; i++) {
      if (body[i] !== 0xff) continue;
      const next = body[i + 1];
      if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) continue;
      break;
    }
    if (i + 1 >= body.length) return true;
    pos = i;
  }
  return true;
}

/** Codings `decodeHttpBody` (http-body.ts) undoes, as it compares them: the
 * whole header value, so a stacked coding like `gzip, br` is not one. */
const RUNNER_DECODED_CODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/** The Content-Encoding still applied to the stored bytes, or null when they
 * are decoded. The runner keeps the original bytes when it cannot decompress
 * them — a cut-off stream, a raw-deflate body zlib rejects, or a coding it
 * doesn't know (zstd, stacked codings).
 *
 * For a coding the runner does decode, a leftover is claimed only when the
 * bytes show that coding's own header (gzip's magic, zlib's checked header):
 * br and raw deflate have none, and a body that is simply not the image it
 * claims must not be reported as compressed. For a coding the runner never
 * decodes, bytes that already carry the image's signature mean some other
 * producer (the `request` fixture's fetch) decoded them. */
function undecodedEncoding(body: Uint8Array, mimeType: string, headers: Record<string, string>): string | null {
  const encoding = (headerValue(headers, 'content-encoding') ?? '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return null;
  // Bytes that are an image (the declared one, or another format served under
  // the wrong type — a PNG favicon labelled image/x-icon) are decoded.
  if (hasSignature(body, mimeType) || sniffImageType(body) !== null) return null;
  if (encoding === 'gzip' || encoding === 'x-gzip') return body[0] === 0x1f && body[1] === 0x8b ? encoding : null;
  if (encoding === 'deflate') return body.length >= 2 && (body[0] & 0x0f) === 8 && ((body[0] << 8) | body[1]) % 31 === 0 ? encoding : null;
  if (RUNNER_DECODED_CODINGS.has(encoding)) return null;
  return encoding;
}

/** Whether a body starts, after whitespace and a UTF-8 BOM, with `<`. */
function looksLikeMarkup(body: Uint8Array): boolean {
  let i = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  while (i < body.length && (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)) i++;
  return body[i] === 0x3c;
}

/** How much of the body is held, of how much, when it is only part; else null.
 *
 * Without framing the stored bytes are the wire bytes, so the recorded size
 * and a Content-Length (which also catches reads the proxy gave up on part
 * way) compare directly with their length.
 *
 * Compressed or chunked bodies have a wire size that differs from the
 * decoded length in either direction. Two wire-to-wire comparisons remain: a
 * recorded wire size above the daemon's storage cap means the tail was
 * dropped, and — for a compressed body that isn't chunked — a Content-Length
 * above the recorded wire size means the transfer stopped short. Entries
 * whose recorded size is the decoded length (the `request` fixture's, which
 * fetch decompresses) are recognised by that equality and not judged, so a
 * Content-Length for the compressed form can't trip them. */
function truncatedFrom(captured: number, declared: number, headers: Record<string, string>): { captured: number; declared: number } | null {
  const contentLength = Number(headerValue(headers, 'content-length'));
  const hasContentLength = headerValue(headers, 'content-length') !== undefined && Number.isSafeInteger(contentLength);
  if (!isWireFramed(headers)) {
    const full = Math.max(declared, hasContentLength ? contentLength : 0);
    return full > captured ? { captured, declared: full } : null;
  }
  if (declared === captured) return null;
  if (declared > MAX_CAPTURED_BODY_BYTES) return { captured: Math.min(declared, MAX_CAPTURED_BODY_BYTES), declared };
  if (!isChunked(headers) && hasContentLength && contentLength > declared) return { captured: declared, declared: contentLength };
  return null;
}
