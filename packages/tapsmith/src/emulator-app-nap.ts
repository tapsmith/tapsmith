/**
 * Keep macOS from throttling a windowed Android emulator.
 *
 * macOS App Nap demotes a GUI app whose window is hidden — or every app, once
 * the display sleeps — to background priority. A windowed emulator's qemu
 * process is such an app: measured on an M1 Max, it dropped from priority 46
 * to 4 within ~30 s of the user going idle, its guest load climbed past 100,
 * and adb commands timed out. Headless qemu has no window and is never napped.
 *
 * The emulator honours the standard `NSAppSleepDisabled` user default. qemu
 * is an unbundled executable, so its defaults domain is its executable name
 * (`qemu-system-aarch64`); the key is read once at launch, so it must be set
 * before the emulator starts. `taskpolicy -B` and an argv-domain
 * `-NSAppSleepDisabled YES` were both tried: the first has no effect on a
 * napped process and qemu rejects the second as an unknown option.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const KEY = 'NSAppSleepDisabled';

/** The qemu executables an emulator install may run windowed, when none can be listed. */
const FALLBACK_QEMU_NAMES = ['qemu-system-aarch64', 'qemu-system-x86_64'] as const;

export type EmulatorAppNapResult =
  /** App Nap is off for every qemu domain. `changed` lists the ones this call turned it off for. */
  | { kind: 'disabled', domains: string[], changed: string[] }
  /** The user set `NSAppSleepDisabled` to false for these domains: left as it is. */
  | { kind: 'user-enabled', domains: string[] }
  /** Reading or writing the defaults failed. */
  | { kind: 'failed', domains: string[], reason: string };

export interface EmulatorAppNapDeps {
  /** Runs `defaults` with these arguments and returns its stdout; throws when it exits non-zero. */
  defaults: (args: readonly string[]) => string
  readdir: (dir: string) => string[]
  realpath: (file: string) => string
  /** Whether `file` exists as a file. */
  isFile: (file: string) => boolean
  env: NodeJS.ProcessEnv
}

function defaultDeps(): EmulatorAppNapDeps {
  return {
    defaults: (args) => execFileSync('defaults', args, {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    readdir: (dir) => fs.readdirSync(dir),
    realpath: (file) => fs.realpathSync(file),
    isFile: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    env: process.env,
  };
}

/**
 * The windowed qemu executables next to `emulatorCommand` (an absolute path,
 * or the bare `emulator` found on PATH): `<emulator dir>/qemu/darwin-<arch>/qemu-system-<arch>`.
 * The `-headless` builds never open a window, so they are left out. Found from
 * the install rather than the host architecture, so a Node running under
 * Rosetta still names the arm64 binary. When nothing can be listed, both
 * names Android ships for macOS.
 */
export function emulatorQemuNames(
  emulatorCommand: string,
  deps: Partial<EmulatorAppNapDeps> = {},
): string[] {
  const d = { ...defaultDeps(), ...deps };
  const names = new Set<string>();
  try {
    let binary = emulatorCommand;
    if (!path.isAbsolute(binary)) {
      const dirs = (d.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
      const found = dirs.map((dir) => path.join(dir, binary)).find((candidate) => d.isFile(candidate));
      if (found === undefined) return [...FALLBACK_QEMU_NAMES];
      binary = found;
    }
    // A PATH entry is often a symlink into the SDK (Homebrew's, for one).
    const qemuDir = path.join(path.dirname(d.realpath(binary)), 'qemu');
    for (const hostDir of d.readdir(qemuDir)) {
      if (!hostDir.startsWith('darwin-')) continue;
      let entries: string[];
      try {
        entries = d.readdir(path.join(qemuDir, hostDir));
      } catch {
        continue;
      }
      for (const name of entries) {
        if (/^qemu-system-[a-z0-9_]+$/.test(name)) names.add(name);
      }
    }
  } catch {
    // An unreadable or unusual install: fall back below.
  }
  return names.size > 0 ? [...names].sort() : [...FALLBACK_QEMU_NAMES];
}

/** `defaults read` output for a boolean that is true. */
function isTrue(value: string): boolean {
  return /^(1|yes|true)$/i.test(value.trim());
}

function errorText(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' && stderr.trim() !== ''
    ? stderr.trim()
    : err instanceof Error ? err.message : String(err);
  return text.split('\n')[0];
}

/**
 * Turn App Nap off for the emulator's qemu (macOS only; the caller decides
 * that). Writes `NSAppSleepDisabled = YES` to each qemu domain that does not
 * set the key yet, and leaves a domain whose user set it to false alone.
 */
export function disableEmulatorAppNap(
  emulatorCommand: string,
  deps: Partial<EmulatorAppNapDeps> = {},
): EmulatorAppNapResult {
  const d = { ...defaultDeps(), ...deps };
  const domains = emulatorQemuNames(emulatorCommand, d);
  const changed: string[] = [];
  const userEnabled: string[] = [];
  for (const domain of domains) {
    let current: string | undefined;
    try {
      current = d.defaults(['read', domain, KEY]);
    } catch {
      // Exits non-zero when the domain or the key does not exist.
      current = undefined;
    }
    if (current !== undefined) {
      // Set, and not to true: the user's choice, kept as it is.
      if (!isTrue(current)) userEnabled.push(domain);
      continue;
    }
    try {
      d.defaults(['write', domain, KEY, '-bool', 'YES']);
      changed.push(domain);
    } catch (err) {
      return { kind: 'failed', domains, reason: errorText(err) };
    }
  }
  if (userEnabled.length > 0) return { kind: 'user-enabled', domains: userEnabled };
  return { kind: 'disabled', domains, changed };
}

/** Advice for a windowed emulator that macOS may throttle. */
const THROTTLE_ADVICE =
  'macOS slows a windowed emulator down while its window is hidden or the display sleeps, and adb commands then time out. '
  + 'Keep the emulator window visible, or set emulatorLaunchOptions: { headless: true }.';

/** What to tell the user about `disableEmulatorAppNap`'s result, if anything. */
export function describeEmulatorAppNap(
  result: EmulatorAppNapResult,
): { message: string, level: 'info' | 'warning' } | undefined {
  switch (result.kind) {
    case 'disabled': {
      if (result.changed.length === 0) return undefined;
      const undo = result.changed.map((domain) => `defaults delete ${domain} ${KEY}`).join('; ');
      return {
        level: 'info',
        message: `Turned off macOS App Nap for the Android emulator (${result.changed.join(', ')}), `
          + `so it keeps running at full speed while its window is hidden or the display sleeps. To undo: ${undo}`,
      };
    }
    case 'user-enabled':
      return {
        level: 'warning',
        message: `App Nap is on for the Android emulator: ${KEY} is false in the ${result.domains.join(', ')} defaults. `
          + THROTTLE_ADVICE,
      };
    case 'failed':
      return {
        level: 'warning',
        message: `Could not turn off macOS App Nap for the Android emulator (${result.reason}). ${THROTTLE_ADVICE}`,
      };
  }
}
