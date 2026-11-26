/**
 * The stale-build edits already warned about this session (one key per
 * build and edit, see `takeStaleBuildWarning`). Watch and MCP runs fork a
 * fresh child per file, so a per-process record alone warned under every
 * file of every run; the parent hands each child the record and folds back
 * what the child warned about, like `capture-warnings.ts`.
 *
 * Its own module, free of imports, so a parent can carry it without loading
 * the stale-build check.
 */
const warned = new Set<string>();

/** Every stale-build edit warned about this session, for a child the parent forks or for the parent. */
export function knownStaleBuildWarnings(): string[] {
  return [...warned];
}

/** Take the edits a parent or a child warned about. */
export function rememberStaleBuildWarnings(keys: readonly string[] | undefined): void {
  for (const key of keys ?? []) warned.add(key);
}

/** Whether the session has already shown the warning for this edit. */
export function staleBuildWarned(key: string): boolean {
  return warned.has(key);
}

/** Record that a test result carried the warning for this edit. */
export function markStaleBuildWarned(key: string): void {
  warned.add(key);
}

/** Forget every edit (tests). */
export function forgetStaleBuildWarnings(): void {
  warned.clear();
}
