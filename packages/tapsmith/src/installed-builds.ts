/**
 * The build each device was last proven to hold (PILOT-1397), by serial:
 * the configured artifact's path and the stamps (`build-stamp.ts`) of the
 * build on disk and of the copy on the device when the full install check
 * last passed, or installed it. Per process. A parent that forks a child per
 * run (watch, MCP) hands the child its copy and folds back what the child
 * learnt, so only a run after a change pays for the full check.
 *
 * Its own module, free of imports, so a parent can carry it without loading
 * the device layer.
 */
export const verifiedBuilds = new Map<string, string>();

/** What this process knows about the builds on its devices, for a child it forks. */
export function knownInstalledBuilds(): Record<string, string> {
  return Object.fromEntries(verifiedBuilds);
}

/** Take what a parent or a child knows about the builds on their devices. */
export function rememberInstalledBuilds(builds: Record<string, string> | undefined): void {
  for (const [serial, token] of Object.entries(builds ?? {})) verifiedBuilds.set(serial, token);
}
