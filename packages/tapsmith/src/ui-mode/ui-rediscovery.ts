/**
 * Which files a UI-mode refresh queues for discovery.
 *
 * An MCP call syncs the session's test files with the disk instead of waiting
 * for the watcher, so it must pick up exactly what the watcher would have:
 * files written or edited since the session started, and files gone from disk.
 * Every file the configured glob matches is not that. A session started on a
 * selection (`tapsmith test --ui login.test.ts`) knows only the selection, and
 * queuing the rest of the glob grew it to the whole suite on the first call.
 *
 * Known files that changed are left to the watcher, which reports them.
 */
export function filesToRediscover(opts: {
  /** What the configured `testMatch` selects now, absolute paths. */
  globbed: readonly string[]
  /** The session's test files. */
  known: readonly string[]
  /** When the session started, as a `Date.now()` time. */
  since: number
  /** The file's mtime in ms, or `undefined` when it cannot be read. */
  mtimeOf: (file: string) => number | undefined
  /** A path the discovery watcher ignores (the output dir, node_modules). */
  isIgnored: (file: string) => boolean
}): string[] {
  const known = new Set(opts.known);
  const globbed = new Set(opts.globbed);
  const queued: string[] = [];
  for (const file of opts.globbed) {
    if (known.has(file) || opts.isIgnored(file)) continue;
    const mtime = opts.mtimeOf(file);
    if (mtime !== undefined && mtime >= opts.since) queued.push(file);
  }
  for (const file of opts.known) {
    if (!globbed.has(file)) queued.push(file);
  }
  return queued;
}
