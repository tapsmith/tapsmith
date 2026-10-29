/**
 * How an error that has more to say than one line says it: a one-line
 * headline, then the detail — the cause, a build excerpt, the daemon's own
 * output, a log path — bounded and indented under it.
 *
 * Start errors cross several layers before anyone reads them (a worker's
 * daemon, the worker, its device target, the run), and each layer used to
 * either cut the message to its first line or paste it in flush-left. Every
 * layer formatting with this one shape is what lets the innermost detail
 * survive, readably nested, to the outermost message.
 */

// ─── Bounds ───

/** Detail lines kept in one message: the head, then the tail. */
const MAX_DETAIL_LINES = 40;
/**
 * Of those, how many come from the end. The tail is where log paths and the
 * daemon's last words are; the head is where the cause is.
 */
const TAIL_DETAIL_LINES = 5;
/** Same cap as the iOS agent build excerpt (ios-simulator-build.ts). */
const MAX_LINE_LENGTH = 1000;

const INDENT = '  ';

/**
 * `lines`, at most {@link MAX_DETAIL_LINES} of them and none over
 * {@link MAX_LINE_LENGTH} characters. A longer detail keeps its first and last
 * lines, with a marker saying how many were left out between them.
 */
export function boundDetailLines(lines: readonly string[]): string[] {
  const capped = lines.map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));
  if (capped.length <= MAX_DETAIL_LINES) return capped;
  // One line goes to the marker.
  const head = MAX_DETAIL_LINES - TAIL_DETAIL_LINES - 1;
  const omitted = capped.length - head - TAIL_DETAIL_LINES;
  return [...capped.slice(0, head), `… (${omitted} more lines)`, ...capped.slice(-TAIL_DETAIL_LINES)];
}

/** Blank lines at either end carry nothing; blank lines inside separate sections. */
function trimBlankEnds(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

// ─── Formatting ───

/**
 * `headline`, then `detail` bounded and indented under it. A detail line that
 * is itself indented (a nested message's own detail) keeps its indentation,
 * one level deeper.
 */
export function withDetail(headline: string, detail: readonly string[]): string {
  const lines = boundDetailLines(trimBlankEnds(detail));
  return [headline, ...lines.map((line) => (line === '' ? '' : `${INDENT}${line}`))].join('\n');
}

/**
 * `message` with `label` in front of its first line and its later lines
 * indented under it as detail: "ios: <headline>" then "  <detail>".
 */
export function labelledMessage(label: string, message: string): string {
  const [first, ...rest] = message.split('\n');
  return withDetail(`${label}${first}`, rest);
}

/**
 * A message's headline and the rest, for a printer that styles them
 * differently. The detail keeps its indentation; only blank lines at its
 * ends go (a whole-string `trim()` would also strip the first line's
 * indent, leaving it flush-left above its indented siblings).
 */
export function splitHeadline(message: string): { headline: string; detail: string } {
  const [headline, ...rest] = message.split('\n');
  return { headline, detail: trimBlankEnds(rest).join('\n').trimEnd() };
}
