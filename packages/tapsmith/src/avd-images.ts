/**
 * AVD system images and HTTPS capture (PILOT-403, PILOT-404).
 *
 * The single source for "can this AVD capture HTTPS?" — `doctor`'s AVD check
 * and `init`'s AVD choice both judge AVDs here, and both build their
 * suggested fix here, so the two never disagree and neither ever suggests
 * overwriting the user's own AVD.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_API_LEVEL, defaultAvdName } from './avd-defaults.js';

// ─── Scanning ───

/**
 * Extract the system image tag (`tag.id`) from an AVD's `config.ini`.
 * `google_apis_playstore` images are production builds without `adb root`,
 * so Tapsmith cannot install its CA cert or iptables redirect on them —
 * HTTPS traffic is never captured.
 */
export function parseAvdImageTag(configIni: string): string | undefined {
  const match = configIni.match(/^tag\.id\s*=\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/** Extract the Android API level from an AVD's `image.sysdir.1` path. */
export function parseAvdApiLevel(configIni: string): number | undefined {
  const match = configIni.match(/^image\.sysdir\.1\s*=\s*.*android-(\d+)/m);
  return match ? Number(match[1]) : undefined;
}

export interface AvdImageInfo {
  name: string;
  tagId?: string;
  apiLevel?: number;
}

/**
 * The directory AVDs live in, in the SDK tools' documented order (the one
 * `avdmanager`, which `create-avd` runs, writes to): `$ANDROID_AVD_HOME`,
 * else `avd/` under `$ANDROID_USER_HOME`, else `.android/avd` under the
 * deprecated `$ANDROID_PREFS_ROOT` / `$ANDROID_SDK_HOME`, else
 * `~/.android/avd`. `$ANDROID_EMULATOR_HOME` is the emulator's config
 * directory, not the AVD home, so it is not consulted.
 */
export function avdHomeDir(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return path.join(env.ANDROID_USER_HOME, 'avd');
  const prefsRoot = env.ANDROID_PREFS_ROOT || env.ANDROID_SDK_HOME;
  if (prefsRoot) return path.join(prefsRoot, '.android', 'avd');
  return path.join(homedir, '.android', 'avd');
}

/**
 * Scan the AVD home directory (`avdHomeDir()`) and
 * return each AVD with its system image tag. Each `<name>.ini` points at the
 * `.avd` data directory via its `path=` key; the tag lives in that
 * directory's `config.ini`.
 */
export function scanAvdImageTags(avdHome?: string): AvdImageInfo[] {
  const home = avdHome ?? avdHomeDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return [];
  }

  const avds: AvdImageInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ini')) continue;
    const name = entry.slice(0, -'.ini'.length);
    try {
      const ini = fs.readFileSync(path.join(home, entry), 'utf-8');
      const pathMatch = ini.match(/^path\s*=\s*(.+)$/m);
      const avdDir = pathMatch ? pathMatch[1].trim() : path.join(home, `${name}.avd`);
      const configIni = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf-8');
      avds.push({ name, tagId: parseAvdImageTag(configIni), apiLevel: parseAvdApiLevel(configIni) });
    } catch {
      avds.push({ name });
    }
  }
  return avds;
}

// ─── Capture capability ───

/**
 * Google Play system images: production builds without `adb root`. Matched
 * anywhere in the tag, since Play variants carry their own tags
 * (`google_apis_playstore`, `google_apis_playstore_ps16k`,
 * `android-automotive-playstore`).
 */
const PLAY_STORE_TAG_RE = /playstore/;

/**
 * - `capable`: a rootable image (Google APIs, AOSP, ATD), so Tapsmith can
 *   install its CA cert and HTTPS is captured.
 * - `play-image`: a Google Play image; tests run, HTTPS is passed through
 *   uncaptured (see {@link PLAY_IMAGE_CAPTURE_EFFECT}).
 * - `unknown`: the AVD's `config.ini` could not be read (or the AVD was not
 *   found), so nothing can be promised either way.
 */
export type AvdCaptureSupport = 'capable' | 'play-image' | 'unknown';

/**
 * What network capture does on a Google Play image, for every message that
 * names one (init, doctor). The daemon tunnels HTTPS there instead of
 * breaking it (PILOT-711), so the app keeps working and only capture is lost.
 */
export const PLAY_IMAGE_CAPTURE_EFFECT =
  "no adb root, so Tapsmith can't install its CA certificate: the app's HTTPS requests still reach their servers, "
  + "but they are not captured and device.route() can't intercept them (plain HTTP is still captured)";

export function avdCaptureSupport(avd: AvdImageInfo | undefined): AvdCaptureSupport {
  if (!avd || avd.tagId === undefined) return 'unknown';
  return PLAY_STORE_TAG_RE.test(avd.tagId) ? 'play-image' : 'capable';
}

/**
 * The `create-avd` command for a NEW capture-capable AVD. The name is the
 * `create-avd` default (`Tapsmith_Phone_API_<api>`) unless an AVD already
 * has it, in which case a numeric suffix keeps it free — `create-avd`
 * refuses an existing name without `--force`, and `--force` would wipe that
 * AVD's data, so it is never suggested.
 *
 * `apiLevel` keeps the replacement on the same Android version as the AVD
 * it stands in for.
 */
export function newCaptureAvd(
  avds: AvdImageInfo[],
  apiLevel?: number,
  reserved: string[] = [],
): { name: string; command: string } {
  const api = apiLevel ?? DEFAULT_API_LEVEL;
  const base = defaultAvdName(api);
  const taken = new Set([...avds.map((a) => a.name), ...reserved]);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  const apiArg = api === DEFAULT_API_LEVEL ? '' : ` --api ${api}`;
  const nameArg = name === base ? '' : ` --name ${name}`;
  return { name, command: `npx tapsmith create-avd${apiArg}${nameArg}` };
}

export interface CaptureAvdFixOptions {
  /**
   * The configured AVD names the fix replaces. Named in the fix so the user
   * edits the `avd` (or per-project `use.avd`) that actually holds them.
   */
  replacing?: string[];
  /** Prefer (or create) an AVD on this API level. */
  apiLevel?: number;
  /** Names another suggested command will create; never suggested again. */
  reserved?: string[];
}

/**
 * The non-destructive fix for "the AVD Tapsmith will boot can't capture
 * HTTPS": point `avd` at a capture-capable AVD the machine already has
 * (preferring one on `apiLevel`), or else create a new one beside the
 * user's existing AVDs.
 */
export function captureAvdFix(avds: AvdImageInfo[], opts: CaptureAvdFixOptions = {}): string {
  const { replacing = [], apiLevel, reserved } = opts;
  const inPlaceOf = replacing.length > 0 ? ` in place of ${replacing.map((n) => `'${n}'`).join(', ')}` : '';
  const pick = pickCaptureAvd(avds, apiLevel, reserved);
  if (!pick.command) {
    return `Use ${pick.name}, which supports HTTPS capture: set avd: '${pick.name}' in your Tapsmith config${inPlaceOf}`;
  }
  const untouched = avds.length > 0 ? ' (your existing AVDs are left untouched)' : '';
  return `Create a capture-capable AVD${untouched} — run: ${pick.command}, then set avd: '${pick.name}' in your Tapsmith config${inPlaceOf}`;
}

/**
 * The capture-capable AVD to point `avd` at: one the machine already has
 * (preferring `apiLevel`; no `command`), or else a new one and the
 * `create-avd` command that makes it.
 */
function pickCaptureAvd(avds: AvdImageInfo[], apiLevel?: number, reserved?: string[]): { name: string; command?: string } {
  const capable = avds.filter((a) => avdCaptureSupport(a) === 'capable');
  if (capable.length > 0) {
    return { name: (capable.find((a) => apiLevel !== undefined && a.apiLevel === apiLevel) ?? capable[0]).name };
  }
  return newCaptureAvd(avds, apiLevel, reserved);
}

/**
 * init's Next steps entry for an AVD on a Google Play image (PILOT-711): the
 * capture-capable AVD to switch to, or the `create-avd` command for one, and
 * — when the config was written without capture — the trace setting that
 * turns it on. `undefined` unless `avd` is known to be a Play image.
 */
export function captureAvdNextStep(
  avd: string | undefined,
  avds: AvdImageInfo[],
  captureEnabled: boolean,
): { label: string; action: string; optional: boolean } | undefined {
  const info = avd === undefined ? undefined : avds.find((a) => a.name === avd);
  if (avdCaptureSupport(info) !== 'play-image') return undefined;
  const pick = pickCaptureAvd(avds, info?.apiLevel);
  // Names the value to change rather than "set avd": with several platforms
  // the generated config keeps `avd` in the android project's `use`, where a
  // new top-level `avd` would be overridden.
  const trace = captureEnabled ? '' : ", and add trace: { mode: 'retain-on-failure' }";
  const setAvd = `change avd: '${avd}' to '${pick.name}' in tapsmith.config.ts${trace}`;
  // Without capture the step is an option, not part of the setup: callers
  // list it last, and the label says so.
  const label = captureEnabled ? 'Capture HTTPS' : 'Optional, to capture HTTPS';
  return { label, action: pick.command ? `${pick.command}, then ${setAvd}` : setAvd, optional: !captureEnabled };
}

/**
 * Why HTTPS will not be captured on the AVD named `name` (and what happens
 * to it instead), with the fix, or
 * `undefined` when it will be.
 */
export function avdCaptureWarning(name: string, avds: AvdImageInfo[]): string | undefined {
  const avd = avds.find((a) => a.name === name);
  const support = avdCaptureSupport(avd);
  if (support === 'capable') return undefined;
  const problem = !avd
    ? `AVD ${name} was not found on this machine, so HTTPS capture on it is unverified — check the name`
    : support === 'play-image'
      ? `AVD ${name} uses a Google Play system image — ${PLAY_IMAGE_CAPTURE_EFFECT}`
      : `Could not read the system image of AVD ${name}, so HTTPS capture on it is unverified (it needs a Google APIs image, not Google Play)`;
  return `${problem}. ${captureAvdFix(avds, { replacing: [name], apiLevel: avd?.apiLevel })}`;
}

/**
 * What init says when `emulator -list-avds` lists no AVDs. If the AVD home
 * has some, the emulator binary was not found (Tapsmith looks in the SDK and
 * then PATH, `resolveEmulatorBinary`) or failed — Tapsmith launches AVDs with
 * it, so the fix is the emulator install, not a new AVD.
 */
export function noAvdsListedMessage(avdImages: AvdImageInfo[], chosenAvd?: string): string {
  if (avdImages.length === 0) return `No Android AVDs found. ${captureAvdFix([])}`;
  const names = avdImages.map((a) => a.name).sort((a, b) => a.localeCompare(b)).join(', ');
  // With an AVD already chosen (explicit --avd) the config is complete; only PATH needs fixing.
  const next = chosenAvd
    ? `so Tapsmith can launch ${chosenAvd}`
    : 'then re-run npx tapsmith init';
  return `Found AVDs (${names}), but \`emulator -list-avds\` listed none: the Android emulator is not installed where Tapsmith looks `
    + '($ANDROID_HOME/emulator, $ANDROID_SDK_ROOT/emulator, the default SDK location, then PATH), or it failed. '
    + 'Tapsmith needs it to launch AVDs. Install "Android Emulator" from Android Studio\'s SDK Manager (SDK Tools), '
    + `or set ANDROID_HOME to the SDK that has it, ${next}`;
}
