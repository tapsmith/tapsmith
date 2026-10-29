import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as os from 'node:os';

/**
 * Loader resolution for the child processes that discover and run test files.
 *
 * Those children `import()` the project's test files, so the decision must be
 * driven by the *test files*, not by whether our own forked script happens to
 * be TypeScript. Bare node resolves a `.ts` file (native type stripping) but
 * does not remap a `./x.js` specifier to `x.ts` the way tsx does — so a
 * TypeScript suite whose files import each other the ESM way fails to load
 * entirely when it is forked without the loader.
 */

function isTypeScript(file: string): boolean {
  // `.mts`/`.cts` are TypeScript too, and a suite written in them would
  // otherwise fork bare node and fail on the first type-only import.
  return /\.(ts|tsx|mts|cts)$/.test(file);
}

/** Whether the forked children need the tsx loader. */
export function needsTsxLoader(scriptPaths: string[], testFiles: string[]): boolean {
  return scriptPaths.some(isTypeScript) || testFiles.some(isTypeScript);
}

/**
 * Find the tsx executable. npm may keep it under our own package, hoist it to
 * the consumer's `node_modules/.bin`, or leave it reachable only through the
 * package itself — check every shape rather than assuming one, since guessing
 * wrong forks bare node and breaks TypeScript imports silently.
 */
export function resolveTsxBin(tapsmithPkgDir: string): string | undefined {
  const candidates = [
    // Our own dependency tree (source checkout, or an un-hoisted install).
    path.join(tapsmithPkgDir, 'node_modules', '.bin', 'tsx'),
    // Hoisted next to us: <node_modules>/.bin/tsx when we are <node_modules>/tapsmith.
    path.resolve(tapsmithPkgDir, '..', '.bin', 'tsx'),
  ];
  for (const candidate of candidates) {
    // Executable, like every other candidate below: a shim extracted without
    // its mode bits is just as unusable as `execPath`, and accepting it here
    // skips both the package lookup and the PATH fallback.
    if (isExecutableFile(candidate)) return candidate;
  }

  // The package may be resolvable even when no .bin shim is reachable from here.
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('tsx/package.json');
    const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).bin;
    const relative = typeof bin === 'string' ? bin : bin?.tsx;
    if (relative) {
      const resolved = path.resolve(path.dirname(pkgPath), relative);
      // Executable, not merely present. This becomes `execPath` for every
      // forked child, and a package extracted without mode bits (or a PnP-style
      // layout) would spawn `EACCES` for each of them — burying the "install
      // tsx" advice this function exists to produce, and skipping the PATH
      // lookup below that might well have worked.
      if (isExecutableFile(resolved)) return resolved;
    }
  } catch {
    // Not resolvable from here — fall through to PATH.
  }

  return findExecutableOnPath('tsx');
}

/**
 * Why tsx cannot start in this temp directory, or `undefined` when it can.
 *
 * The tsx CLI (the loader for the CLI's re-exec and every forked child)
 * listens on a Unix socket at `<tmpdir>/tsx-<uid>/<pid>.pipe`, and a socket
 * path longer than `sun_path` (104 bytes on macOS and the BSDs, 108 on Linux,
 * NUL included) fails with a raw `listen EINVAL` stack trace before any
 * Tapsmith code runs. Checked against the longest pid the
 * platform hands out, so a run never passes the check and then fails on a
 * longer pid.
 */
export function tsxIpcPathProblem(opts: {
  tmpdir?: string;
  platform?: NodeJS.Platform;
  uid?: number | string;
} = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  // Windows: a named pipe, with no such limit.
  if (platform === 'win32') return undefined;
  const tmpdir = opts.tmpdir ?? os.tmpdir();
  // tsx's own naming: the effective uid, else the user name.
  const uid = opts.uid ?? (process.geteuid ? process.geteuid() : os.userInfo().username);
  const linux = platform === 'linux';
  const maxBytes = linux ? 107 : 103;
  // Linux pids go up to 2^22 (7 digits); macOS's and the BSDs' to 99999.
  const longestPid = linux ? '4194304' : '99999';
  const socketDir = path.posix.join(tmpdir, `tsx-${uid}`);
  const bytes = Buffer.byteLength(path.posix.join(socketDir, `${longestPid}.pipe`));
  if (bytes <= maxBytes) return undefined;
  return `The temp directory's path is too long for tsx, which Tapsmith runs TypeScript with: `
    + `its socket, ${socketDir}/<pid>.pipe, can reach ${bytes} bytes, over the ${maxBytes}-byte limit `
    + `for a Unix socket path on this system. Point TMPDIR at a shorter directory, e.g. \`TMPDIR=/tmp npx tapsmith test\`.`;
}

/**
 * The loader for a set of forked scripts, or `undefined` when none is needed.
 * Reports through `onMissing` when TypeScript tests are present but no tsx
 * could be found, or tsx cannot start in this temp directory — the children
 * would otherwise fail one by one with errors that look nothing like the
 * real cause.
 */
export function resolveChildLoader(
  scriptPaths: string[],
  testFiles: string[],
  tapsmithPkgDir: string,
  onMissing?: (message: string) => void,
): string | undefined {
  if (!needsTsxLoader(scriptPaths, testFiles)) return undefined;

  // Every fork would fail in tsx before reaching our code (PILOT-569).
  const ipcProblem = tsxIpcPathProblem();
  if (ipcProblem) onMissing?.(ipcProblem);

  const tsxBin = resolveTsxBin(tapsmithPkgDir);
  if (!tsxBin) {
    // Name whichever side actually needs it. Blaming the test files when the
    // suite is entirely JavaScript sends the reader looking in the wrong place.
    const source = testFiles.some(isTypeScript)
      ? 'TypeScript test files were found'
      : "Tapsmith's own child scripts are TypeScript";
    onMissing?.(
      `${source} but the tsx loader could not be located. `
      + 'Test discovery and runs will fail for any file importing a sibling module '
      + '(e.g. `import { test } from "./fixtures.js"`). Install tsx: npm install -D tsx',
    );
  }
  return tsxBin;
}

/**
 * A file that can actually be handed to `fork` as `execPath`.
 *
 * A directory passes X_OK too — that bit means "traversable" there — and
 * handing one to `fork` fails every child with a spawn error instead of the
 * actionable "install tsx".
 */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliberately no PATHEXT handling. What this returns becomes `fork`'s
 * `execPath`, and on Windows the tsx entry on PATH is `tsx.cmd` — a batch file,
 * which cannot host the IPC channel `fork` requires. Resolving it would trade a
 * clear "install tsx" message for an obscure spawn failure at every child.
 */
function findExecutableOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    if (isExecutableFile(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}
