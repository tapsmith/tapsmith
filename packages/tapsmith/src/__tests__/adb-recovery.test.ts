import { describe, expect, it } from 'vitest';
import { checkPinnedDeviceHealth, pinnedDeviceNotListedMessage, type PinnedDeviceHealthDeps } from '../adb-recovery.js';
import type { DeviceClaim } from '../device-claims.js';
import type { DeviceHealthResult } from '../emulator.js';

// ─── Fake adb ───

type AdbReply = string | Error;

interface FakeAdbOptions {
  /** `adb devices` output, per call (the last one repeats); an Error makes the server "not answer". */
  devices: AdbReply[];
  /** Reply to the patient `echo` (defaults to a timeout). */
  echo?: AdbReply;
  /** Results of successive stability waits (the last one repeats). */
  stability: DeviceHealthResult[];
  /** The one-probe answer for a settled device; undefined = not settled. */
  settled?: DeviceHealthResult;
  heldElsewhere?: DeviceClaim[];
  startServer?: AdbReply;
}

function devicesOutput(...lines: string[]): string {
  return ['List of devices attached', ...lines, ''].join('\n');
}

function fakeAdb(opts: FakeAdbOptions) {
  const calls: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  let devicesCall = 0;
  let stabilityCall = 0;
  let clock = 0;
  const reply = (r: AdbReply): string => {
    if (r instanceof Error) throw r;
    return r;
  };
  const deps: PinnedDeviceHealthDeps = {
    adb: (args) => {
      const cmd = args.join(' ');
      calls.push(cmd);
      if (cmd === 'devices') return reply(opts.devices[Math.min(devicesCall++, opts.devices.length - 1)]!);
      if (cmd.endsWith('shell echo __tapsmith_health_ok__')) return reply(opts.echo ?? new Error('ETIMEDOUT'));
      if (cmd === 'start-server') return reply(opts.startServer ?? '');
      return '';
    },
    probeIfSettled: async (serial) => {
      calls.push(`<probe settled ${serial}>`);
      return opts.settled;
    },
    waitForStable: async (serial) => {
      calls.push(`<wait for ${serial}>`);
      return opts.stability[Math.min(stabilityCall++, opts.stability.length - 1)]!;
    },
    heldElsewhere: () => opts.heldElsewhere ?? [],
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    note: (m) => notes.push(m),
    warn: (m) => warnings.push(m),
  };
  /** The commands that change adb's state — what the ticket is about. */
  const mutating = (): string[] => calls.filter((c) => /reconnect|kill-server|start-server/.test(c));
  return { deps, calls, notes, warnings, mutating };
}

const SERIAL = 'emulator-5554';
const healthy: DeviceHealthResult = { serial: SERIAL, healthy: true };
const shellDead: DeviceHealthResult = { serial: SERIAL, healthy: false, reason: 'ADB shell is unresponsive' };

function claim(device: string, pid = 4242): DeviceClaim {
  return {
    device,
    session: { id: 'other', pid, command: 'tapsmith test --ui', project: '/work/app', startedAt: '2026-10-09T10:00:00.000Z' },
    claimantPid: pid,
    claimedAt: '2026-10-09T10:00:00.000Z',
  };
}

// ─── Tests ───

describe('checkPinnedDeviceHealth (PILOT-475)', () => {
  it('takes one probe of a settled device as the answer, without the stability wait', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [shellDead], settled: healthy });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.calls.filter((c) => c.startsWith('<'))).toEqual([`<probe settled ${SERIAL}>`]);
  });

  it('waits for stability when the device is not settled, or its one probe is unhealthy', async () => {
    for (const settled of [undefined, { serial: SERIAL, healthy: false, reason: 'package manager is not ready' }]) {
      const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [healthy], settled });
      await checkPinnedDeviceHealth(SERIAL, adb.deps);
      expect(adb.calls.filter((c) => c.startsWith('<'))).toEqual([`<probe settled ${SERIAL}>`, `<wait for ${SERIAL}>`]);
    }
  });

  it('re-checks a recovered device with the stability wait, never the one-probe shortcut', async () => {
    // After a reconnect the device's uptime is unchanged, but its adbd just
    // came back: only consecutive healthy probes say it stays up.
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`)],
      stability: [shellDead, healthy],
      settled: shellDead,
    });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.calls.filter((c) => c.startsWith('<probe settled'))).toHaveLength(1);
    expect(adb.calls.filter((c) => c.startsWith('<wait for'))).toHaveLength(2);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`]);
  });

  it('touches nothing when the device is healthy', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [healthy] });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([]);
  });

  it('fails fast for a serial adb does not list, without reconnecting or restarting anything', async () => {
    const adb = fakeAdb({ devices: [devicesOutput('emulator-5556\tdevice')], stability: [shellDead] });
    await expect(checkPinnedDeviceHealth('bogus-123', adb.deps)).rejects.toThrow(
      'Device bogus-123 is not connected: adb does not list it (adb lists emulator-5556 (device)).',
    );
    expect(adb.mutating()).toEqual([]);
    expect(adb.calls).not.toContain('<wait for bogus-123>');
  });

  it('says adb lists no devices when the list is empty', () => {
    expect(pinnedDeviceNotListedMessage('X', [])).toContain('(adb lists no devices)');
  });

  it('tells the user how to recover a device adb has lost, and what that costs', () => {
    const msg = pinnedDeviceNotListedMessage('X', []);
    expect(msg).toContain('If it is attached but adb has lost it, restart adb with `adb kill-server`');
    expect(msg).toContain('disconnects every adb client on this machine');
  });

  it('accepts a slow device that answers a patient echo (a loaded host), with no recovery', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`)],
      stability: [shellDead],
      echo: '__tapsmith_health_ok__\n',
    });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([]);
  });

  it('reconnects only the pinned device first, and stops there when that brings it back', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`, 'emulator-5556\toffline')], stability: [shellDead, healthy] });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`]);
    expect(adb.notes.join('\n')).toContain(`Device ${SERIAL} reconnected and is responsive.`);
  });

  it('does not restart the ADB server while another Tapsmith session holds an Android device', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`, 'emulator-5556\tdevice')],
      stability: [shellDead],
      heldElsewhere: [claim('emulator-5556')],
    });
    const err = await checkPinnedDeviceHealth(SERIAL, adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`]);
    expect(err?.message).toContain('Tapsmith did not restart the ADB server: that would disconnect another Tapsmith session using Android devices: emulator-5556 (`tapsmith test --ui` (pid 4242) in /work/app');
    expect(err?.message).toContain(`Device ${SERIAL} is not responding, even after \`adb reconnect\`.`);
  });

  it('stops after the reconnect, without a restart, when the shell answers but the device is not ready', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`)],
      stability: [shellDead, { serial: SERIAL, healthy: false, reason: 'package manager is not ready' }],
    });
    await expect(checkPinnedDeviceHealth(SERIAL, adb.deps)).rejects.toThrow(`Device ${SERIAL} is not ready: package manager is not ready.`);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`]);
  });

  it('never advises `adb kill-server` for an offline phone when it refused the restart', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput('R58M123\toffline', 'emulator-5556\tdevice')],
      stability: [{ serial: 'R58M123', healthy: false, reason: 'ADB shell is unresponsive' }],
      heldElsewhere: [claim('emulator-5556')],
    });
    const err = await checkPinnedDeviceHealth('R58M123', adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual(['-s R58M123 reconnect']);
    const headline = err?.message.split('\n')[0];
    expect(headline).toBe('Device R58M123 is attached, but adb reports it offline. Reconnect the cable, or restart the device.');
    expect(err?.message).toContain('Tapsmith did not restart the ADB server');
  });

  it('still refuses the restart when the ADB server does not answer and another session holds an Android device', async () => {
    const adb = fakeAdb({ devices: [new Error('ETIMEDOUT')], stability: [shellDead], heldElsewhere: [claim('R58M123')] });
    const err = await checkPinnedDeviceHealth(SERIAL, adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual([]);
    expect(err?.message).toContain('and the ADB server is not answering');
    expect(err?.message).toContain('R58M123');
  });

  it('restarts the ADB server as a last resort when only iOS devices are held elsewhere, and says so first', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`)],
      stability: [shellDead, shellDead, healthy],
      heldElsewhere: [claim('A1B2C3D4-0000-1111-2222-333344445555')],
    });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`, 'kill-server', 'start-server']);
    // A warning, not a progress note: the restart must stand out.
    const restartNote = adb.warnings.find((n) => n.includes('Restarting the ADB server'));
    expect(restartNote).toContain('this disconnects every adb client on this machine');
    expect(adb.notes.at(-1)).toBe('ADB recovered. Device is responsive.');
  });

  it('goes straight to the restart when the ADB server does not answer and no other session holds a device', async () => {
    const adb = fakeAdb({ devices: [new Error('ETIMEDOUT')], stability: [shellDead, healthy] });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual(['kill-server', 'start-server']);
  });

  it('reports a failed server start', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [shellDead], startServer: new Error('ENOENT') });
    await expect(checkPinnedDeviceHealth(SERIAL, adb.deps)).rejects.toThrow('Failed to restart ADB server.');
  });

  it("names adb's state after a restart, without advising another restart", async () => {
    const adb = fakeAdb({
      devices: [devicesOutput('R58M123\toffline')],
      stability: [{ serial: 'R58M123', healthy: false, reason: 'ADB shell is unresponsive' }],
    });
    const err = await checkPinnedDeviceHealth('R58M123', adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual(['-s R58M123 reconnect', 'kill-server', 'start-server']);
    expect(err?.message).toContain('R58M123 is attached, but adb reports it offline. Tapsmith already restarted the ADB server');
    expect(err?.message).not.toContain('kill-server');
  });

  it('ends with generic advice, never "run adb kill-server", when the device stays unresponsive after a restart', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [shellDead] });
    const err = await checkPinnedDeviceHealth(SERIAL, adb.deps).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain(`Device ${SERIAL} is not responding, even after Tapsmith restarted the ADB server.`);
    expect(err?.message).not.toContain('kill-server');
    expect(err?.message).toContain(`adb -s ${SERIAL} emu kill`);
  });

  it('throws "not ready" without any recovery for a non-shell failure', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [{ serial: SERIAL, healthy: false, reason: 'emulator is not fully booted' }] });
    await expect(checkPinnedDeviceHealth(SERIAL, adb.deps)).rejects.toThrow(`Device ${SERIAL} is not ready: emulator is not fully booted.`);
    expect(adb.mutating()).toEqual([]);
  });

  it('refuses an unauthorized pin without touching the server (PILOT-457 preflight kept)', async () => {
    const adb = fakeAdb({ devices: [devicesOutput('R58M123\tno permissions (user in plugdev group; are your udev rules wrong?)')], stability: [shellDead] });
    await expect(checkPinnedDeviceHealth('R58M123', adb.deps)).rejects.toThrow('R58M123 is attached, but adb reports it no permissions');
    expect(adb.mutating()).toEqual([]);
  });
});
