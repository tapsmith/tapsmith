// Pure checks behind check-clean-install.mjs, kept apart so the unit tests
// (src/__tests__/clean-install-checks.test.ts) can pin them without packing or
// installing anything.

// ─── Install-script warnings (PILOT-437) ───

/**
 * Third-party packages whose install scripts a fresh `npm install tapsmith`
 * may report, and why each is fine left unapproved (npm 12 blocks them).
 * docs/getting-started.md tells users the same. Our own packages never belong
 * here: a Tapsmith package with an install script is always a failure.
 */
export const ALLOWED_INSTALL_SCRIPTS = Object.freeze({
  protobufjs:
    'via @grpc/proto-loader and @grpc/grpc-js; its postinstall only prints a version-scheme advisory, so blocking it changes nothing',
  esbuild:
    'via tsx (TypeScript config loading); its install.js only verifies the @esbuild/<platform> binary npm already installed, and esbuild runs without it',
  fsevents:
    'via tsx, macOS only; its manifest declares `install: node-gyp rebuild`, but the package ships a prebuilt fsevents.node and runs without it',
});

// `npm warn allow-scripts   <name>@<version> (<event>: <command>)` on npm
// 11.17+, `npm warn install-scripts …` once npm 12 blocks them. The command
// is not parsed: it can be anything, including the start of a multi-line
// script whose later lines arrive as their own warn lines.
const INSTALL_SCRIPT_LINE = /^npm warn (?:allow-scripts|install-scripts)(?: (.*))?$/i;
const INSTALL_SCRIPT_ENTRY = /^ {2,}((?:@[^\s/@]+\/)?[^\s/@]+)@(\S+)(?:\s.*)?$/;
const INSTALL_SCRIPT_HEADER = /^\d+ packages? (?:has|have|had) install scripts /i;
const INSTALL_SCRIPT_ADVICE = /^Run `npm /;

/**
 * Every package an install-scripts warning in `output` names, and every line
 * of that warning that is none of an entry, the header, a blank or the advice
 * line. The check fails on the latter: a format it cannot read must not pass
 * as "no install scripts".
 */
export function parseInstallScriptWarnings(output) {
  const entries = [];
  const unrecognised = [];
  for (const line of output.split(/\r?\n/)) {
    const warn = INSTALL_SCRIPT_LINE.exec(line);
    if (!warn) continue;
    const rest = (warn[1] ?? '').trimEnd();
    const entry = INSTALL_SCRIPT_ENTRY.exec(rest);
    if (entry) entries.push({ name: entry[1], version: entry[2], line });
    else if (rest !== '' && !INSTALL_SCRIPT_HEADER.test(rest) && !INSTALL_SCRIPT_ADVICE.test(rest)) {
      unrecognised.push(line);
    }
  }
  return { entries, unrecognised };
}

/** The entries that are not allowlisted. A `@tapsmith/` package never is. */
export function disallowedInstallScripts(entries, allowed = ALLOWED_INSTALL_SCRIPTS) {
  return entries.filter(
    (entry) => entry.name.startsWith('@tapsmith/') || !Object.hasOwn(allowed, entry.name),
  );
}

/**
 * npm 11.17.0 is the first release that reports install scripts at all; on
 * anything older the install-scripts check cannot fail, so it must not pass
 * quietly either. Prereleases are treated as older.
 */
export function npmReportsInstallScripts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 11 || (major === 11 && minor >= 17);
}

// ─── Deprecations (PILOT-405) ───

/** The `npm warn deprecated` lines in `output`. */
export function deprecationLines(output) {
  return output.split(/\r?\n/).filter((line) => /^npm warn deprecated /i.test(line));
}

// ─── Package contents (PILOT-437, PILOT-438) ───

/**
 * The one package's entry from `npm pack --json` stdout: npm 11 prints an
 * array of entries, npm 12 an object keyed by package name.
 */
export function packEntry(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
  if (entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    throw new Error(`unexpected \`npm pack --json\` output: ${stdout.slice(0, 200)}`);
  }
  return entries[0];
}

/** Paths in `npm pack --json` files that sit under a `__tests__` directory. */
export function testPaths(files) {
  return files.map((file) => file.path).filter((p) => p.split('/').includes('__tests__'));
}

/** The lifecycle scripts npm runs on install that a package.json declares. */
export function installScriptsOf(pkg) {
  return ['preinstall', 'install', 'postinstall'].filter((name) => pkg.scripts?.[name] !== undefined);
}

/**
 * Of `names`, the files in `npm pack --json` output that are missing or not
 * executable by owner, group and other. npm keeps the tarball's modes on
 * install, so these bits are all that makes the daemon runnable.
 */
export function nonExecutableFiles(files, names) {
  const problems = [];
  for (const name of names) {
    const file = files.find((f) => f.path === name);
    if (!file) problems.push(`${name} (not in the tarball)`);
    else if ((file.mode & 0o111) !== 0o111) problems.push(`${name} (mode ${(file.mode & 0o777).toString(8)})`);
  }
  return problems;
}

// ─── Platform fields pnpm infers from a name (PILOT-709) ───

// pnpm 11+ gives an optional dependency that leaves `os`, `cpu` or `libc`
// undeclared the value a platform word in its name implies (pnpm's
// inferPlatformFromPackageName: the unscoped name split on `-`, `_` and `.`).
// `@tapsmith/agent-android` declared none, so pnpm read it as Android-only and
// skipped it on every machine that runs Tapsmith. These are pnpm's tokens.
const PLATFORM_TOKENS = Object.freeze({
  os: ['aix', 'android', 'darwin', 'macos', 'osx', 'freebsd', 'linux', 'netbsd', 'openbsd', 'openharmony', 'sunos', 'win32', 'windows'],
  cpu: ['arm', 'armv6', 'armv7', 'arm64', 'aarch64', 'ia32', 'loong64', 'mips64el', 'ppc64', 'ppc64le', 'riscv64', 's390x', 'x64', 'amd64', 'wasm32'],
  libc: ['glibc', 'gnu', 'gnueabihf', 'musl', 'musleabihf'],
});

/**
 * The platform fields (`os`, `cpu`, `libc`) a package's name implies to pnpm
 * but its package.json does not declare. Each one is a field pnpm fills in
 * from the name, so it must be declared for the package to install where it
 * is meant to.
 */
export function undeclaredPlatformFields(pkg) {
  const name = pkg.name.includes('/') ? pkg.name.slice(pkg.name.indexOf('/') + 1) : pkg.name;
  const tokens = name.toLowerCase().split(/[-_.]/);
  return Object.entries(PLATFORM_TOKENS)
    .filter(([field, words]) => pkg[field] === undefined && tokens.some((token) => words.includes(token)))
    .map(([field]) => field);
}
