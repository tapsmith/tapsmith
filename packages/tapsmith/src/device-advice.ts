/**
 * What to tell a user whose run found no usable device, in terms of the
 * config they actually have. The old wording always ended "or set `avd`",
 * which sent users with `avd` set to change a setting they already had.
 */

import type { TapsmithConfig } from './config.js';
import { androidStateBlocker, type AdbDevice } from './adb-devices.js';

type AdviceConfig = Pick<TapsmithConfig, 'avd' | 'launchEmulators'>;

/**
 * Advice for "no online Android device was found". `toolchainBlocker` is
 * `androidToolchainBlocker()`: when adb itself is missing, that is all the
 * user needs to hear — no setting can help yet.
 */
export function noDeviceAdvice(config: AdviceConfig, toolchainBlocker: string | undefined): string {
  if (toolchainBlocker) return `${toolchainBlocker}.`;
  if (!config.avd) {
    return 'Connect a device, start an emulator, or set `avd` in your config to auto-launch emulators.';
  }
  if (!config.launchEmulators) {
    return `\`avd\` is "${config.avd}" but \`launchEmulators\` is false, so Tapsmith does not boot it. `
      + 'Start the emulator yourself, or remove `launchEmulators: false`.';
  }
  return `Tapsmith tried to boot the "${config.avd}" emulator, but no healthy device came online (see any warnings above). `
    + 'Check that it boots from Android Studio\'s Device Manager, or run `tapsmith doctor`.';
}

/**
 * Advice for a `use.devices` group that is short of devices.
 * `toolchainBlocker` is `toolchainBlocker(config.platform)`.
 */
export function moreDevicesAdvice(config: AdviceConfig & Pick<TapsmithConfig, 'platform'>, toolchainBlocker: string | undefined): string {
  if (toolchainBlocker) return `${toolchainBlocker}.`;
  if (config.platform === 'ios') {
    return 'Boot more simulators matching `simulator`, or pin members with `device`.';
  }
  if (!config.avd) {
    return 'Connect more devices, set `avd` so emulators can be launched, or pin members with `device`.';
  }
  if (!config.launchEmulators) {
    return 'Connect more devices, remove `launchEmulators: false` so emulators can be launched, or pin members with `device`.';
  }
  return 'Connect more devices, or pin members with `device`.';
}

/** Advice for "devices were found, but no worker started on any of them". */
export function workerStartAdvice(): string {
  return 'Fix the worker failure above, or run `tapsmith doctor` to check your setup.';
}

// ─── Attached but unusable Android devices (PILOT-457) ───

/**
 * An Android device and its adb state, from `adb devices` or the daemon's
 * `ListDevicesResponse` (whose `unusable_devices` carry adb's state).
 * `platform` lets daemon entries for other platforms be passed as they are.
 */
export type AdbStateEntry = AdbDevice & { platform?: string };

/** Usable by Tapsmith: adb's `device` state, or the daemon's names for it. */
export function isUsableAndroidState(state: string): boolean {
  return state === 'device' || state === 'Discovered' || state === 'Active';
}

/**
 * "`<serial>` is attached, but adb reports it unauthorized. Accept the USB
 * debugging prompt on the device." — the advice `doctor` and `list-devices`
 * give (`androidStateBlocker`), for the test-run paths' errors.
 */
export function describeUnusableAndroidDevice(device: AdbDevice, fix?: string): string {
  const advice = fix
    ?? androidStateBlocker(device.state, device.serial)
    ?? 'Reconnect it, or run `adb kill-server` and try again';
  return `${device.serial} is attached, but adb reports it ${device.state}. ${advice}.`;
}

function unusableAndroid(devices: readonly AdbStateEntry[]): AdbStateEntry[] {
  return devices.filter((d) => (d.platform ?? 'android') === 'android' && !isUsableAndroidState(d.state));
}

/** {@link describeUnusableAndroidDevice} for each Android entry adb cannot use; usable and other-platform entries are skipped. */
export function describeUnusableAndroidDevices(devices: readonly AdbStateEntry[]): string[] {
  return unusableAndroid(devices).map((d) => describeUnusableAndroidDevice(d));
}

/**
 * {@link noDeviceAdvice}, preceded by every attached device adb cannot use —
 * the phone whose USB-debugging prompt was never accepted is the likeliest
 * reason a first run finds nothing.
 */
export function attachedDeviceAdvice(config: AdviceConfig, attached: readonly AdbStateEntry[], toolchainBlocker: string | undefined): string {
  return [...describeUnusableAndroidDevices(attached), noDeviceAdvice(config, toolchainBlocker)].join(' ');
}

/** "No online devices found." for an Android run, with {@link attachedDeviceAdvice}. */
export function noOnlineDeviceMessage(config: AdviceConfig, attached: readonly AdbStateEntry[], toolchainBlocker: string | undefined): string {
  return `No online devices found. ${attachedDeviceAdvice(config, attached, toolchainBlocker)}`;
}

/**
 * The error for a pinned Android device adb lists but cannot use, or
 * undefined when it is usable or not listed. `preflight` (before any ADB
 * server restart) reports only states a restart cannot fix — unauthorized
 * and no-permissions — since `offline` (whose fix *is* a restart) and
 * transient states such as `authorizing` may recover; `any` reports
 * whatever state adb gives, with the shared fix; `after-adb-restart` does
 * too, but — once Tapsmith has restarted the ADB server itself — never
 * advises the restart again.
 */
export function pinnedDeviceUnusableMessage(
  serial: string,
  devices: readonly AdbStateEntry[],
  phase: 'preflight' | 'after-adb-restart' | 'any',
): string | undefined {
  // A usable device sharing the serial wins, as in the daemon: cheap phones
  // can share one (`0123456789ABCDEF`).
  if (devices.some((d) => d.serial === serial && isUsableAndroidState(d.state))) return undefined;
  const device = unusableAndroid(devices).find((d) => d.serial === serial);
  if (!device) return undefined;
  if (phase === 'preflight' && device.state !== 'unauthorized' && !device.state.startsWith('no permissions')) {
    return undefined;
  }
  // After the restart, advice to restart adb would repeat what just failed.
  // An emulator's own advice (wait for boot, or restart it) still applies.
  const emulator = device.serial.startsWith('emulator-');
  const restarted = phase === 'after-adb-restart'
    && !device.state.startsWith('no permissions') && device.state !== 'unauthorized'
    && !(emulator && device.state === 'offline');
  const afterRestart = emulator
    ? 'Tapsmith already restarted the ADB server: restart the emulator'
    : 'Tapsmith already restarted the ADB server: reconnect the cable, or restart the device';
  return `Device ${describeUnusableAndroidDevice(device, restarted ? afterRestart : undefined)}`;
}

/**
 * Before a pinned device's health check: give the user time to accept the
 * USB-debugging prompt on an `unauthorized` pin — they often start the run
 * first and tap "Allow" a moment later — saying once what the run waits for.
 * Resolves undefined when the pin is usable, unlisted, or in a state the
 * ADB-restart recovery handles (`offline`, …); otherwise the error to throw:
 * at once for no-permissions (only the user's udev setup changes that), or
 * once `timeoutMs` passes still unauthorized.
 */
export async function waitForPinnedDeviceAuthorization(
  serial: string,
  deps: {
    listAdbDevices: () => readonly AdbStateEntry[];
    sleep: (ms: number) => Promise<void>;
    onWaiting: (message: string) => void;
    /** Clock for the deadline — each `adb devices` call takes time of its own. */
    now?: () => number;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<string | undefined> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const pollMs = deps.pollMs ?? 1_000;
  const start = now();
  const deadline = start + timeoutMs;
  // The pinned path makes no adb call before this one, so it often starts the
  // adb server, which can list a just-plugged phone (or show it `offline`) a
  // moment late: give that a few seconds before handing over to recovery.
  const graceEnd = start + Math.min(5_000, timeoutMs);
  let noted = false;
  for (;;) {
    const devices = deps.listAdbDevices();
    const mine = devices.filter((d) => d.serial === serial);
    const blocked = pinnedDeviceUnusableMessage(serial, devices, 'preflight');
    const usable = mine.some((d) => isUsableAndroidState(d.state));
    // `authorizing` is adb trying its stored keys, before the phone shows the
    // prompt (`unauthorized`) — or just after it was accepted. Once
    // waiting, a pin briefly gone from adb, or `offline` while its transport
    // reconnects, is still pending — replugging the cable is how the prompt
    // is brought back.
    const pending = !usable && (mine.some((d) => d.state === 'unauthorized' || d.state === 'authorizing')
      || ((noted || now() < graceEnd) && mine.every((d) => d.state === 'offline')));
    if (!pending) return blocked;
    if (now() >= deadline) {
      return noted && mine.length === 0
        ? `Device ${serial} is no longer listed by adb. Reconnect it, then accept the USB debugging prompt on the device.`
        : blocked;
    }
    const prompting = mine.some((d) => d.state === 'unauthorized' || d.state === 'authorizing');
    if (!noted && prompting) {
      noted = true;
      const seconds = Math.round(timeoutMs / 1000);
      deps.onWaiting(`Waiting up to ${seconds} s for ${serial} to be authorized: accept the USB debugging prompt on the device.`);
    }
    await deps.sleep(Math.max(0, Math.min(pollMs, deadline - now())));
  }
}
