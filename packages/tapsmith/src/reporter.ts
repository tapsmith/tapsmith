/**
 * Reporter API and plugin system.
 *
 * Reporters receive lifecycle events during a test run. Multiple reporters
 * can be active concurrently. Built-in reporters (list, line, dot, json,
 * junit, html, github, blob) implement this interface, and custom reporters
 * can be provided as objects or npm packages.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suggestFrom, unwrapCommonJsModule, type TapsmithConfig } from './config.js';
import { BUILT_IN_REPORTERS, parseReporterList } from './reporter-names.js';
import type { TestResult, SuiteResult } from './runner.js';

// ─── Reporter types ───

/** The whole run's outcome, passed to `onRunEnd()`. */
export interface FullResult {
  /** `'failed'` if any test failed, `'passed'` otherwise. */
  status: 'passed' | 'failed'
  /** Total wall-clock time including setup and tests. */
  duration: number
  /** Time spent on device provisioning, APK install, agent startup, etc. */
  setupDuration?: number
  /** Every test's result, flat. */
  tests: TestResult[]
  /** One root suite per test file, its describe blocks nested under it. */
  suites: SuiteResult[]
}

/** Extra context for `onRunStart()`. */
export interface RunStartInfo {
  /**
   * True when `tapsmith merge-reports` is replaying shards' blob reports: no
   * tests run, and `fileCount` is 0 because the merge runs no files.
   */
  merge?: boolean
}

export interface TestStartInfo {
  workerIndex?: number
  project?: string
}

/**
 * A custom reporter: implement the callbacks you need. Each is optional and
 * is called as the run progresses; a callback that throws is logged and
 * does not stop the run.
 */
export interface TapsmithReporter {
  /** Called once before any test runs, with the resolved config and the number of test files. */
  onRunStart?(config: TapsmithConfig, fileCount: number, info?: RunStartInfo): void
  /** Called when a test file starts running. */
  onTestFileStart?(filePath: string): void
  /** Called when a test starts, with its full title (describe titles joined with " > "). */
  onTestStart?(fullName: string, filePath?: string, info?: TestStartInfo): void
  /** Called when a test ends, with its result. */
  onTestEnd?(test: TestResult): void
  /** Called when a test file finishes, with its tests' results. */
  onTestFileEnd?(filePath: string, results: TestResult[]): void
  /**
   * Called when a file is run again from the start after an infrastructure
   * error; the `discardedCount` results already reported for it are replaced.
   */
  onTestFileRetry?(filePath: string, discardedCount: number): void
  /** Called once after the last test; the run waits for a returned promise. */
  onRunEnd?(result: FullResult): Promise<void> | void
  /** Called for an error that is not a test's own failure. */
  onError?(error: Error): void
}

// ─── Reporter configuration ───

/** A reporter name with optional options, e.g. ['json', { outputFile: 'r.json' }] */
export type ReporterDescription = string | [string, Record<string, unknown>]

/** Config value for the `reporter` field. */
export type ReporterConfig = ReporterDescription | ReporterDescription[]

// ─── Reporter dispatcher ───

/**
 * Fans out reporter events to multiple reporters. Errors in individual
 * reporters are caught and logged to stderr so they don't break the run.
 */
export class ReporterDispatcher implements TapsmithReporter {
  private _reporters: TapsmithReporter[];

  constructor(reporters: TapsmithReporter[]) {
    this._reporters = reporters;
  }

  onRunStart(config: TapsmithConfig, fileCount: number, info?: RunStartInfo): void {
    for (const r of this._reporters) {
      try {
        r.onRunStart?.(config, fileCount, info);
      } catch (err) {
        this._logError('onRunStart', err);
      }
    }
  }

  onTestFileStart(filePath: string): void {
    for (const r of this._reporters) {
      try {
        r.onTestFileStart?.(filePath);
      } catch (err) {
        this._logError('onTestFileStart', err);
      }
    }
  }

  onTestStart(fullName: string, filePath?: string, info?: TestStartInfo): void {
    for (const r of this._reporters) {
      try {
        r.onTestStart?.(fullName, filePath, info);
      } catch (err) {
        this._logError('onTestStart', err);
      }
    }
  }

  onTestEnd(test: TestResult): void {
    for (const r of this._reporters) {
      try {
        r.onTestEnd?.(test);
      } catch (err) {
        this._logError('onTestEnd', err);
      }
    }
  }

  onTestFileEnd(filePath: string, results: TestResult[]): void {
    for (const r of this._reporters) {
      try {
        r.onTestFileEnd?.(filePath, results);
      } catch (err) {
        this._logError('onTestFileEnd', err);
      }
    }
  }

  onTestFileRetry(filePath: string, discardedCount: number): void {
    for (const r of this._reporters) {
      try {
        r.onTestFileRetry?.(filePath, discardedCount);
      } catch (err) {
        this._logError('onTestFileRetry', err);
      }
    }
  }

  async onRunEnd(result: FullResult): Promise<void> {
    for (const r of this._reporters) {
      try {
        await r.onRunEnd?.(result);
      } catch (err) {
        this._logError('onRunEnd', err);
      }
    }
  }

  onError(error: Error): void {
    for (const r of this._reporters) {
      try {
        r.onError?.(error);
      } catch (err) {
        this._logError('onError', err);
      }
    }
  }

  private _logError(hook: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Reporter error in ${hook}: ${msg}\n`);
  }
}

// ─── Reporter factory ───

/** How `createReporters` finds custom reporter modules. */
export interface CreateReportersOptions {
  /** The base a relative custom-reporter path is resolved against: the config's `rootDir`. */
  rootDir: string
}

/**
 * A reporter that could not be created. `unknown`: no built-in reporter, file
 * or package has that name, and the message is the whole story. `load-failed`:
 * the custom reporter's module was found, but importing or constructing it
 * threw; `cause` is that error, whose stack points into the user's code.
 */
export class ReporterLoadError extends Error {
  readonly kind: 'unknown' | 'load-failed';

  constructor(message: string, kind: 'unknown' | 'load-failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReporterLoadError';
    this.kind = kind;
  }
}

export async function createReporters(
  config: ReporterConfig | undefined,
  options: CreateReportersOptions,
): Promise<TapsmithReporter[]> {
  const descriptions = normalizeReporterConfig(config);
  const reporters: TapsmithReporter[] = [];

  for (const desc of descriptions) {
    const [name, reporterOptions] = typeof desc === 'string' ? [desc, {}] : desc;
    reporters.push(await resolveReporter(name, reporterOptions ?? {}, options.rootDir));
  }

  return reporters;
}

/** The `reporter` config as a list of descriptions, defaults applied. */
export function normalizeReporterConfig(config: ReporterConfig | undefined): ReporterDescription[] {
  if (!config) {
    // Default to `list` everywhere (including CI). The per-test list output is
    // more legible than `dot` when a CI log is the only artifact you have to
    // debug a failure; opt into `dot` explicitly via the `reporter` config.
    return ['list'];
  }

  if (typeof config === 'string') {
    return [config];
  }

  // Check if it's a single tuple like ['json', { outputFile: '...' }]
  if (isSingleTuple(config)) {
    return [config as [string, Record<string, unknown>]];
  }

  return config as ReporterDescription[];
}

/** Reporters that end a run with a summary line in the terminal. */
const SUMMARY_REPORTERS = new Set(['list', 'line', 'dot']);

/**
 * Whether the configured reporters print a run summary in the terminal —
 * so watch mode, which prints its key list after each run, need not print a
 * second one.
 */
export function printsRunSummary(config: ReporterConfig | undefined): boolean {
  return normalizeReporterConfig(config).some((desc) => SUMMARY_REPORTERS.has(typeof desc === 'string' ? desc : desc[0]));
}

function isSingleTuple(config: ReporterConfig): boolean {
  return (
    Array.isArray(config) &&
    config.length === 2 &&
    typeof config[0] === 'string' &&
    // `['html', CI ? { open: 'never' } : undefined]`: options left to the reporter's defaults.
    (config[1] === undefined || (typeof config[1] === 'object' && config[1] !== null && !Array.isArray(config[1])))
  );
}

async function resolveReporter(
  name: string,
  options: Record<string, unknown>,
  rootDir: string,
): Promise<TapsmithReporter> {
  switch (name) {
    case 'list': {
      const { ListReporter } = await import('./reporters/list.js');
      return new ListReporter();
    }
    case 'line': {
      const { LineReporter } = await import('./reporters/line.js');
      return new LineReporter();
    }
    case 'dot': {
      const { DotReporter } = await import('./reporters/dot.js');
      return new DotReporter();
    }
    case 'json': {
      const { JsonReporter } = await import('./reporters/json.js');
      return new JsonReporter(options);
    }
    case 'junit': {
      const { JUnitReporter } = await import('./reporters/junit.js');
      return new JUnitReporter(options);
    }
    case 'html': {
      const { HtmlReporter } = await import('./reporters/html.js');
      return new HtmlReporter(options);
    }
    case 'github': {
      const { GitHubActionsReporter } = await import('./reporters/github.js');
      return new GitHubActionsReporter();
    }
    case 'blob': {
      const { BlobReporter } = await import('./reporters/blob.js');
      return new BlobReporter(options);
    }
    default:
      return loadCustomReporter(name, options, rootDir);
  }
}

const REPORTER_HOOKS = [
  'onRunStart', 'onTestFileStart', 'onTestStart', 'onTestEnd', 'onTestFileEnd', 'onTestFileRetry', 'onRunEnd', 'onError',
] as const satisfies readonly (keyof TapsmithReporter)[];

/** A specifier that names a file rather than a package: `./r.ts`, `../r.js`, `/abs/r.mjs`, `file:…`. */
function isPathSpecifier(name: string): boolean {
  return name.startsWith('.') || name.startsWith('file:') || path.isAbsolute(name);
}

/** The package a bare specifier imports: `pkg/sub` → `pkg`, `@scope/pkg/sub` → `@scope/pkg`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function unknownReporterMessage(name: string): string {
  const suggestion = name.includes(',') ? undefined : suggestFrom(name, BUILT_IN_REPORTERS);
  const head = `Unknown reporter "${name}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}.`;
  const builtIns = `Built-in reporters: ${BUILT_IN_REPORTERS.join(', ')} — or the path or package name of a custom reporter module.`;
  // `--reporter list,json` is split on the command line; a config string is
  // one name, as in Playwright.
  const names = parseReporterList(name);
  const commaHint = names.length > 1
    ? ` In the config, list each reporter on its own: reporter: [${names.map((n) => `['${n}']`).join(', ')}]`
    : '';
  return `${head} ${builtIns}${commaHint}`;
}

/**
 * Whether an import failed because `specifier` itself is not installed, as
 * opposed to a module it imports being missing (the reporter's own bug).
 */
function isMissingPackage(err: unknown, specifier: string): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  const message = err instanceof Error ? err.message : String(err);
  const pkg = packageNameOf(specifier);
  return message.includes(`'${pkg}'`) || message.includes(`"${pkg}"`);
}

/**
 * Load a custom reporter: a file path (relative to `rootDir`, as other paths
 * in the config are) or an installed package. Its default export is a class,
 * constructed with the reporter's options, or a reporter object.
 */
async function loadCustomReporter(
  name: string,
  options: Record<string, unknown>,
  rootDir: string,
): Promise<TapsmithReporter> {
  let specifier = name;
  if (isPathSpecifier(name)) {
    const file = name.startsWith('file:') ? fileURLToPath(name) : path.resolve(rootDir, name);
    if (!fs.existsSync(file)) {
      throw new ReporterLoadError(
        `Reporter "${name}" not found: no file at ${file}. A relative reporter path is resolved against rootDir.`,
        'unknown',
      );
    }
    specifier = pathToFileURL(file).href;
  }

  let mod: Record<string, unknown>;
  try {
    mod = await import(specifier) as Record<string, unknown>;
  } catch (err) {
    if (!isPathSpecifier(name) && isMissingPackage(err, name)) {
      throw new ReporterLoadError(unknownReporterMessage(name), 'unknown', { cause: err });
    }
    throw loadFailed(name, err);
  }

  const exported = reporterExportOf(mod);
  if (exported === undefined || exported === null) {
    throw new ReporterLoadError(
      `Reporter "${name}" failed to load: its module has no default export (a reporter class or object).`,
      'load-failed',
    );
  }
  if (typeof exported !== 'function') return exported as TapsmithReporter;
  try {
    return new (exported as new (options: Record<string, unknown>) => TapsmithReporter)(options);
  } catch (err) {
    throw loadFailed(name, err);
  }
}

/**
 * What a custom reporter's module exports as the reporter: its default export
 * (unwrapped from a CommonJS `module.exports` compiled with `__esModule`), or,
 * without one, the module itself when its named exports are hooks.
 */
export function reporterExportOf(namespace: Record<string, unknown>): unknown {
  const mod = unwrapCommonJsModule(namespace);
  return mod.default ?? (REPORTER_HOOKS.some((hook) => typeof mod[hook] === 'function') ? mod : undefined);
}

function loadFailed(name: string, err: unknown): ReporterLoadError {
  const message = err instanceof Error ? err.message : String(err);
  return new ReporterLoadError(`Reporter "${name}" failed to load: ${message}`, 'load-failed', { cause: err });
}
