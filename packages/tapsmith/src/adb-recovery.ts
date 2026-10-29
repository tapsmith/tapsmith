/**
 * The pre-run health check for a pinned Android device, and what it does when
 * the device does not answer.
 *
 * The ADB server is shared by every adb client on the machine: other Tapsmith
 * sessions and their daemons' forwarded agent sockets, Android Studio,
 * logcat, scrcpy. Restarting it (`adb kill-server`) drops all of them, so the
 * recovery tries the targeted fixes first and restarts the server only as a
 * last resort, only when no other Tapsmith session holds an Android device,
 * and says so when it does:
 *
 * 1. a pinned serial adb does not list fails at once — usually a wrong
 *    serial; the error says how to restart adb if the device is attached;
 * 2. a slow reply is not a dead device: one patient `echo` before any
 *    recovery, so a loaded host does not set it off;
 * 3. `adb -s <serial> reconnect` kicks only this device's transport;
 * 4. the server restart, unless another live session holds an Android device.
 */

import { parseAdbDevicesOutput, type AdbDevice } from './adb-devices.js';
import { describeUnusableAndroidDevice, isUsableAndroidState, pinnedDeviceUnusableMessage, waitForPinnedDeviceAuthorization } from './device-advice.js';
import { describeHolder, type DeviceClaim } from './device-claims.js';
import type { DeviceHealthResult } from './emulator.js';
import { platformOfSerial } from './project.js';

// ─── Types ───

export interface PinnedDeviceHealthDeps {
  /** Runs `adb <args>` and returns its stdout; throws when adb fails or times out. */
  adb: (args: readonly string[], timeoutMs: number) => string;
  /** Waits for the device to pass consecutive health probes (`waitForDeviceStability`). */
  waitForStable: (serial: string) => Promise<DeviceHealthResult>;
  /** Live device claims of Tapsmith sessions other than this one (`device-claims.ts`). */
  heldElsewhere: () => readonly DeviceClaim[];
  sleep: (ms: number) => Promise<void>;
  /** Clock for the authorization wait's deadline (test seam; defaults to `Date.now`). */
  now?: () => number;
  /** Prints a progress line for the user. */
  note: (message: string) => void;
  /** Prints a line the user must not miss — the server restart's warning. */
  warn: (message: string) => void;
}

const HEALTH_MARKER = '__tapsmith_health_ok__';

// ─── Helpers ───

/** `adb devices`, or undefined when the ADB server does not answer. */
function listDevices(deps: PinnedDeviceHealthDeps): AdbDevice[] | undefined {
  try {
    return parseAdbDevicesOutput(deps.adb(['devices'], 10_000));
  } catch {
    return undefined;
  }
}

/** "Device X is not connected: …" for a serial `adb devices` does not list. */
export function pinnedDeviceNotListedMessage(serial: string, devices: readonly AdbDevice[]): string {
  const listed = devices.length > 0
    ? `adb lists ${devices.map((d) => `${d.serial} (${d.state})`).join(', ')}`
    : 'adb lists no devices';
  return `Device ${serial} is not connected: adb does not list it (${listed}). `
    + 'Check the serial Tapsmith was given (`device` in your config, or `--device`), or connect the device. '
    + 'If it is attached but adb has lost it, restart adb with `adb kill-server` and try again '
    + '(this disconnects every adb client on this machine, other Tapsmith sessions included).';
}

function respondsToEcho(serial: string, deps: PinnedDeviceHealthDeps, timeoutMs: number): boolean {
  try {
    return deps.adb(['-s', serial, 'shell', 'echo', HEALTH_MARKER], timeoutMs).includes(HEALTH_MARKER);
  } catch {
    return false;
  }
}

/** Generic advice for a device that stayed unresponsive. */
function notRespondingAdvice(serial: string, extra: readonly string[]): string[] {
  return [
    '  Possible causes:',
    '    • Emulator crashed or froze — restart it',
    '    • Multiple emulators competing for the same port',
    '    • USB device disconnected',
    '  Try:',
    ...extra,
    '    $ adb devices -l',
    ...(serial.startsWith('emulator') ? [`    $ adb -s ${serial} emu kill  # restart the emulator`] : []),
  ];
}

// ─── Health check ───

/**
 * Verify the pinned Android device is responsive before a run, recovering it
 * if it is not (see the module comment for the order). Resolves when the
 * device is usable; throws an Error whose message says what is wrong and
 * what to do otherwise.
 */
export async function checkPinnedDeviceHealth(serial: string, deps: PinnedDeviceHealthDeps): Promise<void> {
  // Attached but unauthorized (or, on Linux, no USB permission): no restart
  // of the ADB server fixes that. Give the user time to accept the prompt,
  // then say what to do instead of "not responding" (PILOT-457).
  const blocked = await waitForPinnedDeviceAuthorization(serial, {
    listAdbDevices: () => listDevices(deps) ?? [],
    sleep: deps.sleep,
    now: deps.now,
    onWaiting: deps.note,
  });
  if (blocked) throw new Error(blocked);

  // A serial adb does not list is not a device to recover. (A listing that
  // failed says nothing about the device: the probes below find out.)
  const before = listDevices(deps);
  if (before && !before.some((d) => d.serial === serial)) {
    throw new Error(pinnedDeviceNotListedMessage(serial, before));
  }

  const stable = await deps.waitForStable(serial);
  if (stable.healthy) return;
  if (stable.reason && !stable.reason.includes('ADB shell')) {
    throw new Error(`Device ${serial} is not ready: ${stable.reason}.`);
  }

  // The probes allow 5 s per reply; a loaded host can take longer for a
  // device that is fine. A shell that answers at all needs no recovery.
  if (respondsToEcho(serial, deps, 15_000)) return;

  // Targeted recovery: kick this device's transport only. Skipped when the
  // ADB server itself does not answer — only a restart helps then.
  const listed = listDevices(deps);
  if (listed) {
    if (!listed.some((d) => d.serial === serial)) {
      throw new Error(pinnedDeviceNotListedMessage(serial, listed));
    }
    deps.note(`Device ${serial} is unresponsive. Reconnecting it (adb reconnect)...`);
    try {
      deps.adb(['-s', serial, 'reconnect'], 10_000);
    } catch {
      // The probes below decide whether it came back.
    }
    await deps.sleep(2_000);
    const after = await deps.waitForStable(serial);
    if (after.healthy) {
      deps.note(`Device ${serial} reconnected and is responsive.`);
      return;
    }
    // The shell answers again; what is left (boot, package manager, a
    // dialog) is the device's own, and no server restart fixes it.
    if (after.reason && !after.reason.includes('ADB shell')) {
      throw new Error(`Device ${serial} is not ready: ${after.reason}.`);
    }
  }

  // Last resort: restart the ADB server — never under another session that
  // is driving an Android device, which the restart would disconnect.
  const others = deps.heldElsewhere().filter((c) => platformOfSerial(c.device) === 'android');
  if (others.length > 0) {
    // adb's state for the pin, with advice that does not contradict the refusal.
    const state = listDevices(deps);
    const unusable = state && pinnedDeviceUnusableMessage(serial, state, 'any')
      ? `Device ${describeUnusableAndroidDevice(
        state.find((d) => d.serial === serial && !isUsableAndroidState(d.state))!,
        serial.startsWith('emulator-') ? 'Restart the emulator' : 'Reconnect the cable, or restart the device',
      )}`
      : undefined;
    const holders = others.map((c) => `${c.device} (${describeHolder(c)})`).join('; ');
    throw new Error([
      unusable ?? `Device ${serial} is not responding${listed ? ', even after `adb reconnect`' : ', and the ADB server is not answering'}.`,
      `  Tapsmith did not restart the ADB server: that would disconnect ${others.length === 1 ? 'another Tapsmith session' : 'other Tapsmith sessions'} using Android devices: ${holders}.`,
      ...notRespondingAdvice(serial, ['    $ adb kill-server && adb start-server  # once those sessions have finished']),
    ].join('\n'));
  }

  deps.warn(
    `Device ${serial} is still unresponsive. Restarting the ADB server as a last resort: `
    + 'this disconnects every adb client on this machine (Android Studio, logcat, scrcpy, …).',
  );
  try {
    deps.adb(['kill-server'], 5_000);
  } catch {
    // kill-server fails when no server is running.
  }
  // Give ADB time to fully shut down.
  await deps.sleep(2_000);
  try {
    deps.adb(['start-server'], 10_000);
  } catch {
    throw new Error('Failed to restart ADB server.\n  Check that Android SDK platform-tools are installed and on PATH.');
  }
  // Wait for the device to come back.
  await deps.sleep(3_000);

  if ((await deps.waitForStable(serial)).healthy) {
    deps.note('ADB recovered. Device is responsive.');
    return;
  }

  // Still unusable, and adb says why: that beats a list of possible causes.
  const unusable = pinnedDeviceUnusableMessage(serial, listDevices(deps) ?? [], 'after-adb-restart');
  if (unusable) throw new Error(unusable);

  throw new Error([
    `Device ${serial} is not responding, even after Tapsmith restarted the ADB server.`,
    ...notRespondingAdvice(serial, []),
  ].join('\n'));
}
