/**
 * The machine's real CPU architecture, which is not always Node's.
 *
 * An x64 Node on an Apple Silicon Mac runs under Rosetta — common after
 * Migration Assistant from an Intel Mac, or with an x64 nvm install. Its
 * `process.arch` is `x64`, but the simulators and emulators it drives are
 * arm64: an x86_64-only iOS simulator agent fails to launch ("No
 * architectures intersection"), and an x86_64 emulator image is slow or will
 * not boot. Artefacts that run on a device or simulator must follow
 * {@link hostArch}, not `process.arch`.
 *
 * Node builtins only, so the CLI's help (`create-avd --abi`) can use it.
 */

import { execFileSync } from 'node:child_process';

export interface HostArchDeps {
  platform: NodeJS.Platform;
  /** Node's own architecture (`process.arch`). */
  arch: string;
  /** `sysctl -n sysctl.proc_translated` printed 1: this process runs under Rosetta. */
  translated: () => boolean;
}

const SYSCTL = '/usr/sbin/sysctl';

/** Whether `sysctl.proc_translated` says this process is translated by Rosetta. */
function sysctlTranslated(): boolean {
  try {
    // By absolute path: /usr/sbin is not always on PATH (sanitised task
    // runners), and a missing sysctl would read as "not translated".
    const out = execFileSync(SYSCTL, ['-n', 'sysctl.proc_translated'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim() === '1';
  } catch {
    // Intel Macs have no such key: not translated.
    return false;
  }
}

let translatedMemo: boolean | undefined;

function hostDeps(overrides: Partial<HostArchDeps>): HostArchDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    translated: () => (translatedMemo ??= sysctlTranslated()),
    ...overrides,
  };
}

/**
 * Whether Node is an x64 build running under Rosetta on Apple Silicon. Only
 * an x64 Node on macOS can be translated, so nothing else spawns sysctl.
 */
export function nodeUnderRosetta(overrides: Partial<HostArchDeps> = {}): boolean {
  const deps = hostDeps(overrides);
  return deps.platform === 'darwin' && deps.arch === 'x64' && deps.translated();
}

/** The machine's architecture in Node's terms: `arm64` under Rosetta, else `process.arch`. */
export function hostArch(overrides: Partial<HostArchDeps> = {}): string {
  const deps = hostDeps(overrides);
  return nodeUnderRosetta(deps) ? 'arm64' : deps.arch;
}

/** {@link hostArch} in Apple's terms, as xcodebuild's `ARCHS` and xctestrun file names spell it. */
export function appleArch(arch: string = hostArch()): string {
  return arch === 'x64' ? 'x86_64' : arch;
}

export const ROSETTA_NODE_FIX = 'Install an arm64 Node — the macOS installer from https://nodejs.org, or nvm/fnm run from an arm64 shell '
  + '(check with: node -p process.arch) — then reinstall your dependencies so npm fetches the arm64 packages: rm -rf node_modules && npm install';

/**
 * What running under Rosetta costs, with the fix — undefined when Node is
 * native. No trailing period.
 */
export function rosettaNodeWarning(overrides: Partial<HostArchDeps> = {}): string | undefined {
  if (!nodeUnderRosetta(overrides)) return undefined;
  return 'Node.js is running under Rosetta (x64) on this Apple Silicon Mac. Tapsmith still picks arm64 simulator agents and emulator images, '
    + 'but npm installed the x64 builds of its packages: everything runs translated and slower, and the prebuilt iOS simulator agent '
    + `cannot be used, so the first iOS run builds one from source. ${ROSETTA_NODE_FIX}`;
}
