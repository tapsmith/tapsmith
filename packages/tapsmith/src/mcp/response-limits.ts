import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Budgets ───
//
// One MCP tool response is one JSON-RPC message, and clients cap how big a
// message may be: past the cap Claude Code drops the whole connection rather
// than the one result (PILOT-657). No client documents its cap, so every tool
// response is held to budgets well inside what clients are known to accept —
// the text near Claude Code's default MCP output size, the images to one
// Claude-API-sized image — whatever the suite size, error length or tree size.

/** Text across a response's text items, as UTF-8 bytes once JSON-escaped. */
export const MCP_TEXT_BUDGET_BYTES = 100 * 1024;
/** Base64 image (and audio) data across a response. */
export const MCP_IMAGE_BUDGET_BYTES = 5 * 1024 * 1024;
/**
 * The most a bounded response serialises to: both budgets plus room for the
 * JSON envelope, the omission notes and per-item overhead.
 */
export const MCP_RESPONSE_MAX_BYTES = MCP_TEXT_BUDGET_BYTES + MCP_IMAGE_BUDGET_BYTES + 16 * 1024;

/** Every text item keeps at least this much, so a later item never vanishes. */
const MIN_ITEM_BYTES = 256;
/** Room held back in a cut item for the omission marker. */
const MARKER_RESERVE_BYTES = 1024;
/** Share of a cut item kept from its start; the rest comes from its end. */
const HEAD_SHARE = 0.6;

/** Where to look for what a cut response left out, per tool. */
const TRUNCATION_HINTS: Record<string, string> = {
  tapsmith_run_tests: 'Use tapsmith_list_results (status "failed", or test "<name>") for each failure, and tapsmith_read_trace on its trace for the full detail.',
  tapsmith_list_results: 'Narrow it with the status, file or test filters to see the omitted results in full.',
  tapsmith_list_tests: 'Pass the file paths you need to tapsmith_run_tests, or read them directly, for the omitted part of the tree.',
  tapsmith_suite_status: 'Pass file to narrow the board; tapsmith_list_results has the latest run\'s results in full.',
  tapsmith_snapshot: 'The middle of the accessibility tree was omitted; use tapsmith_test_locator to check a specific locator.',
  tapsmith_read_trace: 'The trace\'s first and last steps are kept, with the Result section at the top; a failed step it names may be in the part left out.',
};

// ─── Sizing ───

/** Bytes one code point takes in a JSON string literal, UTF-8 encoded. */
function codePointCost(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2; // \" and \\
  if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate is escaped as \uXXXX
  if (cp < 0x10000) return 3;
  return 4;
}

/** Size of `text` inside a JSON message (UTF-8 bytes, quotes excluded). */
export function serializedTextBytes(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) as number;
    total += codePointCost(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return total;
}

/** The longest prefix of `text` that serialises within `maxBytes`, never splitting a surrogate pair. */
function headWithin(text: string, maxBytes: number): string {
  let used = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const cost = codePointCost(cp);
    if (used + cost > maxBytes) break;
    used += cost;
    i += cp > 0xffff ? 2 : 1;
  }
  return text.slice(0, i);
}

/** The longest suffix of `text` that serialises within `maxBytes`, never splitting a surrogate pair. */
function tailWithin(text: string, maxBytes: number): string {
  let used = 0;
  let j = text.length;
  while (j > 0) {
    const low = text.charCodeAt(j - 1);
    const isPair = low >= 0xdc00 && low <= 0xdfff && j >= 2
      && text.charCodeAt(j - 2) >= 0xd800 && text.charCodeAt(j - 2) <= 0xdbff;
    const cp = isPair ? (text.codePointAt(j - 2) as number) : low;
    const cost = codePointCost(cp);
    if (used + cost > maxBytes) break;
    used += cost;
    j -= isPair ? 2 : 1;
  }
  return text.slice(j);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ─── Truncation ───

/**
 * Cut `text` to `maxBytes` (serialised), keeping its start and its end — a
 * report's summary comes first and a failure, or a snapshot's locators, last —
 * with a marker in the middle that says how much went and where to find it.
 * Text already within budget is returned unchanged.
 */
export function truncateMiddle(text: string, maxBytes: number, hint?: string): string {
  const size = serializedTextBytes(text);
  if (size <= maxBytes) return text;
  const marker = (omitted: number): string =>
    `\n\n[… ${formatBytes(omitted)} omitted here: the response exceeded Tapsmith's MCP response limit.${hint ? ` ${hint}` : ''}]\n\n`;
  // The marker's own size depends on the omitted count, which depends on what
  // the marker leaves room for: start from an estimate and shrink until it fits.
  let keep = Math.max(0, maxBytes - serializedTextBytes(marker(size)));
  for (;;) {
    const head = headWithin(text, Math.floor(keep * HEAD_SHARE));
    const tail = tailWithin(text.slice(head.length), keep - serializedTextBytes(head));
    const omitted = size - serializedTextBytes(head) - serializedTextBytes(tail);
    const cut = `${head}${marker(omitted)}${tail}`;
    const over = serializedTextBytes(cut) - maxBytes;
    if (over <= 0 || keep === 0) return over <= 0 ? cut : headWithin(cut, maxBytes);
    keep = Math.max(0, keep - over);
  }
}

/**
 * Cap one value inside a tool's own output (an error message, a log line) at
 * `maxChars`, saying how much was cut. For the response as a whole, use
 * {@link boundToolResult}.
 */
export function clipText(text: string, maxChars: number, hint?: string): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  // Never leave half a surrogate pair at the cut.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}… [${text.length - cut} more characters${hint ? `; ${hint}` : ''}]`;
}

type ContentItem = CallToolResult['content'][number];

function binaryData(item: ContentItem): string | undefined {
  if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') return item.data;
  return undefined;
}

/**
 * Hold a tool result to the response budgets: text items are cut (start and
 * end kept, the omission announced in place) so their total fits
 * {@link MCP_TEXT_BUDGET_BYTES}, and images past {@link MCP_IMAGE_BUDGET_BYTES}
 * are dropped with a note naming how many. A result within budget is returned
 * as-is.
 */
export function boundToolResult(result: CallToolResult, toolName?: string): CallToolResult {
  const content = result.content ?? [];
  const hint = toolName ? TRUNCATION_HINTS[toolName] : undefined;

  const textSizes = content.map((item) => (item.type === 'text' ? serializedTextBytes(item.text) : 0));
  const totalText = textSizes.reduce((a, b) => a + b, 0);
  const totalBinary = content.reduce((sum, item) => sum + (binaryData(item)?.length ?? 0), 0);
  if (totalText <= MCP_TEXT_BUDGET_BYTES && totalBinary <= MCP_IMAGE_BUDGET_BYTES) return result;

  // Text: earlier items take what they need, but each later item keeps a
  // floor so a trailing note or label is shortened rather than starved.
  const textCount = content.filter((item) => item.type === 'text').length;
  // With thousands of items the floor itself must shrink to fit.
  const floor = Math.min(MIN_ITEM_BYTES, Math.floor((MCP_TEXT_BUDGET_BYTES - MARKER_RESERVE_BYTES) / Math.max(1, textCount)));
  let textLeft = MCP_TEXT_BUDGET_BYTES;
  let textItemsLeft = textCount;
  let imageLeft = MCP_IMAGE_BUDGET_BYTES;
  let droppedImages = 0;
  let droppedImageBytes = 0;
  const bounded: ContentItem[] = [];

  content.forEach((item, index) => {
    if (item.type === 'text') {
      textItemsLeft -= 1;
      const reserve = textItemsLeft * floor;
      const allowed = Math.max(floor, textLeft - reserve);
      const size = textSizes[index];
      if (size <= allowed) {
        textLeft -= size;
        bounded.push(item);
        return;
      }
      const cut = allowed > MARKER_RESERVE_BYTES
        ? truncateMiddle(item.text, allowed, hint)
        : headWithin(item.text, allowed);
      textLeft -= serializedTextBytes(cut);
      bounded.push({ ...item, text: cut });
      return;
    }
    const data = binaryData(item);
    if (data !== undefined) {
      if (data.length <= imageLeft) {
        imageLeft -= data.length;
        bounded.push(item);
      } else {
        droppedImages += 1;
        droppedImageBytes += data.length;
      }
      return;
    }
    bounded.push(item);
  });

  if (droppedImages > 0) {
    bounded.push({
      type: 'text',
      text: `[${droppedImages} image(s) omitted (${formatBytes(droppedImageBytes)} of base64): the response exceeded Tapsmith's ${formatBytes(MCP_IMAGE_BUDGET_BYTES)} MCP image limit.${hint ? ` ${hint}` : ''}]`,
    });
  }
  return { ...result, content: bounded };
}

/**
 * Shorten a thrown error's message to the text budget in place, so the
 * protocol layer's own error result (which carries the message) stays
 * bounded too. Returns the same error.
 */
export function boundThrownError(err: unknown): unknown {
  if (err instanceof Error && serializedTextBytes(err.message) > MCP_TEXT_BUDGET_BYTES) {
    err.message = truncateMiddle(err.message, MCP_TEXT_BUDGET_BYTES);
  }
  return err;
}
