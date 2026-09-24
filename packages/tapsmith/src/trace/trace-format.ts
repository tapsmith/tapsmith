/**
 * The trace archive's format contract: its version, and the rules that keep
 * an archive portable off the machine that recorded it.
 *
 * Documented in `docs/trace-format.md` and machine-checkable against
 * `schema/trace-format.schema.json` (shipped as `dist/schema/`). Keep all
 * three in step — the version is what a server-side indexer branches on.
 */

// Browser-safe: the trace viewer bundles this module. Filesystem-aware
// helpers live in archive-paths.ts.

// ─── Version ───

/**
 * Format version written to `metadata.json#version`.
 *
 * Bump it for any change an existing reader could misread: removing or
 * renaming a field or member, changing what a value means, or changing a
 * closed set (the schema's `enum`s: testStatus, console level/source, device
 * platform). Adding an optional field, event type, archive member, or a value
 * of an open set does not bump it — readers must ignore what they do not
 * recognise.
 *
 * History:
 *  - 1: initial format. Paths (`testFile`, stack frames, `sources.json` keys)
 *       were absolute on the recording machine.
 *  - 2: those paths are POSIX, relative to the project's `rootDir`.
 */
export const TRACE_FORMAT_VERSION = 2;

/**
 * Why a reader built for {@link TRACE_FORMAT_VERSION} cannot read an archive
 * with this `metadata.json`, or `undefined` when it can.
 */
export function traceFormatProblem(metadata: unknown): string | undefined {
  const version = metadata && typeof metadata === 'object'
    ? (metadata as { version?: unknown }).version
    : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return 'Not a Tapsmith trace: metadata.json has no format version.';
  }
  if (version > TRACE_FORMAT_VERSION) {
    const recordedBy = (metadata as { tapsmithVersion?: unknown }).tapsmithVersion;
    const by = typeof recordedBy === 'string' && recordedBy ? ` by Tapsmith ${recordedBy}` : '';
    return `This trace was recorded${by} in format version ${version}, but this version ` +
      `of Tapsmith reads format versions up to ${TRACE_FORMAT_VERSION}. Upgrade Tapsmith to open it.`;
  }
  return undefined;
}
