import { normalizeGrep } from './config.js';

/**
 * Whether a test's fully-qualified name (`describe > test`) matches a `test`
 * filter. Case-insensitive substring match — intentionally grep-like, so it
 * subsumes exact-name and describe-prefix matches and may match several tests.
 *
 * This is distinct from `grep`/`grepInvert`, which are `RegExp` by contract;
 * `test`/`testFilter` is a forgiving substring so callers (and LLM agents) can
 * pass a bare fragment of a test name and have it just work.
 */
export function matchesTestFilter(fullName: string, filter: string): boolean {
  return fullName.toLowerCase().includes(filter.toLowerCase());
}

/** The selection filters a test's full name must pass to run. */
export interface SelectionFilters {
  testFilter?: string;
  /**
   * Run only tests whose full name is exactly one of these — an explicit
   * selection, as UI mode's Run all sends for the tests visible in a filtered
   * tree. Intersected with every other filter.
   */
  fullNames?: readonly string[];
  grep?: RegExp[];
  /** Intersected with `grep`: a test must match both sets. */
  projectGrep?: RegExp[];
  grepInvert?: RegExp[];
  /** Unioned with `grepInvert`: matching either excludes the test. */
  projectGrepInvert?: RegExp[];
}

/** A run's grep filters, root and project, each empty when not set. */
export interface GrepFilters {
  grep: RegExp[];
  grepInvert: RegExp[];
  projectGrep: RegExp[];
  projectGrepInvert: RegExp[];
}

/** Where `grep` / `grepInvert` are set: the root config, or one of its projects. */
export interface GrepSource {
  grep?: RegExp | RegExp[];
  grepInvert?: RegExp | RegExp[];
}

/**
 * The grep filters a test running under `project` must pass: the root's and
 * the project's, as every run path applies them (root and project `grep`
 * intersect, their `grepInvert`s union — see `passesSelectionFilters`).
 */
export function grepFiltersFor(root: GrepSource, project?: GrepSource): GrepFilters {
  return {
    grep: normalizeGrep(root.grep),
    grepInvert: normalizeGrep(root.grepInvert),
    projectGrep: normalizeGrep(project?.grep),
    projectGrepInvert: normalizeGrep(project?.grepInvert),
  };
}

/** Whether any of these grep filters is set. */
export function hasGrepFilter(filters: GrepFilters): boolean {
  return filters.grep.length > 0 || filters.grepInvert.length > 0
    || filters.projectGrep.length > 0 || filters.projectGrepInvert.length > 0;
}

/**
 * Whether a test's fully-qualified name passes every selection filter.
 *
 * - `testFilter`: case-insensitive substring (`matchesTestFilter`).
 * - `fullNames`: exact full names; an empty list selects nothing.
 * - `grep` / `projectGrep`: each non-empty set needs at least one match.
 * - `grepInvert` / `projectGrepInvert`: no regex in either may match.
 */
export function passesSelectionFilters(fullName: string, filters: SelectionFilters): boolean {
  if (filters.testFilter && !matchesTestFilter(fullName, filters.testFilter)) return false;
  if (filters.fullNames && !filters.fullNames.includes(fullName)) return false;
  if (!matchesEverySet(fullName, filters.grep) || !matchesEverySet(fullName, filters.projectGrep)) return false;
  if (matchesAny(fullName, filters.grepInvert) || matchesAny(fullName, filters.projectGrepInvert)) return false;
  return true;
}

function matchesEverySet(fullName: string, patterns: RegExp[] | undefined): boolean {
  return !patterns || patterns.length === 0 || matchesAny(fullName, patterns);
}

// Reset lastIndex before each test(): a RegExp with the `g` flag is stateful.
function matchesAny(fullName: string, patterns: RegExp[] | undefined): boolean {
  return !!patterns && patterns.some((re) => (re.lastIndex = 0, re.test(fullName)));
}

/** A run's selection that matched no test: what was checked. */
export interface SelectionMiss {
  fileCount: number;
  /** Every test's full name, in file order. */
  testNames: string[];
}

/**
 * Whether the selection filters select no test at all in these files, given
 * each file's test names (read without running any test body) — so a `--grep`
 * that matches nothing fails before any device work, as Playwright lists its
 * tests before starting workers.
 *
 * `namesOf` returns `undefined` for a file that failed to load: its tests are
 * unknown, so no conclusion is drawn, and the run itself reports the load
 * error. A skipped test that passes the filters counts as selected — the run
 * reports it as skipped rather than as "No tests found". Files that yield no
 * test name at all conclude nothing either.
 */
export function findSelectionMiss(
  entries: Array<{ file: string; filters: SelectionFilters }>,
  namesOf: (file: string) => string[] | undefined,
): SelectionMiss | undefined {
  const testNames: string[] = [];
  const files = new Set<string>();
  for (const { file, filters } of entries) {
    const names = namesOf(file);
    if (!names) return undefined;
    files.add(file);
    for (const fullName of names) {
      if (passesSelectionFilters(fullName, filters)) return undefined;
      testNames.push(fullName);
    }
  }
  // Files that all load yet register no test at all say more about how the
  // names were read (another tapsmith instance's registry) than about the
  // suite: conclude nothing, and let the run report what it finds.
  if (testNames.length === 0) return undefined;
  return { fileCount: files.size, testNames: [...new Set(testNames)] };
}

const MAX_LISTED_TESTS = 10;

/** How `noTestsMatchFilterMessage` starts, for callers that parse a run's stderr. */
export const NO_TESTS_MATCH_FILTER_PREFIX = 'No tests found: no test matches';

/** The "No tests found" error for a `SelectionMiss`. */
export function noTestsMatchFilterMessage(
  miss: SelectionMiss,
  grep: RegExp | RegExp[] | undefined,
  grepInvert: RegExp | RegExp[] | undefined,
  /** Some project has its own grep / grepInvert, intersected with the root's. */
  projectFilters = false,
): string {
  const describe = (label: string, value: RegExp | RegExp[] | undefined): string | undefined => {
    const patterns = value === undefined ? [] : Array.isArray(value) ? value : [value];
    return patterns.length > 0 ? `${label} ${patterns.map(String).join(', ')}` : undefined;
  };
  const root = [describe('grep', grep), describe('grep-invert', grepInvert)].filter(Boolean).join(', ');
  const filters = !root
    ? 'the projects\' grep / grepInvert'
    : projectFilters ? `${root} together with the projects' grep / grepInvert` : root;
  const files = `${miss.fileCount} test file${miss.fileCount === 1 ? '' : 's'}`;
  const lines = [`${NO_TESTS_MATCH_FILTER_PREFIX} ${filters}.`];
  lines.push(
    `Checked ${miss.testNames.length} test name${miss.testNames.length === 1 ? '' : 's'} in ${files}; `
    + 'the patterns match against the full "describe > test" name. The tests are:',
  );
  for (const name of miss.testNames.slice(0, MAX_LISTED_TESTS)) lines.push(`  - ${name}`);
  if (miss.testNames.length > MAX_LISTED_TESTS) lines.push(`  … and ${miss.testNames.length - MAX_LISTED_TESTS} more`);
  return lines.join('\n');
}

/**
 * Whether a run under an active selection filter ran no test: it selected
 * none (the tests a filter excludes report no result) or only
 * skipped ones. The CLI fails such a run rather than reporting it green —
 * the safety net for a `--grep` the pre-run check could not judge.
 */
export function filterRanNothing(filterActive: boolean, results: ReadonlyArray<{ status: string }>): boolean {
  return filterActive && results.every((r) => r.status === 'skipped');
}
