import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';

// ─── pnpm's allowBuilds for Tapsmith's dependencies (PILOT-930) ───

/**
 * The dependencies with build scripts that a Tapsmith install brings in:
 * esbuild through tsx (its postinstall only re-checks the binary the
 * package manager already installed) and protobufjs through gRPC (an
 * advisory notice). Tapsmith works with both blocked (PILOT-560). pnpm 11
 * and later exit 1 over a build script nobody approved or denied, and only
 * the project can decide (a dependency cannot), so init records "no" for
 * the project, in the pnpm-workspace.yaml beside its lockfile.
 */
export const PNPM_DENIED_BUILDS = ['esbuild', 'protobufjs'] as const;

const WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * The pnpm settings that already decide a package's build script, besides
 * `allowBuilds`. pnpm 10 read these, from pnpm-workspace.yaml or the
 * `pnpm` field of package.json; a package listed in any of them was decided
 * by the project, so init leaves it alone.
 */
const LEGACY_BUILD_LISTS = ['onlyBuiltDependencies', 'ignoredBuiltDependencies', 'neverBuiltDependencies'] as const;

export type PnpmBuildsOutcome =
  /** Not a pnpm project, or no project to write to. */
  | { status: 'not-pnpm' }
  /** Every package is decided already: nothing written. */
  | { status: 'present' }
  /** No pnpm-workspace.yaml, and this pnpm needs none (10 and earlier only warn) or rejects one without `packages`. */
  | { status: 'skipped' }
  /** `file` is relative to the directory init runs in. */
  | { status: 'written'; file: string; created: boolean; names: string[] }
  | { status: 'failed'; warning: string };

/**
 * The directory whose pnpm-workspace.yaml pnpm reads for this project: the
 * nearest one up from `cwd` with a pnpm-workspace.yaml or pnpm-lock.yaml
 * (a workspace package's settings live at the workspace root), else `cwd`
 * itself when it has a package.json. Undefined when there is neither.
 */
export function pnpmRoot(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, WORKSPACE_FILE)) || fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  return fs.existsSync(path.join(cwd, 'package.json')) ? path.resolve(cwd) : undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Whether `settings` (a plain object of pnpm settings) already decides `name`. */
function decidedIn(settings: unknown, name: string): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const s = settings as Record<string, unknown>;
  if (s.dangerouslyAllowAllBuilds === true) return true;
  return LEGACY_BUILD_LISTS.some((key) => Array.isArray(s[key]) && (s[key] as unknown[]).includes(name));
}

/**
 * Why the document cannot take the entries, or undefined when it can: a
 * file with YAML errors, or one whose top level or `allowBuilds` is not a
 * mapping, is the user's to fix, and rewriting it could lose what they wrote.
 */
function unusable(doc: Document): string | undefined {
  if (doc.errors.length > 0) return `it is not valid YAML (${doc.errors[0]!.message.split('\n')[0]})`;
  if (doc.contents !== null && !isMap(doc.contents)) return 'its top level is not a mapping';
  const allowBuilds = doc.get('allowBuilds', true);
  if (allowBuilds !== undefined && !isMap(allowBuilds) && !(isScalar(allowBuilds) && allowBuilds.value === null)) {
    return '`allowBuilds` in it is not a mapping';
  }
  return undefined;
}

/**
 * The packages in PNPM_DENIED_BUILDS that the project at `root` has not
 * decided: no boolean under `allowBuilds` for the name (pnpm's own
 * "set this to true or false" placeholder does not count) or a
 * `name@version` key, and not listed in a legacy setting.
 */
function undecided(root: string, doc: Document | undefined): string[] {
  const pkgSettings = (readJson(path.join(root, 'package.json')) as { pnpm?: unknown } | undefined)?.pnpm;
  const workspaceSettings = doc && !unusable(doc) ? doc.toJS() as unknown : undefined;
  const allowBuilds = doc && !unusable(doc) ? doc.get('allowBuilds', true) : undefined;
  return PNPM_DENIED_BUILDS.filter((name) => {
    if (decidedIn(workspaceSettings, name) || decidedIn(pkgSettings, name)) return false;
    if (!isMap(allowBuilds)) return true;
    return !allowBuilds.items.some((pair) => {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (key.startsWith(`${name}@`)) return true;
      return key === name && isScalar(pair.value) && typeof pair.value.value === 'boolean';
    });
  });
}

function readWorkspace(root: string): { text: string; doc: Document } | undefined {
  const file = path.join(root, WORKSPACE_FILE);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  return { text, doc: parseDocument(text) };
}

/**
 * The packages whose build scripts the pnpm project at `cwd` has still to
 * approve or deny (empty when every one is decided, or the project cannot
 * be read). For init's message after an install that exited non-zero.
 */
export function pnpmUndecidedBuilds(cwd: string): string[] {
  const root = pnpmRoot(cwd);
  if (!root) return [...PNPM_DENIED_BUILDS];
  try {
    const existing = readWorkspace(root);
    if (existing && unusable(existing.doc)) return [...PNPM_DENIED_BUILDS];
    return undecided(root, existing?.doc);
  } catch {
    return [...PNPM_DENIED_BUILDS];
  }
}

/**
 * The major version of the pnpm that runs in `cwd` (which honours the
 * project's `packageManager` field), or undefined when pnpm cannot be run.
 */
export function pnpmMajorVersion(cwd: string): number | undefined {
  const result = spawnSync('pnpm', ['--version'], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    // A corepack shim would otherwise wait on a download prompt nobody sees.
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
    // pnpm is a .cmd shim on Windows, which only a shell runs.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const major = /^(\d+)\./m.exec(result.stdout.trim())?.[1];
  return major === undefined ? undefined : Number(major);
}

/**
 * In a pnpm project, sets each of PNPM_DENIED_BUILDS the project has not
 * decided to `false` under `allowBuilds` in its pnpm-workspace.yaml, so
 * that installs (init's own, and CI's `pnpm install --frozen-lockfile`)
 * exit 0. An existing file keeps its comments and other settings; pnpm's
 * "set this to true or false" placeholders are replaced. A new file is
 * created only for pnpm 11 and later: pnpm 10 only warns about the
 * scripts, and pnpm 9 and early 10 releases reject a pnpm-workspace.yaml
 * without `packages`.
 */
export function writePnpmAllowBuilds(
  cwd: string,
  opts: {
    /** The project's package manager, as projectPackageManager() names it. */
    agent: string;
    /** pnpm's major version, asked only when there is no pnpm-workspace.yaml yet. */
    pnpmMajor: () => number | undefined;
  },
): PnpmBuildsOutcome {
  if (opts.agent !== 'pnpm' && !opts.agent.startsWith('pnpm@')) return { status: 'not-pnpm' };
  const root = pnpmRoot(cwd);
  if (!root) return { status: 'not-pnpm' };
  const file = path.join(root, WORKSPACE_FILE);
  const relative = path.relative(cwd, file) || WORKSPACE_FILE;

  const existing = readWorkspace(root);
  if (existing) {
    const reason = unusable(existing.doc);
    if (reason) {
      return { status: 'failed', warning: `Left ${relative} unchanged: ${reason}. ${manualAdvice(PNPM_DENIED_BUILDS)}` };
    }
  }
  const names = undecided(root, existing?.doc);
  if (names.length === 0) return { status: 'present' };
  if (!existing) {
    const major = opts.pnpmMajor();
    if (major === undefined || major < 11) return { status: 'skipped' };
  }

  const doc = existing?.doc ?? parseDocument('');
  const allowBuilds = doc.get('allowBuilds', true);
  if (!isMap(allowBuilds)) {
    doc.set('allowBuilds', doc.createNode(Object.fromEntries(names.map((n) => [n, false]))));
  } else {
    for (const name of names) allowBuilds.set(name, false);
  }
  const text = doc.toString();
  try {
    // `wx` for a new file: never replace one that appeared since the check.
    fs.writeFileSync(file, text, existing ? undefined : { flag: 'wx' });
  } catch (err) {
    return {
      status: 'failed',
      warning: `Could not write ${relative} (${err instanceof Error ? err.message : String(err)}). ${manualAdvice(names)}`,
    };
  }
  return { status: 'written', file: relative, created: !existing, names };
}

function manualAdvice(names: readonly string[]): string {
  return `pnpm 11 and later exit 1 over the build scripts Tapsmith's dependencies ship until the project decides them: set ${names.join(' and ')} to false under allowBuilds there yourself (Tapsmith does not need the scripts)`;
}

/** The line init prints, or the filesCreated entry's note, for a write. */
export function pnpmAllowBuildsMessage(outcome: { file: string; created: boolean; names: string[] }): string {
  const what = `${outcome.names.join(' and ')} set to false under allowBuilds`;
  return `${outcome.file} ${outcome.created ? 'created' : 'updated'}: ${what} (Tapsmith doesn't need their build scripts; without this, pnpm 11+ installs exit 1). Commit it so CI installs pass too`;
}
