/**
 * `tapsmith create-avd` — create an Android AVD suited for Tapsmith.
 *
 * HTTPS network capture requires `adb root`, which only Google APIs
 * (`google_apis`) and AOSP emulator images support — Google Play
 * (`google_apis_playstore`) images are production builds that block root, so
 * Tapsmith can neither install its CA certificate nor set up the iptables
 * redirect on them. Android Studio's Device Manager preselects Play images
 * for most phone profiles, which silently degrades capture to plain HTTP.
 *
 * This wrapper downloads the right system image for the host architecture
 * via `sdkmanager` (the user accepts Google's SDK license through their own
 * SDK — the image cannot be redistributed) and creates the AVD via
 * `avdmanager`, then prints a ready-to-paste config snippet.
 *
 * Android Studio installs the SDK *without* the command-line tools, so for
 * most Studio users `sdkmanager`/`avdmanager` don't exist at all. Rather than
 * bounce them to a download page, the command offers to bootstrap the
 * cmdline-tools zip from Google's repository into `$ANDROID_HOME` itself
 * (interactive consent, or `--install-tools` for scripts), and falls back to
 * Android Studio's bundled JDK when no `java` is on PATH.
 *
 * Non-goals:
 *   - Installing the Android SDK itself (an SDK root must already exist).
 *   - Managing emulator snapshots or hardware profiles beyond `-d`.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import Enquirer from 'enquirer';
import { scanAvdImageTags } from './doctor.js';
import { DEFAULT_API_LEVEL, DEFAULT_DEVICE_PROFILE, defaultAbi, defaultAvdName } from './avd-defaults.js';
import type { CreateAvdCommandOptions } from './cli-program.js';

const enquirer = new Enquirer();

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;

// ─── Options ─────────────────────────────────────────────────────────────

export interface CreateAvdOptions {
  /** Android API level of the system image. */
  api: number;
  /** AVD name. Defaults to Tapsmith_Phone_API_<api>. */
  name: string;
  /** avdmanager device profile (hardware definition). */
  device: string;
  /** System image ABI. Defaults to the host architecture's ABI. */
  abi: string;
  /** Overwrite an existing AVD with the same name. */
  force: boolean;
  /** Install the Android SDK cmdline-tools without prompting when missing. */
  installTools: boolean;
}

/** sdkmanager package path for the Google APIs (rootable) system image. */
export function systemImagePackage(api: number, abi: string): string {
  return `system-images;android-${api};google_apis;${abi}`;
}

// avdmanager rejects names outside this set.
const AVD_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Real avdmanager device ids include spaces and parens ("Nexus 5",
// "7in WSVGA (Tablet)"), so allow those — but nothing that cmd.exe or a
// shell could interpret (the tools are spawned with shell:true on Windows).
const DEVICE_PROFILE_RE = /^[a-zA-Z0-9 ._()-]+$/;
const ABI_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Apply defaults to the raw `create-avd` flags and validate them. The values
 * reach avdmanager/sdkmanager, which are spawned through a shell on Windows,
 * so each one is checked against the characters those tools accept.
 */
export function resolveCreateAvdOptions(raw: CreateAvdCommandOptions): CreateAvdOptions {
  const api = raw.api === undefined ? DEFAULT_API_LEVEL : parseApiLevel(raw.api);
  const { name, abi, force, installTools } = raw;
  const device = raw.device ?? DEFAULT_DEVICE_PROFILE;

  const resolvedName = name ?? defaultAvdName(api);
  if (!AVD_NAME_RE.test(resolvedName)) {
    throw new Error(`Invalid AVD name "${resolvedName}" — use only letters, digits, ".", "_" and "-"`);
  }
  if (!DEVICE_PROFILE_RE.test(device)) {
    throw new Error(`Invalid device profile "${device}" — use an id from \`avdmanager list device\` (e.g. ${DEFAULT_DEVICE_PROFILE})`);
  }
  const resolvedAbi = abi ?? defaultAbi();
  if (!ABI_RE.test(resolvedAbi)) {
    throw new Error(`Invalid ABI "${resolvedAbi}" — expected e.g. arm64-v8a or x86_64`);
  }

  return { api, name: resolvedName, device, abi: resolvedAbi, force, installTools };
}

function parseApiLevel(value: string): number {
  const api = Number.parseInt(value, 10);
  if (!Number.isInteger(api) || api <= 0 || String(api) !== value.trim()) {
    throw new Error(`Invalid API level "${value}" — expected a positive integer (e.g. --api 36)`);
  }
  return api;
}

// ─── SDK tool resolution ─────────────────────────────────────────────────

/**
 * Locate an Android SDK command-line tool (`sdkmanager` / `avdmanager`).
 *
 * Checks the standard cmdline-tools locations under `$ANDROID_HOME` /
 * `$ANDROID_SDK_ROOT` first, then falls back to bare invocation so a tool
 * already on PATH still works.
 */
export function findSdkTool(tool: string, env: NodeJS.ProcessEnv = process.env): string {
  const suffix = process.platform === 'win32' ? '.bat' : '';
  const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (sdkRoot) {
    const candidates = [
      path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', `${tool}${suffix}`),
      path.join(sdkRoot, 'cmdline-tools', 'bin', `${tool}${suffix}`),
      path.join(sdkRoot, 'tools', 'bin', `${tool}${suffix}`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return `${tool}${suffix}`;
}

/**
 * Where sdkmanager unpacks a system image. Present iff the image is already
 * installed, letting createAvd skip the sdkmanager step (and its
 * cmdline-tools requirement) entirely.
 */
export function systemImageDir(sdkRoot: string, api: number, abi: string): string {
  return path.join(sdkRoot, 'system-images', `android-${api}`, 'google_apis', abi);
}

// Android Studio installs the SDK without cmdline-tools by default, so this
// is the most common failure mode for Studio-managed SDKs.
const CMDLINE_TOOLS_HINT =
  'Install "Android SDK Command-line Tools (latest)" from Android Studio '
  + '(Settings → Languages & Frameworks → Android SDK → SDK Tools tab), '
  + 'or download them from https://developer.android.com/tools/sdkmanager '
  + 'and set ANDROID_HOME.';

/** True when the bare command resolves on PATH. */
function isOnPath(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve an SDK tool and verify it is actually runnable. */
function resolveAvailableSdkTool(tool: string): string | undefined {
  const resolved = findSdkTool(tool);
  if (path.isAbsolute(resolved)) return resolved;
  return isOnPath(resolved) ? resolved : undefined;
}

// ─── cmdline-tools bootstrap ─────────────────────────────────────────────

const SDK_REPO_INDEX_URL = 'https://dl.google.com/android/repository/repository2-1.xml';
const SDK_TERMS_URL = 'https://developer.android.com/studio/terms';

/** Google's platform key in the cmdline-tools zip filename. */
export function cmdlineToolsPlatform(platform: NodeJS.Platform = process.platform): 'mac' | 'linux' | 'win' {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
}

/**
 * Pick the newest cmdline-tools zip for a platform from Google's repository
 * index. Filenames embed a monotonically increasing build number
 * (`commandlinetools-mac-15641748_latest.zip`).
 */
export function latestCmdlineToolsZip(repoIndexXml: string, platform: 'mac' | 'linux' | 'win'): string | undefined {
  const re = new RegExp(`commandlinetools-${platform}-(\\d+)_latest\\.zip`, 'g');
  let best: string | undefined;
  let bestBuild = -1;
  for (const match of repoIndexXml.matchAll(re)) {
    const build = Number(match[1]);
    if (build > bestBuild) {
      bestBuild = build;
      best = match[0];
    }
  }
  return best;
}

/**
 * Unpack a cmdline-tools zip into `<sdkRoot>/cmdline-tools/latest`.
 *
 * The zip's single top-level directory is `cmdline-tools/`; its contents move
 * under `latest/` (the layout sdkmanager itself requires). fflate does not
 * restore unix permission bits, so everything under `bin/` is chmodded
 * executable explicitly.
 */
export function extractCmdlineTools(zipData: Uint8Array, sdkRoot: string): string {
  const destDir = path.join(sdkRoot, 'cmdline-tools', 'latest');
  const entries = unzipSync(zipData);
  for (const [entryName, data] of Object.entries(entries)) {
    if (!entryName.startsWith('cmdline-tools/') || entryName.endsWith('/')) continue;
    const rel = entryName.slice('cmdline-tools/'.length);
    // Zip-slip guard: reject `..` segments with either separator (backslash
    // is a path separator on Windows), and verify the resolved target stays
    // inside destDir.
    if (!rel || rel.split(/[\\/]/).includes('..')) continue;
    const target = path.join(destDir, rel);
    if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (rel.startsWith('bin/')) fs.chmodSync(target, 0o755);
  }
  return destDir;
}

/**
 * Fetch a URL fully into memory, aborting if the whole transfer exceeds
 * `timeoutMs` so a dead connection can't hang the CLI indefinitely.
 */
async function fetchBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`Download timed out after ${Math.round(timeoutMs / 1000)}s: ${url}. Check your network and retry.`);
    }
    throw err;
  }
}

const INDEX_FETCH_TIMEOUT_MS = 30_000;
// The cmdline-tools zip is ~150 MB — allow for slow links, but still bail
// out eventually instead of hanging a CI pipeline forever.
const ZIP_FETCH_TIMEOUT_MS = 15 * 60_000;

async function installCmdlineTools(sdkRoot: string): Promise<void> {
  console.log(dim('Looking up the latest version…'));
  let indexXml: string;
  try {
    indexXml = new TextDecoder().decode(await fetchBytes(SDK_REPO_INDEX_URL, INDEX_FETCH_TIMEOUT_MS));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Google's SDK repository (${detail}). Check your network and retry.`);
  }
  const zipName = latestCmdlineToolsZip(indexXml, cmdlineToolsPlatform());
  if (!zipName) throw new Error('Could not find a cmdline-tools package in Google\'s SDK repository index.');

  console.log(dim(`Downloading ${zipName} (~150 MB)…`));
  const zipData = await fetchBytes(`https://dl.google.com/android/repository/${zipName}`, ZIP_FETCH_TIMEOUT_MS);

  const dest = extractCmdlineTools(zipData, sdkRoot);
  console.log(green(`✓ Command-line tools installed ${dim(`(${dest})`)}`));
}

/**
 * Make sure `avdmanager` (and `sdkmanager`, when a system image still needs
 * downloading) are available, offering to install the cmdline-tools into the
 * SDK root when they're not.
 */
async function ensureSdkTools(opts: CreateAvdOptions, sdkRoot: string | undefined, needSdkmanager: boolean): Promise<void> {
  const needed = needSdkmanager ? ['sdkmanager', 'avdmanager'] : ['avdmanager'];
  const missing = needed.filter((tool) => !resolveAvailableSdkTool(tool));
  if (missing.length === 0) return;

  const missingLabel = missing.join(' and ');
  if (!sdkRoot) {
    throw new Error(
      `${missingLabel} not found, and ANDROID_HOME is not set so Tapsmith cannot install the `
      + `command-line tools for you. Set ANDROID_HOME to your Android SDK, or: ${CMDLINE_TOOLS_HINT}`,
    );
  }

  console.log();
  console.log(`${bold('Setup')} ${missingLabel} not found — the Android SDK Command-line Tools are not installed.`);
  console.log(dim('(Android Studio does not install them by default.)'));
  console.log(dim(`Continuing accepts the Android SDK terms: ${SDK_TERMS_URL}`));

  let consented = opts.installTools;
  if (!consented && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const answer = await enquirer.prompt({
        type: 'confirm',
        name: 'install',
        message: `Download and install them into ${path.join(sdkRoot, 'cmdline-tools', 'latest')} now?`,
        initial: true,
      }) as { install: boolean };
      consented = answer.install;
    } catch {
      consented = false; // ctrl-c on the prompt
    }
  }

  if (!consented) {
    throw new Error(
      `Cannot continue without ${missingLabel}. Re-run with --install-tools to let Tapsmith `
      + `install the command-line tools into ${sdkRoot}, or install them yourself: ${CMDLINE_TOOLS_HINT}`,
    );
  }

  await installCmdlineTools(sdkRoot);

  const stillMissing = needed.filter((tool) => !resolveAvailableSdkTool(tool));
  if (stillMissing.length > 0) {
    throw new Error(`${stillMissing.join(' and ')} still not found after installing the command-line tools — ${CMDLINE_TOOLS_HINT}`);
  }
}

// ─── Java resolution ─────────────────────────────────────────────────────

/**
 * sdkmanager/avdmanager need a JDK, which Studio-only users often lack on
 * PATH. Fall back to Android Studio's bundled JetBrains Runtime via
 * JAVA_HOME when neither JAVA_HOME nor `java` is available.
 */
function toolEnv(): NodeJS.ProcessEnv {
  if (process.env.JAVA_HOME || isOnPath('java')) return process.env;
  const jbrCandidates = process.platform === 'darwin'
    ? ['/Applications/Android Studio.app/Contents/jbr/Contents/Home']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Android\\Android Studio\\jbr']
      : ['/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr'), '/usr/local/android-studio/jbr'];
  for (const jbr of jbrCandidates) {
    if (fs.existsSync(jbr)) {
      console.log(dim(`Using Android Studio's bundled JDK (${jbr})`));
      return { ...process.env, JAVA_HOME: jbr };
    }
  }
  return process.env;
}

// ─── Subprocess helpers ──────────────────────────────────────────────────

/**
 * Run a tool with output streamed to the terminal. `stdinResponse` is written
 * to the child's stdin (avdmanager prompts "Do you wish to create a custom
 * hardware profile" even in scripted use).
 */
// With shell:true, cmd.exe re-parses the command line — quote anything with
// whitespace (SDK under "C:\Users\First Last\...") or cmd metacharacters
// (system image ids contain `;`).
function winQuote(value: string): string {
  return /[\s;&^()|<>=,]/.test(value) ? `"${value}"` : value;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, stdinResponse?: string): Promise<void> {
  // .bat wrappers (sdkmanager.bat/avdmanager.bat) need a command interpreter.
  const useShell = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(useShell ? winQuote(command) : command, useShell ? args.map(winQuote) : args, {
      stdio: [stdinResponse === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      env,
      shell: useShell,
    });
    if (stdinResponse !== undefined && child.stdin) {
      // EPIPE fires here if the child exits before reading stdin; without a
      // listener that's an uncaught exception.
      child.stdin.on('error', () => {});
      child.stdin.write(stdinResponse);
      child.stdin.end();
    }
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${command} not found. ${CMDLINE_TOOLS_HINT}`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

// ─── Main flow ───────────────────────────────────────────────────────────

export async function createAvd(opts: CreateAvdOptions): Promise<void> {
  const image = systemImagePackage(opts.api, opts.abi);

  const existing = scanAvdImageTags().find((avd) => avd.name === opts.name);
  if (existing && !opts.force) {
    throw new Error(
      `AVD "${opts.name}" already exists`
      + (existing.tagId ? ` (image tag: ${existing.tagId})` : '')
      + '. Re-run with --force to overwrite it, or pick another name with --name.',
    );
  }

  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const imageAlreadyInstalled = !!sdkRoot && fs.existsSync(systemImageDir(sdkRoot, opts.api, opts.abi));

  await ensureSdkTools(opts, sdkRoot, !imageAlreadyInstalled);
  const env = toolEnv();

  console.log();
  if (imageAlreadyInstalled) {
    console.log(`${bold('Step 1/2')} System image already installed ${dim(`(${image})`)}`);
  } else {
    const sdkmanager = findSdkTool('sdkmanager');
    console.log(`${bold('Step 1/2')} Install system image ${dim(`(${image})`)}`);
    console.log(dim('sdkmanager may prompt you to accept the Android SDK license.'));
    await run(sdkmanager, [image], env);
  }

  console.log();
  console.log(`${bold('Step 2/2')} Create AVD ${dim(`(${opts.name}, device profile ${opts.device})`)}`);
  const avdmanager = findSdkTool('avdmanager');
  const args = ['create', 'avd', '-n', opts.name, '-k', image, '-d', opts.device];
  if (opts.force) args.push('--force');
  await run(avdmanager, args, env, 'no\n');

  console.log();
  console.log(green(`✓ AVD ${opts.name} created`));
  console.log();
  console.log('Point Tapsmith at it in tapsmith.config.ts:');
  console.log();
  console.log(dim('  export default defineConfig({'));
  console.log(`    avd: ${dim("'")}${opts.name}${dim("',")}`);
  console.log(dim('  })'));
  console.log();
  console.log(dim(`Google APIs images support adb root, so HTTPS network capture works out of the box.`));
}

// ─── CLI entry ───────────────────────────────────────────────────────────

export async function runCreateAvd(raw: CreateAvdCommandOptions): Promise<void> {
  let opts: CreateAvdOptions;
  try {
    opts = resolveCreateAvdOptions(raw);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    console.error("Run 'tapsmith create-avd --help' for usage.");
    process.exit(1);
  }

  try {
    await createAvd(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(msg));
    process.exit(1);
  }
}
