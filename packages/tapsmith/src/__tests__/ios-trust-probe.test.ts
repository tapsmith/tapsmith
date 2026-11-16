import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { profileExpiryInfoAt, type ProfileExpiryInfo } from '../ios-profile-expiry.js';
import {
  checkRunnerTrust,
  classifyDevicectlError,
  clearTrustProbeCache,
  describeRunnerTrustFailure,
  findRunnerApp,
  isSuccessfulLaunch,
  type RunnerTrustOps,
  type TrustState,
} from '../ios-trust-probe.js';

describe('isSuccessfulLaunch', () => {
  it('recognises the devicectl success line observed on Xcode 26', () => {
    const real = [
      'Acquired tunnel connection to device.',
      'Enabling developer disk image services.',
      'Acquired usage assertion.',
      'Launched application with dev.tapsmith.agent.xctrunner bundle identifier.',
    ].join('\n');
    expect(isSuccessfulLaunch(real)).toBe(true);
  });

  it('returns false for error-only output', () => {
    expect(isSuccessfulLaunch('Error: No such app on device')).toBe(false);
    expect(isSuccessfulLaunch('')).toBe(false);
  });

  it('ignores unrelated noise in the same output', () => {
    // devicectl sometimes emits a harmless `Failed to load provisioning parameter list`
    // alongside a successful launch — the success line must still win.
    const noisy = [
      'Launched application with dev.tapsmith.agent.xctrunner bundle identifier.',
      'Failed to load provisioning paramter list due to error: ...',
    ].join('\n');
    expect(isSuccessfulLaunch(noisy)).toBe(true);
  });
});

describe('classifyDevicectlError', () => {
  beforeEach(() => {
    clearTrustProbeCache();
  });

  it('classifies untrusted developer certificate failures', () => {
    const samples = [
      'The application could not be launched because the Developer App Certificate is not trusted.',
      'Unable to launch dev.tapsmith.agent.xctrunner: untrusted developer',
      'Error: UntrustedDeveloper — please verify the developer in Settings',
      'The application could not be verified.',
      // Xcode 27.2 / iOS 27.2, for a runner whose profile is gone (PILOT-1204).
      'Unable to launch dev.tapsmith.agent.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.',
    ];
    for (const s of samples) {
      expect(classifyDevicectlError(s)).toBe('untrusted');
    }
  });

  it('classifies runner-not-installed failures', () => {
    const samples = [
      'Error: No such app on device: dev.tapsmith.agent.xctrunner',
      'Application not found',
      'Application bundle for com.example was not found',
    ];
    for (const s of samples) {
      expect(classifyDevicectlError(s)).toBe('runner-not-installed');
    }
  });

  it('falls back to unknown on ambiguous errors rather than lying', () => {
    const samples = [
      'Developer Mode disabled',
      'Device is locked. Unlock and retry.',
      'Some other devicectl error we have not seen before',
      '',
    ];
    for (const s of samples) {
      expect(classifyDevicectlError(s)).toBe('unknown');
    }
  });
});

describe('findRunnerApp', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-app-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the -Runner.app beside the xctestrun, not the host app', () => {
    const config = path.join(dir, 'Debug-iphoneos');
    fs.mkdirSync(path.join(config, 'TapsmithAgent.app'), { recursive: true });
    fs.mkdirSync(path.join(config, 'TapsmithAgentUITests-Runner.app'), { recursive: true });
    const xctestrun = path.join(dir, 'TapsmithAgentUITests_iphoneos27.2-arm64.xctestrun');
    fs.writeFileSync(xctestrun, '');
    expect(findRunnerApp(xctestrun)).toBe(path.join(config, 'TapsmithAgentUITests-Runner.app'));
  });

  it('ignores simulator slices and returns undefined without a runner app', () => {
    fs.mkdirSync(path.join(dir, 'Debug-iphonesimulator', 'TapsmithAgentUITests-Runner.app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Debug-iphoneos', 'TapsmithAgent.app'), { recursive: true });
    expect(findRunnerApp(path.join(dir, 'x.xctestrun'))).toBeUndefined();
    expect(findRunnerApp(path.join(dir, 'missing', 'x.xctestrun'))).toBeUndefined();
  });
});

describe('checkRunnerTrust', () => {
  const UDID = '00008140-000000000000001C';
  const STALE = 'Unable to launch dev.tapsmith.agent.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.';
  let dir: string;
  let xctestrun: string;
  let runnerApp: string;

  beforeEach(() => {
    clearTrustProbeCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-trust-'));
    runnerApp = path.join(dir, 'Debug-iphoneos', 'TapsmithAgentUITests-Runner.app');
    fs.mkdirSync(runnerApp, { recursive: true });
    xctestrun = path.join(dir, 'TapsmithAgentUITests_iphoneos27.2-arm64.xctestrun');
    fs.writeFileSync(xctestrun, '');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Ops whose probe answers from `states` in order, recording every call. */
  function fakeOps(states: TrustState[], opts: { installError?: Error, expiry?: ProfileExpiryInfo } = {}) {
    const calls: string[] = [];
    const ops: RunnerTrustOps = {
      async probe(udid) {
        calls.push(`probe ${udid}`);
        const state = states.shift() ?? 'unknown';
        return state === 'trusted' ? { state } : { state, raw: state === 'untrusted' ? STALE : state };
      },
      async uninstallRunner(udid) { calls.push(`uninstall ${udid}`); },
      async installApp(udid, app) {
        calls.push(`install ${udid} ${path.basename(app)}`);
        if (opts.installError) throw opts.installError;
      },
      profileExpiry(app) {
        calls.push(`expiry ${path.basename(app)}`);
        return opts.expiry;
      },
    };
    return { ops, calls };
  }

  const resolve = (p: () => string) => vi.fn(async () => p());

  it.each(['trusted', 'runner-not-installed', 'unknown'] as const)(
    'touches nothing else when the first probe says %s',
    async (state) => {
      const { ops, calls } = fakeOps([state]);
      const resolveXctestrun = resolve(() => xctestrun);
      const check = await checkRunnerTrust(UDID, resolveXctestrun, ops);
      expect(check).toEqual({ outcome: 'ok', state, replaced: false });
      expect(calls).toEqual([`probe ${UDID}`]);
      expect(resolveXctestrun).not.toHaveBeenCalled();
    },
  );

  it('replaces a stale runner with the local build, uninstalling first, and proceeds when it launches', async () => {
    const { ops, calls } = fakeOps(['untrusted', 'trusted']);
    const progress: string[] = [];
    const check = await checkRunnerTrust(UDID, resolve(() => xctestrun), ops, (m) => progress.push(m));
    expect(check).toEqual({ outcome: 'ok', state: 'trusted', replaced: true });
    expect(calls).toEqual([
      `probe ${UDID}`,
      'expiry TapsmithAgentUITests-Runner.app',
      `uninstall ${UDID}`,
      `install ${UDID} TapsmithAgentUITests-Runner.app`,
      `probe ${UDID}`,
    ]);
    expect(progress).toEqual([expect.stringContaining('reinstalling')]);
  });

  it('re-probes for real after the reinstall instead of answering from the session cache', async () => {
    // The default probe caches per device; the replacement must clear it.
    const calls: string[] = [];
    const ops: RunnerTrustOps = {
      ...fakeOps([]).ops,
      probe: vi.fn()
        .mockResolvedValueOnce({ state: 'untrusted', raw: STALE })
        .mockResolvedValueOnce({ state: 'trusted' }),
      async installApp() { calls.push('install'); },
    };
    const check = await checkRunnerTrust(UDID, resolve(() => xctestrun), ops);
    expect(ops.probe).toHaveBeenCalledTimes(2);
    expect(check.outcome).toBe('ok');
  });

  it('reports untrusted only when the freshly installed runner is refused too', async () => {
    const { ops } = fakeOps(['untrusted', 'untrusted']);
    const check = await checkRunnerTrust(UDID, resolve(() => xctestrun), ops);
    expect(check).toEqual({ outcome: 'untrusted', runnerApp, raw: STALE });
    const failure = describeRunnerTrustFailure(check)!;
    expect(failure.lines.join('\n')).toContain('VPN & Device Management');
    expect(failure.lines.join('\n')).toContain('just installed');
    // No "rebuild before trusting": the runner on the phone is the current build.
    expect(failure.lines.join('\n')).not.toContain('build-agent');
  });

  it('lets the run go on when the re-probe cannot tell (e.g. the device locked meanwhile)', async () => {
    const { ops } = fakeOps(['untrusted', 'unknown']);
    expect(await checkRunnerTrust(UDID, resolve(() => xctestrun), ops))
      .toEqual({ outcome: 'ok', state: 'unknown', replaced: true });
  });

  it('says to rebuild, without touching the device, when the local build profile has expired', async () => {
    const expiry = profileExpiryInfoAt(new Date('2026-11-01T00:00:00Z'), path.join(runnerApp, 'embedded.mobileprovision'), Date.parse('2026-11-16T00:00:00Z'));
    const { ops, calls } = fakeOps(['untrusted'], { expiry });
    const check = await checkRunnerTrust(UDID, resolve(() => xctestrun), ops);
    expect(check).toEqual({ outcome: 'profile-expired', runnerApp, expiry });
    expect(calls.some((c) => c.startsWith('uninstall') || c.startsWith('install'))).toBe(false);
    const text = describeRunnerTrustFailure(check)!.lines.join('\n');
    expect(text).toContain('2026-11-01');
    expect(text).toContain('tapsmith ios build-agent');
    expect(text).not.toContain('VPN & Device Management');
  });

  it('reports a failed install with its detail and a rebuild hint, not a trust hint', async () => {
    const { ops } = fakeOps(['untrusted'], {
      installError: new Error('devicectl install failed for Runner.app:\n  hint: The application could not be installed because its profile does not include this device.'),
    });
    const check = await checkRunnerTrust(UDID, resolve(() => xctestrun), ops);
    expect(check.outcome).toBe('install-failed');
    const text = describeRunnerTrustFailure(check)!.lines.join('\n');
    expect(text).toContain('does not include this device');
    expect(text).toContain('tapsmith ios build-agent');
    expect(text).not.toContain('VPN & Device Management');
  });

  it('says to rebuild when the local build has no runner app', async () => {
    fs.rmSync(runnerApp, { recursive: true });
    const { ops, calls } = fakeOps(['untrusted']);
    const check = await checkRunnerTrust(UDID, resolve(() => xctestrun), ops);
    expect(check).toEqual({ outcome: 'no-runner-app', xctestrunPath: xctestrun, raw: STALE });
    expect(calls).toEqual([`probe ${UDID}`]);
    expect(describeRunnerTrustFailure(check)!.lines.join('\n')).toContain('tapsmith ios build-agent');
  });

  it('propagates the missing-build error from the resolver', async () => {
    const { ops, calls } = fakeOps(['untrusted']);
    await expect(checkRunnerTrust(UDID, async () => { throw new Error('No device xctestrun found … Run `tapsmith ios build-agent` first'); }, ops))
      .rejects.toThrow('tapsmith ios build-agent');
    expect(calls).toEqual([`probe ${UDID}`]);
  });
});
