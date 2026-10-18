/**
 * Auto-resolution helpers for physical iOS devices.
 *
 * The e2e config used to hand-roll `xcrun devicectl list devices` JSON
 * parsing and a DerivedData glob walk just to target a phone. That's
 * boilerplate — the framework should do it, same way we already resolve
 * simulator names to UDIDs.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appleArch, hostArch } from './host-arch.js';
import { listPhysicalDevices, listUsbAttachedIosDevices } from './ios-devicectl.js';
import { displayPath, npmIosAgentDir, npmIosAgentVersion, tapsmithPackageVersion } from './ios-agent-paths.js';

const require = createRequire(import.meta.url);

/**
 * Resolve a single connected, paired, USB-attached physical iOS device UDID.
 * Devices devicectl only remembers (unplugged, or paired with another Mac)
 * are never candidates (PILOT-386). Throws
 * with an actionable error when zero or multiple are found so users who
 * own several phones get a clear prompt rather than a silent pick.
 *
 * The returned UDID has been cross-checked against `idevice_id -l`
 * (libimobiledevice) — CoreDevice's `transportType` is not reliable for
 * "is this phone actually on a cable right now", so we use the ground
 * truth from libimobiledevice to filter out wireless-paired devices that
 * can't actually be driven by `tapsmith test`.
 */
export function resolvePhysicalIosDevice(): string {
  // Connected per the rule the daemon applies too: a device it does not list
  // could not be selected.
  const paired = listPhysicalDevices().filter((d) => d.isPaired && d.isConnected);
  if (paired.length === 0) {
    throw new Error(
      'No connected, paired physical iOS device detected. Connect one via USB and run ' +
        '`tapsmith ios setup-device`, or set `device` / TAPSMITH_IOS_DEVICE explicitly.',
    );
  }

  const usb = listUsbAttachedIosDevices();
  const usbPaired = paired.filter((d) => usb.has(d.udid));
  const candidates = usbPaired.length > 0 ? usbPaired : paired;

  if (candidates.length === 1) return candidates[0].udid;

  const names = candidates.map((d) => `${d.name} (${d.udid})`).join(', ');
  throw new Error(
    `Multiple paired physical iOS devices detected (${candidates.length}): ${names}. ` +
      'Set `device` in your config or the TAPSMITH_IOS_DEVICE env var to pick one.',
  );
}

/**
 * Find the newest device-built xctestrun. Looks, in order:
 *   1. `ios-agent/.build-device` in `startDir` or up to five of its parents
 *      — a Tapsmith checkout's build (`tapsmith ios build-agent` run there);
 *   2. `~/.tapsmith/ios-agent/.build-device` — where `tapsmith ios build-agent`
 *      builds for an npm install (PILOT-264). Used only when that source was
 *      extracted by this Tapsmith version: a runner built from an older
 *      version's agent would run against this version's daemon.
 * Returns an absolute path, or `undefined` when no usable build exists
 * (callers explain why with {@link describeMissingDeviceXctestrun}).
 *
 * `.patched.xctestrun` files are excluded because the daemon rewrites
 * xctestrun files at runtime; selecting one as the source would cause
 * successive patches to stack a `.patched.patched.xctestrun` chain until
 * the filename exceeds the 255-byte POSIX limit.
 */
export function findDeviceXctestrun(startDir: string): string | undefined {
  // We don't know whether the user runs from the monorepo root, an e2e
  // subdir, or a nested package, so walk up a few levels.
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    const productsDir = path.join(dir, 'ios-agent', '.build-device', 'Build', 'Products');
    if (fs.existsSync(productsDir)) {
      const match = newestIphoneosXctestrun(productsDir);
      if (match) return match;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (npmIosAgentVersion() !== tapsmithPackageVersion()) return undefined;
  return newestIphoneosXctestrun(npmDeviceProductsDir());
}

function npmDeviceProductsDir(): string {
  return path.join(npmIosAgentDir(), '.build-device', 'Build', 'Products');
}

/**
 * The npm install's device build when it exists but was made by another
 * Tapsmith version (so {@link findDeviceXctestrun} skips it). `builtBy` is
 * undefined when the version marker is missing.
 */
export function staleNpmDeviceBuild(): { builtBy: string | undefined; current: string } | undefined {
  const builtBy = npmIosAgentVersion();
  const current = tapsmithPackageVersion();
  if (builtBy === current) return undefined;
  if (!newestIphoneosXctestrun(npmDeviceProductsDir())) return undefined;
  return { builtBy, current };
}

/** Why {@link findDeviceXctestrun} found nothing from `startDir`, and what to do. */
export function describeMissingDeviceXctestrun(startDir: string): string {
  const npmBuild = displayPath(path.join(npmIosAgentDir(), '.build-device'));
  const looked = `No device xctestrun found under ios-agent/.build-device in ${path.resolve(startDir)} `
    + `or its parents, or under ${npmBuild}.`;
  const stale = staleNpmDeviceBuild();
  if (stale) {
    const by = stale.builtBy ? `Tapsmith ${stale.builtBy}` : 'another Tapsmith version';
    return `${looked} The runner under ${npmBuild} was built by ${by} (this is ${stale.current}), `
      + `so it is not used. Rebuild it with Tapsmith ${stale.current}: run \`npx tapsmith ios build-agent\` in your project.`;
  }
  return `${looked} Run \`tapsmith ios build-agent\` first, or set \`iosXctestrun\` explicitly.`;
}

/**
 * The message for an `iosXctestrun` (or `TAPSMITH_IOS_XCTESTRUN`) that
 * points at a file that does not exist. A path into the npm install's agent
 * directory gets the likely cause: upgrading Tapsmith re-extracts that
 * directory, which removes the runner built in it (PILOT-264).
 */
export function describeMissingExplicitXctestrun(xctestrunPath: string, source: string): string {
  const head = `The xctestrun set by ${source} does not exist: ${displayPath(xctestrunPath)}.`;
  if (isInside(xctestrunPath, npmIosAgentDir())) {
    return `${head} Upgrading Tapsmith replaces ${displayPath(npmIosAgentDir())}, which removes the runner built there. `
      + 'Rebuild it with `npx tapsmith ios build-agent` in your project; `tapsmith test` then finds that build without the setting.';
  }
  return `${head} Fix the path, or unset it to let Tapsmith find the agent build itself.`;
}

/**
 * A warning for an existing `iosXctestrun` inside the npm install's agent
 * directory that an earlier Tapsmith version built. It is still used (the
 * setting is explicit), but the next agent build or upgrade replaces it.
 */
export function staleExplicitXctestrunWarning(xctestrunPath: string): string | undefined {
  if (!isInside(xctestrunPath, npmIosAgentDir())) return undefined;
  const builtBy = npmIosAgentVersion();
  const current = tapsmithPackageVersion();
  if (builtBy === current) return undefined;
  return `${displayPath(xctestrunPath)} was built by ${builtBy ? `Tapsmith ${builtBy}` : 'another Tapsmith version'} `
    + `(this is ${current}). If the agent fails to start, rebuild it with \`tapsmith ios build-agent\`.`;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function newestIphoneosXctestrun(productsDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(productsDir);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter(
      (e) =>
        e.endsWith('.xctestrun') &&
        e.includes('iphoneos') &&
        !e.endsWith('.patched.xctestrun'),
    )
    .map((e) => path.join(productsDir, e));
  // Stat each once, skipping a file removed since the readdir (an upgrade
  // re-extracting ~/.tapsmith/ios-agent in another process).
  const stamped: Array<{ path: string; mtime: number }> = [];
  for (const p of matches) {
    try { stamped.push({ path: p, mtime: fs.statSync(p).mtimeMs }); } catch { /* vanished */ }
  }
  if (stamped.length === 0) return undefined;
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped[0].path;
}

// ─── Simulator agent ───

/**
 * `~/.tapsmith/ios-simulator-agent` — the root of the simulator agent build
 * cache. Builds live in a subdirectory per Tapsmith version
 * ({@link simulatorAgentCacheDir}); releases before PILOT-485 built straight
 * into the root, and still do.
 */
export function simulatorAgentCacheRoot(): string {
  return path.join(os.homedir(), '.tapsmith', 'ios-simulator-agent');
}

/**
 * Where this Tapsmith version builds the simulator agent on demand
 * (ios-simulator-build.ts): a directory of its own, so a build is only ever
 * used by the version whose agent source it was compiled from, two versions
 * on one Mac never rebuild over each other, and a release that predates the
 * per-version layout never writes into it (PILOT-485).
 */
export function simulatorAgentCacheDir(version: string = tapsmithPackageVersion()): string {
  return path.join(simulatorAgentCacheRoot(), version);
}

/** Marker in a cache directory: the simulator SDK its build targets, written once the build is complete. */
export const SIMULATOR_CACHE_SDK_MARKER = '.sdk-version';

/** What the auto-build cache holds, and whether {@link findSimulatorXctestrun} may use it. */
export interface SimulatorAgentCache {
  xctestrun: string
  /** The SDK it was built for; undefined when the build never finished. */
  sdk: string | undefined
  /**
   * The Tapsmith version that built it; undefined for a build from a release
   * before the per-version layout.
   */
  builtBy: string | undefined
  /** This Tapsmith version. */
  current: string
  /**
   * Why it is not used, or undefined when it is: the build never finished
   * (`incomplete`), it targets another simulator SDK (`sdk`), or only another
   * Tapsmith version has a build, from that version's agent source (`version`).
   */
  stale?: 'incomplete' | 'sdk' | 'version'
}

/**
 * The auto-build cache's state: this version's build when it has one, else
 * the newest build another version left (`stale: 'version'`), else
 * undefined. A build is only as current as the agent source it was compiled
 * from: another version's runs that version's agent against this version's
 * SDK and daemon (PILOT-485).
 */
export function inspectSimulatorAgentCache(
  installedSdk: string | undefined = getInstalledSimulatorSdkVersion(),
): SimulatorAgentCache | undefined {
  const current = tapsmithPackageVersion();
  const own = simulatorAgentCacheDir(current);
  const xctestrun = newestSimulatorXctestrunIn(own);
  if (xctestrun) {
    const sdk = readMarker(path.join(own, SIMULATOR_CACHE_SDK_MARKER));
    const stale = !sdk ? 'incomplete' : installedSdk && sdk !== installedSdk ? 'sdk' : undefined;
    return { xctestrun, sdk, builtBy: current, current, ...(stale ? { stale } : {}) };
  }
  const other = newestOtherVersionBuild(current);
  return other && { ...other, current, stale: 'version' };
}

/**
 * The newest simulator build another Tapsmith version left in the cache: a
 * pre-PILOT-485 one in the root, or another version's subdirectory.
 */
function newestOtherVersionBuild(current: string): { xctestrun: string; sdk: string | undefined; builtBy: string | undefined } | undefined {
  const root = simulatorAgentCacheRoot();
  const candidates: Array<{ dir: string; builtBy: string | undefined }> = [{ dir: root, builtBy: undefined }];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* no cache */ }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== current && /^\d/.test(e.name)) {
      candidates.push({ dir: path.join(root, e.name), builtBy: e.name });
    }
  }
  let best: { xctestrun: string; sdk: string | undefined; builtBy: string | undefined; mtime: number } | undefined;
  for (const { dir, builtBy } of candidates) {
    const xctestrun = newestSimulatorXctestrunIn(dir);
    if (!xctestrun) continue;
    let mtime = 0;
    try { mtime = fs.statSync(xctestrun).mtimeMs; } catch { /* vanished */ }
    if (!best || mtime > best.mtime) {
      best = { xctestrun, sdk: readMarker(path.join(dir, SIMULATOR_CACHE_SDK_MARKER)), builtBy, mtime };
    }
  }
  return best && { xctestrun: best.xctestrun, sdk: best.sdk, builtBy: best.builtBy };
}

/** Why a cache built by another Tapsmith version is not used, for messages. */
export function describeStaleSimulatorAgentCache(cache: SimulatorAgentCache): string {
  const by = cache.builtBy ? `Tapsmith ${cache.builtBy}` : 'an earlier Tapsmith version';
  return `the cached iOS simulator agent in ${displayPath(simulatorAgentCacheRoot())} was built by ${by} (this is ${cache.current})`;
}

function readMarker(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the installed agent platform package's version differs from the
 * SDK's own version (agent and SDK ship together per release, so a mismatch
 * means the lockfile drifted). Unreadable manifests return false — the
 * normal lookup proceeds.
 */
function agentPackageVersionMismatch(pkg: string, pkgJsonPath: string): boolean {
  try {
    const agentVersion = (JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version?: string }).version;
    const sdkVersion = (JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { version?: string }).version;
    if (agentVersion && sdkVersion && agentVersion !== sdkVersion) {
      process.stderr.write(
        `[tapsmith] Installed ${pkg}@${agentVersion} does not match the SDK version ` +
        `(${sdkVersion}); ignoring it in favour of local builds. ` +
        `Run \`npm update ${pkg}\` (or reinstall) to fix.\n`,
      );
      return true;
    }
  } catch {
    // Unreadable manifests — assume compatible.
  }
  return false;
}

/**
 * The prebuilt npm package's directory for this machine, or undefined when
 * it is not installed or is version-drifted. The lockfile pins these via
 * "*", and a stale pinned agent silently shadows a fresh build, producing
 * protocol-mismatch failures that masquerade as flaky tests (PILOT-289:
 * stale-element taps from an agent predating the textContains cache
 * branch). The machine's arch, not Node's: under Rosetta npm installs the
 * x64 package, whose x86_64 agent arm64 simulators cannot run (PILOT-559).
 */
function simulatorAgentPackageDir(): string | undefined {
  const pkg = `@tapsmith/agent-ios-simulator-${hostArch()}`;
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${pkg}/package.json`);
  } catch {
    return undefined; // not installed
  }
  if (agentPackageVersionMismatch(pkg, pkgJsonPath)) return undefined;
  return path.dirname(pkgJsonPath);
}

/**
 * Find the newest simulator-slice xctestrun.
 *
 * Resolution order:
 *   1. Prebuilt npm package (`@tapsmith/agent-ios-simulator-{arch}`) built
 *      for exactly the installed simulator SDK — a release build of this
 *      version's agent. Ships with `__TAPSMITH_PKG__` path placeholders that
 *      the daemon resolves at runtime.
 *   2. This version's auto-build cache (`~/.tapsmith/ios-simulator-agent/<version>/`),
 *      when it was built for the installed SDK ({@link inspectSimulatorAgentCache}).
 *      Another version's build there is never used.
 *   3. The npm package's build for another SDK (newest first), or its flat
 *      layout (older packages). ensureSimulatorAgent rebuilds into the cache
 *      instead of running it, and step 2 then finds that build.
 *   4. Xcode DerivedData scan (`~/Library/Developer/Xcode/DerivedData/TapsmithAgent-*`)
 *      and the monorepo's build dirs — local `xcodebuild build-for-testing` builds.
 *
 * Either version-drifted source (an npm package from another release, a
 * build another version cached) is skipped, never used.
 *
 * `.patched.xctestrun` files are excluded because the daemon rewrites
 * xctestrun at runtime and re-selecting a patched file stacks suffixes.
 *
 * Returns `undefined` when no build exists; the CLI turns that into a
 * fix-it message pointing at the simulator build command.
 */
export function findSimulatorXctestrun(): string | undefined {
  const installedSdk = getInstalledSimulatorSdkVersion();
  const pkgDir = simulatorAgentPackageDir();

  // 1. The npm package's exact SDK match.
  if (pkgDir && installedSdk) {
    const match = newestSimulatorXctestrunIn(path.join(pkgDir, `sdk-${installedSdk}`));
    if (match) return match;
  }

  // 2. The auto-build cache, when this version built it for this SDK.
  const cache = inspectSimulatorAgentCache(installedSdk);
  if (cache && !cache.stale) return cache.xctestrun;

  if (pkgDir) {
    // 3a. Any sdk-*/ subdirectory (newest xctestrun across all subdirs wins).
    try {
      const subdirs = fs.readdirSync(pkgDir)
        .filter((e) => e.startsWith('sdk-'))
        .map((e) => path.join(pkgDir, e));
      const sdkCandidates: { path: string; mtime: number }[] = [];
      for (const subdir of subdirs) {
        const match = newestSimulatorXctestrunIn(subdir);
        if (match) {
          try { sdkCandidates.push({ path: match, mtime: fs.statSync(match).mtimeMs }); } catch { /* skip */ }
        }
      }
      if (sdkCandidates.length > 0) {
        sdkCandidates.sort((a, b) => b.mtime - a.mtime);
        return sdkCandidates[0].path;
      }
    } catch {
      // No subdirectories — fall through.
    }

    // 3b. Flat layout (backward compat with older packages).
    const flat = newestSimulatorXctestrunIn(pkgDir);
    if (flat) return flat;
  }

  // 4. DerivedData scan (local Xcode builds).
  // Local builds: Xcode's default DerivedData plus the monorepo's own build
  // dirs (`ios-agent/.build-sim`, `ios-agent/build`) — relative to this module
  // and to the cwd — so a rebuild in any of them is picked up. Newest wins
  // across all locations.
  const root = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  const productDirs: string[] = [];
  try {
    for (const d of fs.readdirSync(root)) {
      if (d.startsWith('TapsmithAgent-')) productDirs.push(path.join(root, d, 'Build', 'Products'));
    }
  } catch {
    // No DerivedData — the monorepo dirs may still apply.
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  for (const base of [path.resolve(moduleDir, '..', '..', '..'), process.cwd()]) {
    for (const build of ['.build-sim', 'build']) {
      productDirs.push(path.join(base, 'ios-agent', build, 'Build', 'Products'));
    }
  }
  const candidates: string[] = [];
  for (const productsDir of new Set(productDirs)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(productsDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (
        e.endsWith('.xctestrun') &&
        e.includes('iphonesimulator') &&
        !e.endsWith('.patched.xctestrun') &&
        xctestrunRunsOnHost(e) &&
        hasSimulatorTestProducts(path.join(productsDir, e))
      ) {
        candidates.push(path.join(productsDir, e));
      }
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

/**
 * The architectures a simulator xctestrun's file name says it was built for
 * (`…iphonesimulator26.0-arm64.xctestrun`, `…-arm64-x86_64.xctestrun`), or
 * undefined when the name does not say.
 */
export function xctestrunArchs(xctestrunPath: string): string[] | undefined {
  const match = path.basename(xctestrunPath).match(/iphonesimulator[\d.]+-([A-Za-z0-9_-]+)\.xctestrun$/);
  return match ? match[1].split('-') : undefined;
}

/**
 * Whether a simulator xctestrun can run on this machine's simulators. One
 * built only for the other arch fails at launch ("No architectures
 * intersection"): an x86_64 agent left over from a run under Rosetta, or
 * built on an Intel Mac, must not be picked on Apple Silicon (PILOT-559).
 * A name that does not say is kept.
 */
function xctestrunRunsOnHost(xctestrunPath: string): boolean {
  const archs = xctestrunArchs(xctestrunPath);
  return !archs || archs.includes(appleArch());
}

export function extractSdkVersion(xctestrunPath: string): string | undefined {
  const match = path.basename(xctestrunPath).match(/iphonesimulator([\d.]+)-/);
  return match?.[1];
}

let _cachedSdkVersion: string | undefined;
let _sdkVersionChecked = false;

export function getInstalledSimulatorSdkVersion(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  if (_sdkVersionChecked) return _cachedSdkVersion;
  _sdkVersionChecked = true;
  try {
    const raw = execFileSync(
      'xcrun',
      ['--show-sdk-version', '--sdk', 'iphonesimulator'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    );
    _cachedSdkVersion = raw.trim() || undefined;
  } catch {
    _cachedSdkVersion = undefined;
  }
  return _cachedSdkVersion;
}

function newestSimulatorXctestrunIn(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter(
      (e) =>
        e.endsWith('.xctestrun') &&
        !e.endsWith('.patched.xctestrun') &&
        xctestrunRunsOnHost(e),
    )
    .map((e) => ({ path: path.join(dir, e), mtime: fs.statSync(path.join(dir, e)).mtimeMs }))
    .filter((m) => hasSimulatorTestProducts(m.path));
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].path;
}

/**
 * An xctestrun is only usable when the test products it references exist
 * next to it (`<dir>/*-iphonesimulator/<Runner>.app/PlugIns/*.xctest`).
 * Prebuilt npm packages v0.1.3–v0.1.7 shipped the xctestrun without the
 * app bundle (an npm `files` glob bug), which made xcodebuild fail with
 * exit code 70 at session start. Treating such candidates as absent lets
 * resolution fall through to the from-source auto-build instead.
 */
function hasSimulatorTestProducts(xctestrunPath: string): boolean {
  const root = path.dirname(xctestrunPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return false;
  }
  for (const products of entries) {
    if (!products.endsWith('-iphonesimulator')) continue;
    let apps: string[];
    try {
      apps = fs.readdirSync(path.join(root, products));
    } catch {
      continue;
    }
    for (const app of apps) {
      if (!app.endsWith('.app')) continue;
      let plugins: string[];
      try {
        plugins = fs.readdirSync(path.join(root, products, app, 'PlugIns'));
      } catch {
        continue;
      }
      if (plugins.some((p) => p.endsWith('.xctest'))) return true;
    }
  }
  return false;
}
