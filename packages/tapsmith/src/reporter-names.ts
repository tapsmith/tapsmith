/**
 * Reporter names, without loading any reporter: the CLI parser imports this,
 * and it must stay light.
 */

/** The reporters Tapsmith ships, in the order help and errors list them. */
export const BUILT_IN_REPORTERS = ['list', 'line', 'dot', 'json', 'junit', 'html', 'github', 'blob'] as const;

/**
 * The reporter names in a `--reporter` value: comma-separated, as in
 * Playwright (`--reporter list,junit`), with spaces trimmed and empty
 * entries dropped.
 */
export function parseReporterList(value: string): string[] {
  return value.split(',').map((n) => n.trim()).filter((n) => n !== '');
}
