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

/** Whether this edit is new to the session, recording it if so. */
export function firstStaleBuildWarning(key: string): boolean {
  if (warned.has(key)) return false;
  warned.add(key);
  return true;
}

/** Forget every edit (tests). */
export function forgetStaleBuildWarnings(): void {
  warned.clear();
}
