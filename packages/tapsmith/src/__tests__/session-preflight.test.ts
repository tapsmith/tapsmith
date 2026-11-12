import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { androidHierarchyHasRenderedContent, androidHierarchyHasText, collectAnsweredSystemDialogs, describeHierarchyForDiagnostics, ensureSessionReady, executeAppReset, launchConfiguredApp, probeResetCapabilities, startAndroidLaunchEarly } from '../session-preflight.js';
import type { AppResetPolicy } from '../app-reset.js';
import { onActionProgress, type ActionProgressEvent } from '../action-progress.js';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';
import { blockingDialogOwnersViaAdb } from '../emulator.js';

// The owner lookup shells out to adb; everything else in emulator.ts is pure.
vi.mock('../emulator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../emulator.js')>()),
  blockingDialogOwnersViaAdb: vi.fn(() => []),
}));

/** `uiautomator dump` of a real launcher ANR dialog (API 36 emulator). */
const LAUNCHER_ANR_FIXTURE = fs.readFileSync(
  new URL('./fixtures/android-launcher-anr.xml', import.meta.url), 'utf-8',
);

function makeContext(overrides: Partial<Parameters<typeof ensureSessionReady>[0]> = {}) {
  const device = {
    startAgent: vi.fn(async () => undefined),
    terminateApp: vi.fn(async () => undefined),
    launchApp: vi.fn(async () => undefined),
    openDeepLink: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    currentPackage: vi.fn(async () => 'com.example.app'),
    getByText: vi.fn(() => ({ tap: vi.fn(async () => undefined) }) as never),
    locator: vi.fn(() => {
      const handle = { tap: vi.fn(async () => undefined), first: vi.fn(() => handle) };
      return handle as never;
    }),
    pressBack: vi.fn(async () => undefined),
    clearAppData: vi.fn(async () => undefined),
    restoreAppState: vi.fn(async () => undefined),
    restartApp: vi.fn(async () => undefined),
    getAppState: vi.fn(async () => 'foreground' as const),
    _resetApp: vi.fn(async (_pkg: string, opts: { mode?: 'warm' | 'restart' | 'clear' }) => resetResult(opts.mode ?? 'warm')),
  };

  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
      errorMessage: '',
    })),
    // A daemon without the agent-side wait by default, so the dump-polling
    // tests below keep exercising that path; the PILOT-976 tests opt in.
    waitForAppReady: vi.fn(async () => ({ requestId: '1', ready: false, supported: false })),
    takeSystemDialogEvents: vi.fn(async (): Promise<import('../grpc-client.js').TakeSystemDialogEventsResponse> => ({ requestId: '1', events: [] })),
  };

  return {
    label: 'Worker 0 (emulator-5554)',
    notices: [] as import('../session-preflight.js').PreflightNotice[],
    relaunches: { count: 0 },
    config: { package: 'com.example.app', activity: '.MainActivity' },
    device,
    client,
    ...overrides,
  };
}

/** An iOS app that has drawn its first screen. */
const iosHierarchy = {
  requestId: '1',
  hierarchyXml: '<hierarchy><XCUIElementTypeApplication label="Example"><XCUIElementTypeStaticText label="Home" /></XCUIElementTypeApplication></hierarchy>',
  errorMessage: '',
};
/** A React Native app on iOS right after launch, before its bundle renders:
 *  the application, a window and empty containers (PILOT-1058). */
const iosShell = {
  requestId: '1',
  hierarchyXml: '<hierarchy><XCUIElementTypeApplication label="Example"><XCUIElementTypeWindow label=""><XCUIElementTypeOther label="" identifier="" /></XCUIElementTypeWindow></XCUIElementTypeApplication></hierarchy>',
  errorMessage: '',
};

/** A daemon ResetApp outcome as Device._resetApp reports it. */
function resetResult(
  mode: 'warm' | 'restart' | 'clear',
  overrides: Partial<import('../device.js').AppResetResult> = {},
): import('../device.js').AppResetResult {
  return {
    modeRequested: mode,
    modeUsed: mode,
    fellBack: false,
    coldLaunch: mode !== 'warm',
    durationMs: 120,
    hooksDetected: false,
    targetReached: false,
    steps: [{ name: mode === 'warm' ? 'warm-deep-link' : mode, durationMs: 120, ok: true }],
    ...overrides,
  };
}
const CLEAR_FILE: AppResetPolicy = { mode: 'clear', scope: 'file' };
const WARM_FILE: AppResetPolicy = { mode: 'warm', scope: 'file' };
const WARM_TEST: AppResetPolicy = { mode: 'warm', scope: 'test' };

describe('session-preflight', () => {
  it('accepts a healthy session', async () => {
    const ctx = makeContext();
    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();
    expect(ctx.client.ping).toHaveBeenCalledTimes(1);
    // A short settle, not a long one: this runs before every test, and on a
    // screen that never goes idle the Android agent waits the whole budget
    // (PILOT-509).
    expect(ctx.device.waitForIdle).toHaveBeenCalledWith(1_000);
  });

  it('emits sessionReady progress events around the readiness check (PILOT-232)', async () => {
    const events: ActionProgressEvent[] = [];
    const unsubscribe = onActionProgress((ev) => events.push(ev));
    try {
      await ensureSessionReady(makeContext(), 'startup');
      expect(events.map((e) => `${e.kind}:${e.action}`)).toEqual(['start:sessionReady', 'end:sessionReady']);
      expect(events[0].target).toBe('com.example.app');
      expect(events[1].success).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('restarts the session once when the agent is disconnected', async () => {
    const ctx = makeContext();
    const onRecovery = vi.fn();
    vi.mocked(ctx.client.ping)
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: false })
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });

    await expect(ensureSessionReady(ctx, 'startup', undefined, { onRecovery })).resolves.toBeUndefined();

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
  });

  it('continues when recovery itself hits a transient transport error', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.ping)
      .mockRejectedValueOnce(new Error('Agent connection dropped (empty response); reconnecting'))
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });
    vi.mocked(ctx.device.startAgent)
      .mockRejectedValueOnce(new Error('Failed to connect to agent socket'));

    await expect(ensureSessionReady(ctx, 'startup', 3, { retryBackoffMs: [0] })).resolves.toBeUndefined();

    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.client.ping).toHaveBeenCalledTimes(2);
  });

  it('recovers on the third attempt when a transient drop outlasts the first recovery (PILOT-282)', async () => {
    // A transient agent-connection drop lasts a few seconds: the first verify
    // AND the verify after the first recovery both land inside the drop
    // window. The default attempt budget must ride it out instead of failing
    // the test at 0ms while an interactive session recovers moments later.
    const ctx = makeContext();
    vi.mocked(ctx.client.ping)
      .mockRejectedValueOnce(new Error('Agent connection lost during read'))
      .mockRejectedValueOnce(new Error('Agent connection lost during read'))
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });

    await expect(
      ensureSessionReady(ctx, 'before test', undefined, { retryBackoffMs: [0] }),
    ).resolves.toBeUndefined();

    expect(ctx.client.ping).toHaveBeenCalledTimes(3);
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(2);
  });

  it('relaunches inline when another app is in the foreground — not a recovery', async () => {
    // A previous test may have intentionally terminated or backgrounded the
    // app, so a foreign foreground package must relaunch cheaply WITHOUT
    // signalling session recovery (recovery escalates to a whole-file retry).
    const ctx = makeContext();
    const onRecovery = vi.fn();
    vi.mocked(ctx.device.currentPackage).mockResolvedValue('com.other.app');
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.other.app" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '2',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'before test', undefined, { onRecovery })).resolves.toBeUndefined();

    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app');
    expect(onRecovery).not.toHaveBeenCalled();
    expect(ctx.device.startAgent).not.toHaveBeenCalled();
  });

  it('startup launch clears + launches and reports a `clear` prepared state', async () => {
    const ctx = makeContext();

    const prepared = await launchConfiguredApp(ctx, 'startup launch', { hooksProbeMs: 0 });

    expect(ctx.device.terminateApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
    expect(prepared).toMatchObject({ policy: { mode: 'clear', scope: 'file' }, source: 'startup launch' });
  });

  it('startup launch after a fresh install only launches (nothing to clear)', async () => {
    const ctx = makeContext();

    const prepared = await launchConfiguredApp(ctx, 'worker startup launch', { freshInstall: true, hooksProbeMs: 0 });

    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
    expect(prepared.policy).toEqual({ mode: 'clear', scope: 'file' });
  });

  describe('Android startup launch alongside the agent start', () => {
    it('clears before it returns, and launches without waiting for the launch', async () => {
      const ctx = makeContext();
      const order: string[] = [];
      vi.mocked(ctx.device.terminateApp).mockImplementation(async () => { order.push('terminate'); });
      vi.mocked(ctx.device.clearAppData).mockImplementation(async () => { order.push('clear'); });
      let finishLaunch!: () => void;
      vi.mocked(ctx.device.launchApp).mockImplementation(() => {
        order.push('launch');
        return new Promise<undefined>((resolve) => { finishLaunch = () => resolve(undefined); });
      });

      const early = await startAndroidLaunchEarly(ctx, { freshInstall: false });

      // The clear has finished (it must come before the agent starts), and
      // the launch is under way but not awaited.
      expect(order).toEqual(['terminate', 'clear', 'launch']);
      expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', { activity: '.MainActivity', waitForIdle: false });
      let settled = false;
      void early!.launched.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      finishLaunch();
      await expect(early!.launched).resolves.toBe(true);
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
    });

    it('only launches a freshly installed app (nothing to clear)', async () => {
      const ctx = makeContext();
      const early = await startAndroidLaunchEarly(ctx, { freshInstall: true });
      await expect(early!.launched).resolves.toBe(true);
      expect(ctx.device.terminateApp).not.toHaveBeenCalled();
      expect(ctx.device.clearAppData).not.toHaveBeenCalled();
      expect(ctx.device.launchApp).toHaveBeenCalledTimes(1);
    });

    it('a terminate that fails (app not running) still clears and launches', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.device.terminateApp).mockRejectedValueOnce(new Error('not running'));
      const early = await startAndroidLaunchEarly(ctx, { freshInstall: false });
      await expect(early!.launched).resolves.toBe(true);
      expect(ctx.device.clearAppData).toHaveBeenCalled();
    });

    it('a failed clear launches nothing, so the usual launch path runs it all after the agent', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.device.clearAppData).mockRejectedValueOnce(new Error('Failed to clear app data'));
      await expect(startAndroidLaunchEarly(ctx, { freshInstall: false })).resolves.toBeUndefined();
      expect(ctx.device.launchApp).not.toHaveBeenCalled();
    });

    it('a failed launch reports false instead of rejecting', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.device.launchApp).mockRejectedValueOnce(new Error('Failed to launch app'));
      const early = await startAndroidLaunchEarly(ctx, { freshInstall: false });
      await expect(early!.launched).resolves.toBe(false);
    });

    it('launchConfiguredApp with appLaunched skips the clear and launch but still waits and probes', async () => {
      const ctx = makeContext();
      const prepared = await launchConfiguredApp(ctx, 'startup launch', { appLaunched: true, hooksProbeMs: 0 });
      expect(ctx.device.terminateApp).not.toHaveBeenCalled();
      expect(ctx.device.clearAppData).not.toHaveBeenCalled();
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
      expect(ctx.device.launchApp).not.toHaveBeenCalled();
      expect(ctx.client.ping).toHaveBeenCalled();
      expect(ctx.client.getUiHierarchy).toHaveBeenCalled();
      expect(prepared).toMatchObject({ policy: { mode: 'clear', scope: 'file' }, source: 'startup launch' });

      const fresh = makeContext();
      await launchConfiguredApp(fresh, 'startup launch', { freshInstall: true, appLaunched: true, hooksProbeMs: 0 });
      expect(fresh.device.launchApp).not.toHaveBeenCalled();
    });
  });

  it('restore policy never clears app data (appState restore owns isolation)', async () => {
    // Regression: a scope that restores a non-empty appState must NOT pm-clear
    // first. On Android pm clear wipes the AndroidKeyStore keys that decrypt
    // saved credentials (device-bound, not in the archive), so the app would
    // come back signed out after the restore.
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { ...CLEAR_FILE, appState: '/abs/auth.tar.gz' }, { phase: 'file reset' });

    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.restoreAppState).toHaveBeenCalledWith('com.example.app', '/abs/auth.tar.gz');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'restore', fellBack: false });
    expect(report.steps.map((s) => s.name)).toEqual(['restoreAppState', 'restartApp', 'ensureSessionReady', 'waitForAppReady']);
  });

  it('appState "" means clear', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'file', appState: '' }, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
    expect(ctx.device.restoreAppState).not.toHaveBeenCalled();
    expect(report.modeUsed).toBe('clear');
  });
  it('restart policy asks the daemon for a restart and passes the policy inputs through', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: '.MainActivity', resetAppDeepLink: 'app:///__reset', appResetColdEvery: 4 },
    });

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'test' }, { phase: 'before test', forceCold: true });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', {
      mode: 'restart',
      fallback: true,
      resetDeepLink: 'app:///__reset',
      forceCold: true,
      coldEveryNResets: 4,
      skipTraceCapture: true,
      fallbackToClear: false,
    });
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'restart', fellBack: false });
    expect(report.steps.map((s) => s.name)).toEqual(['restart', 'resetApp', 'ensureSessionReady', 'waitForAppReady']);
  });

  it('defaults the cold valve to 10 resets', async () => {
    const ctx = makeContext();

    await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ coldEveryNResets: 10, forceCold: undefined }));
  });
  it('none policy only verifies the session', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { mode: 'none', scope: 'file' }, { phase: 'file reset' });

    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
    expect(ctx.client.ping).toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'skipped', modeUsed: 'none', reason: 'appReset: none' });
  });

  it('a prepared device that satisfies the policy skips the reset', async () => {
    const ctx = makeContext();
    const prepared = { policy: CLEAR_FILE, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' };

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'file' }, { phase: 'file reset', prepared });

    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.client.ping).toHaveBeenCalled();
    expect(report.origin).toBe('prepared');
    expect(report.reason).toMatch(/satisfied by startup launch at .* \(took 9\.8s\)/);
  });

  it('a prepared device that does not satisfy the policy is ignored', async () => {
    const ctx = makeContext();
    const prepared = { policy: { mode: 'restart' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 1, source: 'x' };

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset', prepared });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
    expect(report.origin).toBe('inline');
  });

  it('surfaces a daemon fallback in the report and on stderr', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', {
      modeUsed: 'restart',
      fellBack: true,
      coldLaunch: true,
      reason: 'warm reset requested but the app exposes no reset hook (@tapsmith/react-native or resetAppDeepLink); restarted instead',
      steps: [{ name: 'restart', durationMs: 90, ok: true }],
    }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(report).toMatchObject({ modeUsed: 'restart', fellBack: true });
      expect(report.reason).toMatch(/no reset hook/);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('App reset fell back to restart'));
    } finally {
      stderr.mockRestore();
    }
  });

  it('a warm policy asks the daemon to fall back to clear, not restart', async () => {
    // The declared policy's promise is state-clearing; a restart keeps
    // persisted data. Explicit device.resetApp() calls are unaffected — this
    // flag is set only on the runner's policy path.
    const ctx = makeContext();
    await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });
    expect(ctx.device._resetApp).toHaveBeenCalledWith(
      'com.example.app',
      expect.objectContaining({ mode: 'warm', fallbackToClear: true }),
    );

    await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });
    expect(ctx.device._resetApp).toHaveBeenLastCalledWith(
      'com.example.app',
      expect.objectContaining({ mode: 'clear', fallbackToClear: false }),
    );
  });
  it('propagates a daemon reset failure', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device._resetApp).mockRejectedValueOnce(new Error('App reset failed: RESET_FAILED'));

    await expect(executeAppReset(ctx, { mode: 'restart', scope: 'file' }, { phase: 'file reset' })).rejects.toThrow('RESET_FAILED');
  });
  it('still validates sessions without a configured package', async () => {
    const ctx = makeContext({
      config: { package: undefined, activity: undefined },
    });

    await expect(launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 })).resolves.toMatchObject({ policy: CLEAR_FILE });
    expect(ctx.device.launchApp).not.toHaveBeenCalled();

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });
    expect(report).toMatchObject({ origin: 'skipped', reason: 'no package configured' });
  });
  it('warm via the legacy deep link settles for resetAppWaitMs after the daemon returns', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
        resetAppWaitMs: 321,
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    const report = await executeAppReset(ctx, WARM_FILE, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'warm', resetDeepLink: 'example:///__reset' }));
    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 321);
    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'warm', fellBack: false });
    expect(report.steps.map((s) => s.name)).toEqual(['warm-deep-link', 'resetApp', 'settle', 'ensureSessionReady', 'waitForAppReady']);
  });

  describe('start route (appResetRoute, PILOT-1064)', () => {
    const HOOKED = '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=3;url=app:///" /></hierarchy>';
    const hooked = (overrides: Partial<Parameters<typeof makeContext>[0]> = {}) => {
      const ctx = makeContext(overrides);
      ctx.capabilities = { hooksDetected: true, hooksUrlPrefix: 'app:///' };
      return ctx;
    };
    const route = (policy: AppResetPolicy, r: string): AppResetPolicy => ({ ...policy, route: r });

    it('a warm hooks reset carries the route, and lands on it in one delivery', async () => {
      const ctx = hooked();
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, targetReached: true }));

      const report = await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test' });

      expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'warm', target: '/settings' }));
      expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
      expect(report.steps.map((s) => s.name)).not.toContain('openRoute');
    });

    describe('a warm reset that landed on the route, then had its app relaunched by the readiness check, opens the route again', () => {
      it('iOS: the app was no longer in the foreground', async () => {
        const ctx = hooked({ config: { package: 'com.example.app', platform: 'ios' } });
        vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, targetReached: true }));
        vi.mocked(ctx.device.getAppState).mockResolvedValueOnce('background' as never);
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({ requestId: '1', hierarchyXml: HOOKED, errorMessage: '' });
        vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

        const report = await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test' });

        expect(ctx.device.launchApp).toHaveBeenCalledTimes(1);
        // The relaunched app is a bare shell again: the route waits for it to
        // render (PILOT-1058), even though the warm reset itself needed no wait.
        expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
        const names = report.steps.map((st) => st.name);
        expect(names.indexOf('waitForAppReady')).toBeLessThan(names.indexOf('openRoute'));
      });

      it('Android: the app was gone from the screen', async () => {
        const ctx = hooked();
        vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, targetReached: true }));
        vi.mocked(ctx.device.currentPackage).mockResolvedValueOnce('com.android.launcher');
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce({
          requestId: '1', hierarchyXml: '<hierarchy><node package="com.android.launcher" text="Apps" /></hierarchy>', errorMessage: '',
        });

        const report = await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test' });

        expect(ctx.device.launchApp).toHaveBeenCalledTimes(1);
        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
        const names = report.steps.map((st) => st.name);
        expect(names.indexOf('waitForAppReady')).toBeLessThan(names.indexOf('openRoute'));
      });
    });

    it('a warm reset that fell back to clear opens the route afterwards', async () => {
      const ctx = hooked();
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', {
        modeUsed: 'clear', fellBack: true, coldLaunch: true, hooksDetected: true, targetReached: false,
      }));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const report = await executeAppReset(ctx, route(WARM_TEST, '/settings?tab=2'), { phase: 'before test' });

        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings?tab=2');
        expect(report.steps.at(-1)).toMatchObject({ name: 'openRoute', ok: true, detail: 'app:///settings?tab=2' });
      } finally {
        stderr.mockRestore();
      }
    });

    it('a warm reset the daemon could only confirm on "/" opens the route afterwards', async () => {
      const ctx = hooked();
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, targetReached: false }));

      await executeAppReset(ctx, route(WARM_TEST, '/modal'), { phase: 'before test' });

      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///modal');
    });

    it('clear, restart and restore policies open the route once the app is ready', async () => {
      for (const policy of [CLEAR_FILE, { mode: 'restart' as const, scope: 'test' as const }, { ...CLEAR_FILE, appState: '/abs/auth.tar.gz' }]) {
        const ctx = hooked();
        const report = await executeAppReset(ctx, route(policy, '/profile'), { phase: 'file reset' });

        expect(vi.mocked(ctx.device._resetApp).mock.calls.every(([, o]) => !('target' in o))).toBe(true);
        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///profile');
        const names = report.steps.map((s) => s.name);
        expect(names.indexOf('openRoute')).toBeGreaterThan(names.indexOf('ensureSessionReady'));
      }
    });

    it('a prepared device at another route is navigated, not reset again', async () => {
      const ctx = hooked();
      const prepared = { policy: WARM_FILE, preparedAt: Date.now(), durationMs: 1_000, source: 'the file-entry reset' };

      const report = await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test', prepared });

      expect(report.origin).toBe('prepared');
      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
    });

    it('a prepared device already at the route needs nothing', async () => {
      const ctx = hooked();
      const prepared = { policy: route(WARM_FILE, '/settings'), preparedAt: Date.now(), durationMs: 1_000, source: 'the entry reset' };

      await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test', prepared });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    });

    describe('a prepared device the readiness check relaunched opens the route again', () => {
      // The app stopped before adoption: it is on its launch screen now,
      // whatever route the preparation left it on.
      const prepared = () => ({ policy: route(WARM_FILE, '/settings'), preparedAt: Date.now(), durationMs: 1_000, source: 'the entry reset' });

      it('iOS: the app was no longer in the foreground', async () => {
        const ctx = hooked({ config: { package: 'com.example.app', platform: 'ios' } });
        vi.mocked(ctx.device.getAppState).mockResolvedValueOnce('notRunning' as never);
        vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

        await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test', prepared: prepared() });

        expect(ctx.device.launchApp).toHaveBeenCalledTimes(1);
        expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
        expect(ctx.device._resetApp).not.toHaveBeenCalled();
        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
      });

      it('counts the relaunch on the session, for checks made outside the reset', async () => {
        const ctx = hooked({ config: { package: 'com.example.app', platform: 'ios' } });
        vi.mocked(ctx.device.getAppState).mockResolvedValueOnce('notRunning' as never);

        await ensureSessionReady(ctx, 'before test');
        expect(ctx.relaunches.count).toBe(1);
        await ensureSessionReady(ctx, 'before test');
        expect(ctx.relaunches.count).toBe(1);
      });

      it('Android: the app was gone from the screen', async () => {
        const ctx = hooked();
        vi.mocked(ctx.device.currentPackage).mockResolvedValueOnce('com.android.launcher');
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce({
          requestId: '1', hierarchyXml: '<hierarchy><node package="com.android.launcher" text="Apps" /></hierarchy>', errorMessage: '',
        });

        await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test', prepared: prepared() });

        expect(ctx.device.launchApp).toHaveBeenCalledTimes(1);
        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
      });

      it('a recovered session', async () => {
        const ctx = hooked();
        vi.mocked(ctx.client.ping).mockResolvedValueOnce({ version: '0.1.0', agentConnected: false });

        await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test', prepared: prepared() });

        expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
      });
    });

    it('appReset none does not navigate (no reset ran to land anywhere)', async () => {
      const ctx = hooked();
      const prepared = { policy: CLEAR_FILE, preparedAt: Date.now(), durationMs: 1, source: 'startup launch' };

      await executeAppReset(ctx, route({ mode: 'none', scope: 'file' }, '/settings'), { phase: 'file reset' });
      await executeAppReset(ctx, route({ mode: 'none', scope: 'file' }, '/settings'), { phase: 'file reset', prepared });

      expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    });

    it('a full deep link under the hooks prefix is sent warm as a path', async () => {
      const ctx = hooked();
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, targetReached: true }));

      await executeAppReset(ctx, route(WARM_TEST, 'app:///settings'), { phase: 'before test' });

      expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ target: '/settings' }));
      expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    });

    it('a full deep link outside the hooks prefix resets to "/" and opens the link', async () => {
      const ctx = hooked();
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, targetReached: true }));

      await executeAppReset(ctx, route(WARM_TEST, 'https://example.com/promo'), { phase: 'before test' });

      expect(vi.mocked(ctx.device._resetApp).mock.calls[0][1]).not.toHaveProperty('target');
      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('https://example.com/promo');
    });

    it('an app without hooks opens a full deep link after its clear reset', async () => {
      const ctx = makeContext();
      ctx.capabilities = { hooksDetected: false };

      await executeAppReset(ctx, route(CLEAR_FILE, 'app:///settings'), { phase: 'file reset' });

      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
    });

    it('a path learns the prefix from the marker when the session has not recorded it', async () => {
      const ctx = makeContext();
      ctx.capabilities = { hooksDetected: true };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({ requestId: '1', hierarchyXml: HOOKED, errorMessage: '' });

      await executeAppReset(ctx, route(CLEAR_FILE, '/settings'), { phase: 'file reset' });

      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
      expect(ctx.capabilities.hooksUrlPrefix).toBe('app:///');
    });

    // E2E iOS (PR #521): a session whose startup probe missed the marker under
    // load records hooksDetected=false. That is "never seen", not proof of no
    // hooks, so a path still looks for the marker for the whole budget.
    it('a path keeps looking for the marker when the session never saw it, and upgrades detection', async () => {
      const ctx = makeContext();
      ctx.capabilities = { hooksDetected: false };
      const prepared = { policy: WARM_FILE, preparedAt: Date.now(), durationMs: 1_000, source: 'the file-entry reset' };
      const missed = { requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>', errorMessage: '' };
      // The marker shows up only after a moment (mid-transition, a slow dump).
      const showsAt = Date.now() + 400;
      vi.mocked(ctx.client.getUiHierarchy).mockImplementation(async () => (
        Date.now() < showsAt ? missed : { requestId: '2', hierarchyXml: HOOKED, errorMessage: '' }
      ));

      await executeAppReset(ctx, route(WARM_TEST, '/settings'), { phase: 'before test', prepared });

      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
      expect(ctx.capabilities).toMatchObject({ hooksDetected: true, hooksUrlPrefix: 'app:///' });
    });

    it('a route that cannot be opened fails naming appResetRoute', async () => {
      const ctx = hooked();
      vi.mocked(ctx.device.openDeepLink).mockRejectedValueOnce(new Error('openDeepLink: navigation was not acknowledged'));

      const err = await executeAppReset(ctx, route(CLEAR_FILE, '/no-such-route'), { phase: 'file reset' }).catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/^Could not open appResetRoute '\/no-such-route' \(app:\/\/\/no-such-route\): openDeepLink: navigation was not acknowledged/);
    });

    it('a path on an app without hooks fails, naming the full-link form', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: '.MainActivity', appReset: 'clear' } });
      ctx.capabilities = { hooksDetected: false };

      const err = await executeAppReset(ctx, route(CLEAR_FILE, '/settings'), { phase: 'file reset', hooksProbeMs: 0 }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/appResetRoute '\/settings' is a path/);
      expect((err as Error).message).toMatch(/myapp:\/\/\/settings/);
      expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    });
  });

  describe('keeping a restored appState between tests', () => {
    const ARCHIVE = '/abs/auth.tar.gz';
    const RESTORE_WARM: AppResetPolicy = { mode: 'warm', scope: 'test', appState: ARCHIVE };

    /** A hooked app whose marker reports `boot` and `writes` (undefined = no write support). */
    function hookedApp(initial: { boot: string; writes?: number }) {
      const app = { ...initial };
      const ctx = makeContext({ capabilities: { hooksDetected: true, hooksUrlPrefix: 'app:///' } });
      vi.mocked(ctx.client.getUiHierarchy).mockImplementation(async () => ({
        requestId: '1',
        hierarchyXml: `<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;nav=0;boot=${app.boot};url=app:///${app.writes === undefined ? '' : `;writes=${app.writes}`}" /></hierarchy>`,
        errorMessage: '',
      }));
      // A restore relaunches the app: a new process with its own boot token,
      // and a write count that starts again from zero.
      let launches = 0;
      vi.mocked(ctx.device.restartApp).mockImplementation(async () => {
        launches += 1;
        app.boot = `relaunch${launches}`;
        if (app.writes !== undefined) app.writes = 0;
      });
      vi.mocked(ctx.device._resetApp).mockImplementation(async () => resetResult('warm', { hooksDetected: true }));
      return { ctx, app };
    }

    it('restores cold the first time, says why, and records the write count it left', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 4 });

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device.restoreAppState).toHaveBeenCalledWith('com.example.app', ARCHIVE);
      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(report).toMatchObject({ modeUsed: 'restore', fellBack: false });
      expect(report.reason).toMatch(/^warm skipped: first restore of auth\.tar\.gz/);
      expect(ctx.capabilities?.appStateBaseline).toEqual({ archive: ARCHIVE, boot: 'relaunch1', writes: 0 });
    });

    it('resets warm, keeping the data, while the app has written nothing since the restore', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      vi.mocked(ctx.device.restoreAppState).mockClear();
      vi.mocked(ctx.device.restartApp).mockClear();

      const report = await executeAppReset(ctx, { ...RESTORE_WARM, route: '/profile' }, { phase: 'before test' });

      expect(ctx.device.restoreAppState).not.toHaveBeenCalled();
      expect(ctx.device.restartApp).not.toHaveBeenCalled();
      expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({
        mode: 'warm', keepAppData: true, fallback: false, recoverable: true, target: '/profile',
      }));
      // The legacy link cannot keep data.
      expect(vi.mocked(ctx.device._resetApp).mock.calls[0][1]).not.toHaveProperty('resetDeepLink');
      expect(report).toMatchObject({ origin: 'inline', modeUsed: 'warm', fellBack: false });
      expect(report.reason).toBe('kept auth.tar.gz: no persisted writes since the restore');
      expect(ctx.capabilities?.appStateBaseline).toEqual({ archive: ARCHIVE, boot: 'relaunch1', writes: 0 });
    });

    it('restores cold again after a test wrote persisted data, and names the drift', async () => {
      const { ctx, app } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      app.writes = 2;

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(ctx.device.restoreAppState).toHaveBeenCalledTimes(2);
      expect(report.modeUsed).toBe('restore');
      expect(report.reason).toBe('warm skipped: the app wrote persisted data since the restore (2 writes)');
      expect(ctx.capabilities?.appStateBaseline).toEqual({ archive: ARCHIVE, boot: 'relaunch2', writes: 0 });
    });

    it('restores cold when the app relaunched since the restore', async () => {
      const { ctx, app } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      app.boot = 'crashed-and-relaunched';

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(report.reason).toMatch(/^warm skipped: the app relaunched since the restore/);
    });

    it('restores cold every time for an app that does not report writes, and says how to fix it', async () => {
      const { ctx } = hookedApp({ boot: 'b0' });
      const first = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      const second = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(ctx.capabilities?.appStateBaseline).toBeUndefined();
      for (const report of [first, second]) {
        expect(report.reason).toBe('warm skipped: the app does not report persisted writes (pass onReload and track to <TapsmithTestHooks>)');
        // No second read after the restore: the relaunched build reports no writes either.
        expect(report.steps.filter((s) => s.name === 'readWriteCount')).toHaveLength(1);
      }
    });

    it('re-reads the marker every time, so a first read without a count does not stick', async () => {
      // The first read after a restore can land before the hooks publish
      // their count; the next reset reads again and records it.
      const { ctx, app } = hookedApp({ boot: 'b0' });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      app.writes = 0;

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(report.reason).toMatch(/^warm skipped: first restore/);
      expect(ctx.capabilities?.appStateBaseline).toEqual({ archive: ARCHIVE, boot: 'relaunch2', writes: 0 });
    });

    it('restores cold on a forced-cold reset (retry, fresh start after a failure)', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test', forceCold: true });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(report.reason).toBe('warm skipped: a retry restores the archive cold');
    });

    it('restores a different archive cold', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      const report = await executeAppReset(ctx, { ...RESTORE_WARM, appState: '/abs/admin.tar.gz' }, { phase: 'before test' });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(ctx.device.restoreAppState).toHaveBeenLastCalledWith('com.example.app', '/abs/admin.tar.gz');
      expect(report.reason).toMatch(/^warm skipped: first restore of admin\.tar\.gz/);
    });

    it('never tries warm under a cold policy, and reads no write count for it', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      ctx.capabilities = { hooksDetected: true, hooksUrlPrefix: 'app:///', appStateBaseline: { archive: ARCHIVE, boot: 'b0', writes: 0 } };

      const report = await executeAppReset(ctx, { ...RESTORE_WARM, mode: 'restart' }, { phase: 'before test' });

      expect(ctx.device._resetApp).not.toHaveBeenCalled();
      expect(report.modeUsed).toBe('restore');
      expect(report.reason).toBe("warm skipped: appReset is 'restart'");
    });

    it('says nothing extra for an app without hooks (nothing was skipped)', async () => {
      const ctx = makeContext({ capabilities: { hooksDetected: false } });

      const report = await executeAppReset(ctx, { mode: 'clear', scope: 'test', appState: ARCHIVE }, { phase: 'before test' });

      expect(report.reason).toBeUndefined();
    });

    it('restores the archive when the warm reset fails, and reports the fallback', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      vi.mocked(ctx.device._resetApp).mockRejectedValueOnce(new Error('in-app reset reported an error: no onReload'));

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device.restoreAppState).toHaveBeenCalledTimes(2);
      expect(report).toMatchObject({ modeUsed: 'restore', fellBack: true });
      expect(report.reason).toMatch(/^warm reset keeping auth\.tar\.gz failed \(.*no onReload\); restored it cold/);
      expect(report.steps.find((s) => s.name === 'resetApp')?.ok).toBe(false);
      // The fallback is a cold restore like any other: the next one can keep.
      expect(ctx.capabilities?.appStateBaseline).toEqual({ archive: ARCHIVE, boot: 'relaunch2', writes: 0 });
    });

    it('restores cold when the app wrote during the warm reset (a save it had scheduled)', async () => {
      const { ctx, app } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      vi.mocked(ctx.device._resetApp).mockImplementationOnce(async () => {
        app.writes = 1;
        return resetResult('warm', { hooksDetected: true });
      });

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device.restoreAppState).toHaveBeenCalledTimes(2);
      expect(report).toMatchObject({ modeUsed: 'restore', fellBack: true });
      expect(report.reason).toBe('the app wrote persisted data during the warm reset (1 write); restored auth.tar.gz cold');
      expect(ctx.capabilities?.appStateBaseline).toEqual({ archive: ARCHIVE, boot: 'relaunch2', writes: 0 });
    });

    it('restores the archive when the daemon cleared the app after all', async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('clear', { modeRequested: 'warm', fellBack: true, reason: 'boom' }));

      const report = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(ctx.device.restoreAppState).toHaveBeenCalledTimes(2);
      expect(report).toMatchObject({ modeUsed: 'restore', fellBack: true });
    });

    it('keeps the data through a cold-delivered warm reset, then restores cold next time and says why', async () => {
      const { ctx, app } = hookedApp({ boot: 'b0', writes: 0 });
      await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      vi.mocked(ctx.device._resetApp).mockImplementationOnce(async () => {
        app.boot = 'valve';
        return resetResult('warm', { hooksDetected: true, coldLaunch: true });
      });

      const kept = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });
      const next = await executeAppReset(ctx, RESTORE_WARM, { phase: 'before test' });

      expect(kept.modeUsed).toBe('warm');
      expect(ctx.device.restoreAppState).toHaveBeenCalledTimes(2);
      // A new process may have written at launch, after the counted writes.
      expect(next.reason).toBe('warm skipped: the app relaunched since the restore');
    });

    it("explains that appState '' clears even with hooks", async () => {
      const { ctx } = hookedApp({ boot: 'b0', writes: 0 });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('clear'));

      const report = await executeAppReset(ctx, { mode: 'warm', scope: 'test', appState: '' }, { phase: 'before test' });

      expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
      expect(report.reason).toBe("warm skipped: appState '' clears the app's data");
    });
  });

  describe('Android app readiness after a cold launch', () => {
    const splash = { requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" class="android.widget.FrameLayout" text="" content-desc="" /></hierarchy>', errorMessage: '' };
    const rendered = { requestId: '2', hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>', errorMessage: '' };

    it('androidHierarchyHasRenderedContent needs text or a content description from the app itself', () => {
      expect(androidHierarchyHasRenderedContent(splash.hierarchyXml, 'com.example.app')).toBe(false);
      expect(androidHierarchyHasRenderedContent(rendered.hierarchyXml, 'com.example.app')).toBe(true);
      expect(androidHierarchyHasRenderedContent('<hierarchy><node package="com.example.app" content-desc="Menu" /></hierarchy>', 'com.example.app')).toBe(true);
      // System UI text does not count: the app has not drawn anything yet.
      expect(androidHierarchyHasRenderedContent('<hierarchy><node package="com.android.systemui" text="10:06" /><node package="com.example.app" /></hierarchy>', 'com.example.app')).toBe(false);
    });

    it('androidHierarchyHasText matches an exact node text, XML-escaped', () => {
      expect(androidHierarchyHasText('<node text="Wait" />', 'Wait')).toBe(true);
      // Substring matches must not count — "Waiting" is not the "Wait" button.
      expect(androidHierarchyHasText('<node text="Waiting" />', 'Wait')).toBe(false);
      // UIAutomator escapes the apostrophe in dialog copy; the label lookup has
      // to speak the same dialect or it silently never matches.
      expect(androidHierarchyHasText('<node text="Google Play services isn&apos;t responding" />', 'Wait')).toBe(false);
      expect(androidHierarchyHasText('<node text="Say &quot;hi&quot;" />', 'Say "hi"')).toBe(true);
    });

    it('describeHierarchyForDiagnostics names the real cause behind a readiness timeout', () => {
      // Three very different failures that used to share one error sentence.
      expect(describeHierarchyForDiagnostics('')).toContain('UIAutomator2 returned nothing');
      expect(describeHierarchyForDiagnostics('<?xml version="1.0"?>\n<hierarchy rotation="0" />'))
        .toContain('has not drawn yet');

      const anr = '<node text="Google Play services isn&apos;t responding" resource-id="android:id/alertTitle" package="android" />';
      const described = describeHierarchyForDiagnostics(anr);
      expect(described).toContain('Google Play services isn&apos;t responding');
      expect(described).toContain('android');

      // Attribute order is not guaranteed across API levels.
      expect(describeHierarchyForDiagnostics(
        '<node resource-id="android:id/alertTitle" text="App keeps stopping" package="android" />',
      )).toContain('App keeps stopping');

      // No dialog: just say which packages held the screen.
      expect(describeHierarchyForDiagnostics('<node package="com.android.launcher3" text="Home" />'))
        .toBe('showed packages: com.android.launcher3');
    });

    it('a clear reset polls until the app has rendered content (regression: deep link lost into a booting RN app)', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      // ensureSessionReady's own fetch sees the window; the readiness wait then
      // sees the splash twice before the JS bundle renders.
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(rendered);

      const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(report.steps.map((s) => s.name)).toEqual(['clear', 'resetApp', 'ensureSessionReady', 'waitForAppReady']);
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(4);
    });

    it('an acknowledged warm reset does not poll for content (the epoch proves rendering)', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 3, epochAfter: 4 }));

      const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(report.steps.map((s) => s.name)).not.toContain('waitForAppReady');
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(1);
    });

    it('a warm reset the daemon delivered cold waits like a relaunch', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, coldLaunch: true }));

      const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(report.steps.map((s) => s.name)).toContain('waitForAppReady');
    });

    describe('agent-side readiness (PILOT-976)', () => {
      it('a clear reset asks the daemon once instead of polling dumps', async () => {
        const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
        vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

        const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

        expect(report.steps.map((s) => s.name)).toContain('waitForAppReady');
        expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
        expect(ctx.client.waitForAppReady).toHaveBeenCalledWith('com.example.app', 10_000, expect.any(Number));
        // ensureSessionReady's own read only: no dump polling for content.
        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(1);
      });

      it('an app that never shows text is let through with the breadcrumb, without dump polling', async () => {
        const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
        vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: false, supported: true });
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });
          expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('showed no rendered content');
        } finally {
          stderr.mockRestore();
        }
        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(1);
      });

      it('a clear keeps its own wait even on a daemon known to wait for rendering', async () => {
        const ctx = {
          ...makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } }),
          capabilities: { daemonWaitsForRender: true } as import('../app-reset.js').ResetCapabilities,
        };
        vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

        const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

        expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
        expect(report.steps.map((s) => s.name)).toContain('waitForAppReady');
      });

      it('a daemon that predates the RPC gets the dump polling', async () => {
        const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
        vi.mocked(ctx.client.waitForAppReady).mockRejectedValue(Object.assign(new Error('12 UNIMPLEMENTED: unknown method'), { code: 12 }));
        vi.mocked(ctx.client.getUiHierarchy)
          .mockResolvedValueOnce(splash)
          .mockResolvedValueOnce(splash)
          .mockResolvedValueOnce(rendered);

        await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
      });

      it('a failed wait falls back to dump polling for what is left of the budget', async () => {
        const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
        vi.mocked(ctx.client.waitForAppReady).mockRejectedValue(new Error('14 UNAVAILABLE: connection dropped'));
        vi.mocked(ctx.client.getUiHierarchy)
          .mockResolvedValueOnce(splash)
          .mockResolvedValueOnce(rendered);

        await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
      });

    });


    it('startup launch waits for rendered content before probing for hooks', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      const marker = { requestId: '3', hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;boot=abc;url=app:///" /></hierarchy>', errorMessage: '' };
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(marker)
        .mockResolvedValue(marker);

      await launchConfiguredApp(ctx, 'startup', { freshInstall: true, hooksProbeMs: 0 });

      expect((ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities?.hooksDetected).toBe(true);
    });
  });

  describe('iOS rendered-content readiness (PILOT-1058)', () => {
    const iosCtx = () => makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'ios' } });

    it('an acknowledged warm reset keeps only the hierarchy check: the epoch proves rendering', async () => {
      const ctx = iosCtx();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosShell);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 3, epochAfter: 4 }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(ctx.client.waitForAppReady).not.toHaveBeenCalled();
    });

    it('a warm reset the daemon delivered cold waits for rendered content like a relaunch', async () => {
      const ctx = iosCtx();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, coldLaunch: true }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
    });

    it('a clear reset asks the daemon to wait for rendered content', async () => {
      const ctx = iosCtx();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosShell);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

      const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(report.steps.map((s) => s.name)).toContain('waitForAppReady');
      expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
      expect(ctx.client.waitForAppReady).toHaveBeenCalledWith('com.example.app', 10_000, expect.any(Number));
    });

    it('records that the daemon waits for rendering once it answers the RPC', async () => {
      const ctx = iosCtx();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect((ctx as { capabilities?: { daemonWaitsForRender?: boolean } }).capabilities?.daemonWaitsForRender).toBe(true);
    });

    it('a clear on a daemon known to wait for rendering skips the repeat wait, keeping the hierarchy check', async () => {
      const ctx = {
        ...iosCtx(),
        capabilities: { daemonWaitsForRender: true } as import('../app-reset.js').ResetCapabilities,
      };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

      const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.client.waitForAppReady).not.toHaveBeenCalled();
      expect(report.steps.map((s) => s.name)).toContain('waitForAppReady');
    });

    it('a clear on a daemon known to wait still waits when the readiness check relaunched the app after it', async () => {
      // The daemon's wait came before that relaunch, so the app is a bare
      // shell again; the start route (PILOT-1064) is opened only after it renders.
      const ctx = {
        ...iosCtx(),
        capabilities: { hooksDetected: true, hooksUrlPrefix: 'app:///', daemonWaitsForRender: true } as import('../app-reset.js').ResetCapabilities,
      };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);
      vi.mocked(ctx.device.getAppState).mockResolvedValueOnce('notRunning' as never);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

      const report = await executeAppReset(ctx, { ...CLEAR_FILE, route: '/settings' }, { phase: 'file reset' });

      expect(ctx.device.launchApp).toHaveBeenCalledTimes(1);
      expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
      expect(ctx.device.openDeepLink).toHaveBeenCalledExactlyOnceWith('app:///settings');
      const names = report.steps.map((st) => st.name);
      expect(names.indexOf('waitForAppReady')).toBeLessThan(names.indexOf('openRoute'));
    });

    it('a warm reset delivered cold still waits on a daemon known to wait: only its relaunch rungs do', async () => {
      const ctx = {
        ...iosCtx(),
        capabilities: { hooksDetected: true, daemonWaitsForRender: true } as import('../app-reset.js').ResetCapabilities,
      };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, coldLaunch: true }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
    });

    it('without the daemon wait, polls past the empty React Native shell until the app renders', async () => {
      const ctx = iosCtx();
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValue(iosHierarchy);

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      // Every shell read is spent waiting; the first rendered read ends the wait.
      const reads = vi.mocked(ctx.client.getUiHierarchy).mock.calls.length;
      expect(reads).toBeGreaterThanOrEqual(4);
    });

    it('an app that never draws content is let through after the bound, with the breadcrumb', async () => {
      const ctx = iosCtx();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosShell);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: false, supported: true });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' })).resolves.toBeDefined();
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('showed no rendered content');
      } finally {
        stderr.mockRestore();
      }
    });

    it('an empty hierarchy is still not ready: the content wait runs only once the app is up', async () => {
      const ctx = iosCtx();
      const empty = { requestId: '1', hierarchyXml: '', errorMessage: 'Unable to lookup in current state' };
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(empty)
        .mockResolvedValue(iosHierarchy);
      vi.mocked(ctx.client.waitForAppReady).mockResolvedValue({ requestId: '1', ready: true, supported: true });

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.client.waitForAppReady).toHaveBeenCalledTimes(1);
    });

    it('a hooked session stuck on clear upgrades to warm once the relaunched app has rendered (regression)', async () => {
      const ctx = {
        ...iosCtx(),
        capabilities: { hooksDetected: false } as import('../app-reset.js').ResetCapabilities,
      };
      const markerScreen = {
        requestId: '1',
        hierarchyXml: '<hierarchy><XCUIElementTypeApplication label="Example"><XCUIElementTypeStaticText label="Home" />'
          + '<XCUIElementTypeOther label="tapsmith-hooks:1;epoch=0;nav=0;boot=abc;url=app:///" /></XCUIElementTypeApplication></hierarchy>',
        errorMessage: '',
      };
      // The relaunched app is the bare shell for the first reads, then renders.
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValueOnce(iosShell)
        .mockResolvedValue(markerScreen);

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.capabilities.hooksDetected).toBe(true);
    });
  });

  it('warm via in-app hooks needs no settle wait (the epoch is the ack)', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'android' },
    });
    vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 3, epochAfter: 4 }));

    const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

    expect(report.steps.map((s) => s.name)).not.toContain('settle');
    // ensureSessionReady's own idle wait is the only one.
    expect(ctx.device.waitForIdle).toHaveBeenCalledTimes(1);
  });
  it('dismisses system overlay via pressBack when app is underneath', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device.currentPackage).mockResolvedValue('com.google.android.apps.nexuslauncher');
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<node package="com.example.app" /><node package="com.google.android.apps.nexuslauncher" />',
      errorMessage: '',
    });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();
    expect(ctx.device.pressBack).toHaveBeenCalled();
    expect(ctx.device.startAgent).not.toHaveBeenCalled();
  });

  it('escalates to recovery when the inline relaunch itself fails', async () => {
    const ctx = makeContext();
    const onRecovery = vi.fn();
    vi.mocked(ctx.device.currentPackage)
      .mockResolvedValueOnce('com.google.android.apps.nexuslauncher')
      .mockResolvedValue('com.example.app');
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.google.android.apps.nexuslauncher" /></hierarchy>',
      errorMessage: '',
    });
    // First launch attempt (the inline relaunch) fails — a genuinely broken
    // session; the second (recoverSession's) succeeds.
    vi.mocked(ctx.device.launchApp)
      .mockRejectedValueOnce(new Error('launch failed: agent dead'))
      .mockResolvedValue(undefined);

    await expect(
      ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] }),
    ).resolves.toBeUndefined();

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
  });

  it('waits for the Android app hierarchy after a cold launch splash', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.android.systemui" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '2',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();

    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
  });

  it('dismisses Android notification shade overlays before waiting for the app hierarchy', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.android.systemui" resource-id="com.android.systemui:id/notification_panel" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '2',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();

    expect(ctx.device.pressBack).toHaveBeenCalledTimes(1);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
  });

  describe('iOS foreground probe tolerates a slow agent (PILOT-350)', () => {
    const deadline = () => new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 12.001s,remote_addr=127.0.0.1:50051');

    function iosContext() {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
      });
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);
      return ctx;
    }

    /**
     * Drive the probe on a clock that simulates each attempt burning its own
     * deadline (plus `lagMs`) WITHOUT sleeping for it, while still advancing
     * with real time so the probe's own `delay()` pacing is charged to the
     * budget exactly as it is in production.
     *
     * Simulating the deadline keeps attempt counts exact — they do not depend
     * on how late a real `setTimeout` fires on a loaded runner — and tracking
     * real time keeps the retry delay a live part of the budget arithmetic, so
     * a test on the shipped constants fails if the delay grows past its slack.
     */
    function withFakeClock(ctx: ReturnType<typeof iosContext>, lagMs = 0) {
      const origin = performance.now();
      const base = 1_000_000;
      let simulated = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(
        () => base + (performance.now() - origin) + simulated,
      );
      vi.mocked(ctx.device.getAppState).mockImplementation(
        async (_pkg: string, opts?: { timeout?: number }) => {
          simulated += (opts?.timeout ?? 0) + lagMs;
          throw deadline();
        },
      );
      return spy;
    }

    it('re-probes after a missed deadline instead of recovering the session', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('foreground');

      await expect(
        ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0], iosForegroundProbe: { retryDelayMs: 0 } }),
      ).resolves.toBeUndefined();

      expect(ctx.device.getAppState).toHaveBeenCalledTimes(2);
      // The whole point: no agent restart + relaunch for a slow-but-alive agent.
      expect(onRecovery).not.toHaveBeenCalled();
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
      expect(ctx.device.launchApp).not.toHaveBeenCalled();
    });

    it('relaunches a displaced app found by the retry, same as a first-try answer', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('background');

      await expect(ensureSessionReady(ctx, 'before test', undefined, { iosForegroundProbe: { retryDelayMs: 0 } })).resolves.toBeUndefined();

      expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app');
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
    });

    it('a daemon-side agent timeout is retried too, not treated as a dead session', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(new Error('Agent command timed out after 30s'))
        .mockResolvedValueOnce('foreground');

      await expect(
        ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0], iosForegroundProbe: { retryDelayMs: 0 } }),
      ).resolves.toBeUndefined();

      expect(onRecovery).not.toHaveBeenCalled();
    });

    it('a transport failure still recovers immediately — no budget spent on a dead socket', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(new Error('Agent connection dropped (empty response); reconnecting'))
        .mockResolvedValue('foreground');

      await expect(
        ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] }),
      ).resolves.toBeUndefined();

      // One attempt before the session was declared broken (not a budget's worth),
      // then recovery, then the post-recovery verification's own probe.
      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
      expect(ctx.device.getAppState).toHaveBeenCalledTimes(2);
    });

    it('a rung after a completed recovery gets one deadline, not another full budget', async () => {
      const ctx = iosContext();
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 2, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 900, attemptDeadlineMs: 200, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/session preflight failed during before test/);
      } finally {
        clock.mockRestore();
      }

      // Rung 1 spends the 900ms budget (4 probes); rung 2 follows a recovery
      // that restarted the agent, so it gets a single deadline (1 probe).
      // Unclamped this is a second full budget — the ~90s-per-preflight
      // regression the clamp exists to prevent.
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBe(5);
    });

    it('a rung whose recovery THREW keeps the full budget — nothing was restarted', async () => {
      const ctx = iosContext();
      // Recovery fails, so the agent was never restarted: clamping rung 2 here
      // would hand a merely-slow agent the single-shot behaviour PILOT-350
      // removes, one rung further down the ladder.
      vi.mocked(ctx.device.startAgent).mockRejectedValue(new Error('Failed to connect to agent socket'));
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 3, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 900, attemptDeadlineMs: 200, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/session preflight failed during before test/);
      } finally {
        clock.mockRestore();
      }

      // Two rungs, each spending a full 4-probe budget.
      expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBe(8);
    });

    it('an agent that never answers within the budget still escalates to recovery', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());

      await expect(
        ensureSessionReady(ctx, 'before test', 2, {
          onRecovery,
          retryBackoffMs: [0],
          iosForegroundProbe: { budgetMs: 0 },
        }),
      ).rejects.toThrow(/session preflight failed during before test/);

      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    });

    it('narrows the per-attempt deadline to what is left of the budget', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockResolvedValue('foreground');

      await ensureSessionReady(ctx, 'before test', undefined, {
        iosForegroundProbe: { budgetMs: 400, attemptDeadlineMs: 12_000 },
      });

      const [, options] = vi.mocked(ctx.device.getAppState).mock.calls[0];
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(400);
    });

    it('caps each attempt at the per-attempt deadline, not the whole budget', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('foreground');

      await ensureSessionReady(ctx, 'before test', undefined, {
        iosForegroundProbe: { budgetMs: 1_000, attemptDeadlineMs: 100, retryDelayMs: 20 },
      });

      // Both attempts are capped at the per-attempt deadline. Without the cap
      // the probe collapses into a single wide-deadline call and stops
      // refreshing the daemon-side agent stream.
      const timeouts = vi.mocked(ctx.device.getAppState).mock.calls.map(([, o]) => o?.timeout);
      expect(timeouts).toHaveLength(2);
      for (const t of timeouts) expect(t).toBeLessThanOrEqual(100);
    });

    it('paces its retries — a fast-rejecting timeout does not become a hot spin', async () => {
      const ctx = iosContext();
      // Rejects instantly every time. Unpaced, the loop re-enters as fast as the
      // event loop allows and issues tens of thousands of RPCs (and stderr
      // lines) inside one budget.
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());
      const onRecovery = vi.fn();

      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          onRecovery,
          iosForegroundProbe: { budgetMs: 1_200, attemptDeadlineMs: 200, retryDelayMs: 50 },
        }),
      ).rejects.toThrow(/session preflight failed during before test/);

      // Paced, the attempt count is bounded by budget / retryDelay (~24 here).
      // Unpaced it is ~10^5 — the loop re-enters as fast as the event loop
      // allows, each iteration issuing an RPC and writing a stderr line.
      const attempts = vi.mocked(ctx.device.getAppState).mock.calls.length;
      expect(attempts).toBeGreaterThan(1);
      expect(attempts).toBeLessThan(40);
      expect(onRecovery).not.toHaveBeenCalled();
    });

    it('reports the budget it gave up on, not just the last attempt deadline', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());

      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 600, attemptDeadlineMs: 200, retryDelayMs: 20 },
        }),
      ).rejects.toThrow(/iOS foreground probe gave up after .*attempts?, 0\.2s deadline each, 0\.6s budget/);

      // Assert the ACTUAL classifier, not a looser substring: the file-retry
      // loops in cli.ts / worker-runner.ts / ui-worker.ts key off this, and
      // `RECOVERABLE_INFRASTRUCTURE_PATTERNS` wants the '4 ' status prefix, so
      // a regex on the bare code would pass while classification broke.
      const err = await ensureSessionReady(ctx, 'before test', 1, {
        iosForegroundProbe: { budgetMs: 600, attemptDeadlineMs: 200, retryDelayMs: 20 },
      }).catch((e: unknown) => e);
      expect(isRecoverableInfrastructureError(err)).toBe(true);
    });

    it('names the deadline an attempt actually used, not the unclamped constant', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());

      // Budget below the per-attempt deadline: the one attempt's deadline is
      // clamped to the budget, so the give-up line must not quote 12.0s.
      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 300, attemptDeadlineMs: 12_000, retryDelayMs: 0 },
        }),
      ).rejects.toThrow(/0\.3s deadline each, 0\.3s budget/);
    });

    it('does not annotate a failed recovery with the probe latency', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());
      vi.mocked(ctx.device.startAgent).mockRejectedValue(new Error('Failed to connect to agent socket'));

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 3, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 0, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/Failed to connect to agent socket/);
      } finally {
        unsubscribe();
      }

      // The reported error came from recoverSession, not the probe; the end
      // event must not read as though the probe produced it.
      const end = events.find((e) => e.kind === 'end');
      expect(end?.detail).toBeUndefined();
    });

    it('a failed relaunch is not reported as a probe failure', async () => {
      const ctx = iosContext();
      // The probe ANSWERS (app displaced), then the relaunch throws. Neither
      // the breadcrumb nor the progress annotation may point at the probe.
      vi.mocked(ctx.device.getAppState).mockResolvedValue('background');
      vi.mocked(ctx.device.launchApp).mockRejectedValue(new Error('Launch app failed: LAUNCH_FAILED'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      let written = '';
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, { iosForegroundProbe: { retryDelayMs: 0 } }),
        ).rejects.toThrow(/LAUNCH_FAILED/);
        written = stderr.mock.calls.map(([c]) => String(c)).join('');
      } finally {
        unsubscribe();
        stderr.mockRestore();
      }

      expect(written).toMatch(/relaunch failed/);
      expect(written).not.toMatch(/foreground probe failed/);
      const end = events.find((e) => e.kind === 'end');
      expect(end?.detail).toBeUndefined();
    });

    it('a rung whose predecessor never spent a probe budget keeps the full budget', async () => {
      const ctx = iosContext();
      // Rung 1 dies at ping, so no probe ran. Rung 2 runs right after
      // recoverSession's terminate + launch — when getAppState is slowest — and
      // must not be cut to a single deadline.
      vi.mocked(ctx.client.ping)
        .mockResolvedValueOnce({ version: '0.1.0', agentConnected: false })
        .mockResolvedValue({ version: '0.1.0', agentConnected: true });
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 2, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 900, attemptDeadlineMs: 200, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/session preflight failed during before test/);
      } finally {
        clock.mockRestore();
      }

      // Rung 2 spends a full 4-probe budget; clamped it would be 1.
      expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBe(4);
    });

    it('reports cumulative probe time once the ladder has probed more than once', async () => {
      const ctx = iosContext();
      // Rung 1 burns its budget, recovery succeeds, rung 2 answers instantly.
      // The annotation must not read as though only 0.0s went on probing.
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValue('foreground');

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await ensureSessionReady(ctx, 'before test', 2, {
          retryBackoffMs: [0],
          iosForegroundProbe: { budgetMs: 0, retryDelayMs: 0 },
        });
      } finally {
        unsubscribe();
      }

      const end = events.find((e) => e.kind === 'end');
      expect(end?.success).toBe(true);
      expect(end?.detail).toMatch(/across 2 probes/);
    });

    it('prints a breadcrumb naming the relaunch when the relaunch is what failed', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockResolvedValue('background');
      vi.mocked(ctx.device.launchApp).mockRejectedValue(new Error('Launch app failed: LAUNCH_FAILED'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let written = '';
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, { iosForegroundProbe: { retryDelayMs: 0 } }),
        ).rejects.toThrow(/LAUNCH_FAILED/);
        written = stderr.mock.calls.map(([c]) => String(c)).join('');
      } finally {
        stderr.mockRestore();
      }

      expect(written).toMatch(/relaunch failed/);
      expect(written).not.toMatch(/foreground probe failed/);
    });

    it('the shipped budget admits a second attempt even when the rejection lands seconds late', async () => {
      // Drives the REAL constants: the budget must leave room for a full second
      // attempt after the first deadline plus event-loop lag, or the probe
      // silently degrades to the single-shot behaviour PILOT-350 removed.
      const ctx = iosContext();
      // The deadline fires, then 3s of lag before the rejection lands.
      const nowSpy = withFakeClock(ctx, 3_000);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, {}),
        ).rejects.toThrow(/iOS foreground probe gave up/);

        expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('never starts a sliver attempt that cannot run to a full deadline', async () => {
      const ctx = iosContext();
      // Each attempt burns its whole deadline, so the budget leaves a 40ms
      // remainder after two attempts. That remainder must not become a third
      // attempt whose sub-deadline error masks the real timeout.
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, {
            iosForegroundProbe: { budgetMs: 240, attemptDeadlineMs: 100, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/DEADLINE_EXCEEDED/);
      } finally {
        clock.mockRestore();
      }

      const timeouts = vi.mocked(ctx.device.getAppState).mock.calls.map(([, o]) => o?.timeout);
      expect(timeouts).toEqual([100, 100]);
    });

    it('a transport failure AFTER a slow attempt reports the socket error, not the budget', async () => {
      const ctx = iosContext();
      // The mixed sequence takes the same early break as a first-attempt
      // transport failure but with attempts > 1; it must still surface the
      // socket error rather than the "gave up after ... budget" wrapper, or
      // triage is pointed at the deadline constant.
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockRejectedValue(new Error('Agent connection dropped (empty response); reconnecting'));

      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 5_000, attemptDeadlineMs: 100, retryDelayMs: 0 },
        }),
      ).rejects.toThrow(/Agent connection dropped/);
      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 5_000, attemptDeadlineMs: 100, retryDelayMs: 0 },
        }),
      ).rejects.not.toThrow(/gave up after/);
    });

    it('does not annotate a transport failure with a probe latency', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValue(new Error('Agent connection dropped (empty response); reconnecting'));

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await expect(ensureSessionReady(ctx, 'before test', 1, {})).rejects.toThrow();
      } finally {
        unsubscribe();
      }

      // A dropped socket is not probe latency; `— foreground probe 0.3s` on
      // that line points triage at the deadline constant.
      const end = events.find((e) => e.kind === 'end');
      expect(end?.success).toBe(false);
      expect(end?.detail).toBeUndefined();
    });

    it('reports the probe latency on the App ready progress event', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('foreground');

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await ensureSessionReady(ctx, 'before test', undefined, { iosForegroundProbe: { retryDelayMs: 0 } });
      } finally {
        unsubscribe();
      }

      const end = events.find((e) => e.kind === 'end');
      expect(end?.detail).toMatch(/^foreground probe \d+\.\ds after 2 attempts$/);
    });

    it('does not attribute an earlier attempt\'s probe to a later attempt that never probed', async () => {
      const ctx = iosContext();
      // Attempt 1 probes and exhausts its budget; attempt 2 dies at ping, before
      // the probe runs. The end event must not carry attempt 1's annotation.
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());
      vi.mocked(ctx.client.ping)
        .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true })
        .mockRejectedValue(new Error('Agent connection dropped (empty response); reconnecting'));

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 2, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 0 },
          }),
        ).rejects.toThrow();
      } finally {
        unsubscribe();
      }

      const end = events.find((e) => e.kind === 'end');
      expect(end?.success).toBe(false);
      expect(end?.detail).toBeUndefined();
    });
  });

  it('iOS clear policy runs the daemon ladder then the readiness waits', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    // iOS verifySession polls hierarchy instead of waitForIdle
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(report.steps.map((s) => s.name)).toEqual(['clear', 'resetApp', 'ensureSessionReady', 'waitForAppReady']);
  });
  it('startup/recovery launch never uses the warm hook', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    await launchConfiguredApp(ctx, 'recovery', { hooksProbeMs: 0 });

    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
  });
  it('iOS launchConfiguredApp polls hierarchy until non-empty', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '', errorMessage: '' })
      .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '  ', errorMessage: '' })
      .mockResolvedValue(iosHierarchy);

    await launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 });

    // 3 hierarchy calls (2 empty + 1 non-empty), one rendered-content read
    // (this daemon has no agent-side wait), and the reset-capabilities probe
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(5);
  });
  describe('blocking system dialogs (PILOT-398)', () => {
    const PKG = 'com.example.app';
    const LAUNCHER = 'com.google.android.apps.nexuslauncher';
    const hierarchy = (xml: string) => ({ requestId: '1', hierarchyXml: xml, errorMessage: '' });
    /** What the agent sees on a cold, overloaded emulator: the app's window
     *  under a real "Pixel Launcher isn't responding" dialog. */
    const launcherAnr = hierarchy(
      `<hierarchy><node package="${PKG}" text="Home" />${LAUNCHER_ANR_FIXTURE.replace(/^<\?xml[^>]*>\s*<hierarchy[^>]*>|<\/hierarchy>\s*$/g, '')}</hierarchy>`,
    );
    const home = hierarchy(`<hierarchy><node package="${PKG}" text="Home" /></hierarchy>`);
    const BUTTON_IDS: Record<string, string> = { 'android:id/aerr_close': 'Close app', 'android:id/aerr_wait': 'Wait' };
    /** Every dismissal tap in call order: `id:<label>` when tapped by the
     *  dialog button's resource id, `<label>` when by its text. */
    const tapped = (ctx: ReturnType<typeof makeContext>) => {
      const byText = vi.mocked(ctx.device.getByText).mock;
      const byId = vi.mocked(ctx.device.locator).mock;
      return [
        ...byText.calls.map(([label], i) => [byText.invocationCallOrder[i], label] as const),
        ...byId.calls.map(([opts], i) => [byId.invocationCallOrder[i], `id:${BUTTON_IDS[opts.id ?? ''] ?? opts.id}`] as const),
      ].sort((a, b) => a[0] - b[0]).map(([, label]) => label);
    };
    /** Dumps that alternate between `a` and `b`, forever. */
    const alternating = (a: ReturnType<typeof hierarchy>, b: ReturnType<typeof hierarchy>) => {
      let n = 0;
      return async () => (n++ % 2 === 0 ? a : b);
    };

    function withOwner(...owners: string[]) {
      vi.mocked(blockingDialogOwnersViaAdb).mockReturnValue(owners);
      return makeContext({ deviceSerial: 'emulator-5554' });
    }

    afterEach(() => {
      vi.mocked(blockingDialogOwnersViaAdb).mockReset();
      vi.mocked(blockingDialogOwnersViaAdb).mockReturnValue([]);
    });

    it('closes another package\'s ANR and carries on — no relaunch, no recovery round', async () => {
      const ctx = withOwner(LAUNCHER);
      const onRecovery = vi.fn();
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(launcherAnr)
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { onRecovery, retryBackoffMs: [0] })).resolves.toBeUndefined();

      // "Wait" leaves a hung launcher hung: it re-ANRs within seconds of the
      // relaunch (reproduced on an API 36 emulator). "Close app" kills it and
      // the system restarts it clean.
      expect(tapped(ctx)).toEqual(['id:Close app']);
      // The app under test was running underneath. A launch with the
      // configured activity is `am start -S`: it would drop beforeAll state
      // without the recovery signal the before-test hooks retry the file on.
      expect(ctx.device.launchApp).not.toHaveBeenCalled();
      expect(onRecovery).not.toHaveBeenCalled();
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
      // Left for the runner: a trace row only, no warning on the test.
      expect(ctx.notices).toEqual([expect.objectContaining({
        kind: 'foreign-dialog', title: 'Pixel Launcher isn\'t responding', owner: LAUNCHER,
      })]);
    });

    it('hands a dialog whose owner cannot be read to the normal recovery, reporting it', async () => {
      // It may be the app under test's own: nothing inline may kill it or
      // wait it out as a stranger's. Recovery clears it and reports the
      // relaunch, so a before-test preflight retries the file.
      const ctx = withOwner();
      const onRecovery = vi.fn();
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(launcherAnr) // verify
        .mockResolvedValueOnce(launcherAnr) // recovery's dismissal read
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(String(onRecovery.mock.calls[0][0])).toContain('its owner could not be read: "Pixel Launcher isn\'t responding"');
      // It may have been the app's own, and recovery relaunched the app.
      expect(ctx.notices).toEqual([expect.objectContaining({ kind: 'app-dialog', title: 'Pixel Launcher isn\'t responding' })]);
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
      expect(ctx.device.locator).not.toHaveBeenCalled();
    });

    it('does the same for an unattributed crash dialog, which offers only "Close app"', async () => {
      const ctx = withOwner();
      const onRecovery = vi.fn();
      const crash = hierarchy(
        `<hierarchy><node package="android" resource-id="android:id/alertTitle" text="Example keeps stopping" />`
        + '<node package="android" resource-id="android:id/aerr_close" text="Close app" /></hierarchy>',
      );
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(crash).mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(ctx.device.launchApp).toHaveBeenCalledWith(PKG, { activity: '.MainActivity', waitForIdle: false });
    });

    it('taps "Wait", never "Close app", on system_server\'s own ANR', async () => {
      // Killing system_server restarts the runtime: agent, app and all.
      const ctx = withOwner('system');
      const systemAnr = hierarchy(launcherAnr.hierarchyXml.replace('Pixel Launcher isn\'t responding', 'Process system isn\'t responding'));
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(systemAnr).mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual(['id:Wait']);
    });

    it('handles a dialog that appears while waiting for the app to draw', async () => {
      // The field failure: the ANR showed up after the launch, inside
      // waitForAndroidAppHierarchy, which used to throw on first sight.
      const ctx = withOwner(LAUNCHER);
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(hierarchy('<hierarchy><node package="com.android.systemui" /></hierarchy>'))
        .mockResolvedValueOnce(launcherAnr)
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual(['id:Close app']);
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
    });

    it('keeps dismissing when clearing one dialog reveals another', async () => {
      const ctx = withOwner(LAUNCHER);
      const dialog = (text: string, button: string) =>
        hierarchy(`<node package="android" text="${text} isn&apos;t responding" /><node package="android" text="${button}" />`);
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(dialog('Google Play services', 'Wait'))
        .mockResolvedValueOnce(dialog('Pixel Launcher', 'Close app')) // GMS gone, launcher revealed
        .mockResolvedValueOnce(dialog('Pixel Launcher', 'Close app'))
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      // Only labels the dump actually shows are tapped: a blind tap costs a
      // full auto-wait timeout per absent label.
      expect(tapped(ctx)).toEqual(['Wait', 'Close app']);
    });

    it('fails with a readable message once the dialog keeps coming back', async () => {
      const ctx = withOwner(LAUNCHER);
      const onRecovery = vi.fn();
      // Each dismissal clears it; each relaunch brings it back.
      vi.mocked(ctx.client.getUiHierarchy).mockImplementation(alternating(launcherAnr, home));

      const err = await ensureSessionReady(ctx, 'worker startup launch', undefined, { onRecovery, retryBackoffMs: [0] })
        .then(() => undefined, (e: unknown) => e as Error);

      expect(err?.message).toContain(
        'session preflight failed during worker startup launch: A system dialog is blocking the device: '
        + '"Pixel Launcher isn\'t responding" (com.google.android.apps.nexuslauncher). '
        + 'Tapsmith dismissed it 4 times and it kept coming back.',
      );
      expect(err?.message).toContain('overloaded');
      // PILOT-399: never the raw dump.
      expect(err?.message).not.toContain('<');
      expect(tapped(ctx)).toHaveLength(4);
      // Recovery rounds (agent restart + relaunch, ~15 s each) cannot clear a
      // dialog the inline dismissals could not.
      expect(onRecovery).not.toHaveBeenCalled();
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
    });

    const appAnr = hierarchy(
      `<hierarchy><node package="${PKG}" text="Home" /><node resource-id="android:id/alertTitle" text="Example isn&apos;t responding" package="android" />`
      + '<node resource-id="android:id/aerr_close" text="Close app" package="android" /><node resource-id="android:id/aerr_wait" text="Wait" package="android" /></hierarchy>',
    );

    it('closes the app under test\'s own ANR and recovers, reporting it so the file retries', async () => {
      // A before-test preflight retries the file (beforeAll runs again) only
      // when a recovery is reported; an app hang is exactly such a case.
      const ctx = withOwner(PKG);
      const onRecovery = vi.fn();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(appAnr).mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual(['id:Close app']);
      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(String(onRecovery.mock.calls[0][0])).toContain(
        'The app under test is showing a system dialog: "Example isn\'t responding" (com.example.app)',
      );
      // recoverSession relaunched it.
      expect(ctx.device.launchApp).toHaveBeenCalledWith(PKG, { activity: '.MainActivity', waitForIdle: false });
      // Left for the runner to put on the test result and in the trace.
      expect(ctx.notices).toEqual([expect.objectContaining({
        kind: 'app-dialog',
        message: 'The app under test (com.example.app) showed "Example isn\'t responding"; Tapsmith dismissed it.',
      })]);
    });

    it('fails naming the app\'s own dialog when it keeps coming back', async () => {
      const ctx = withOwner(PKG);
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(appAnr);

      const err = await ensureSessionReady(ctx, 'startup launch', undefined, { retryBackoffMs: [0] })
        .then(() => undefined, (e: unknown) => e as Error);

      expect(err?.message).toContain(
        'session preflight failed during startup launch: The app under test is showing a system dialog: "Example isn\'t responding" (com.example.app)',
      );
    });

    it('surfaces the app\'s own dialog from the launch wait instead of polling out the deadline', async () => {
      const ctx = withOwner(PKG);
      const onRecovery = vi.fn();
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(hierarchy('<hierarchy><node package="com.android.systemui" /></hierarchy>'))
        .mockResolvedValueOnce(appAnr)
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { onRecovery, retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(onRecovery).toHaveBeenCalledTimes(1);
    });

    it('closes the app\'s own dialog without "Close app" while system_server\'s ANR is also listed', async () => {
      const ctx = withOwner('system', PKG);
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(appAnr).mockResolvedValue(home);

      await ensureSessionReady(ctx, 'before test', undefined, { retryBackoffMs: [0] });

      expect(tapped(ctx)[0]).toBe('id:Wait');
    });

    it('treats the dialog as the app\'s own when the app owns any of several dialog windows', async () => {
      // dumpsys lists every error window; which one the title belongs to is unknowable.
      const ctx = withOwner(LAUNCHER, PKG);
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(appAnr);

      const err = await ensureSessionReady(ctx, 'startup launch', undefined, { retryBackoffMs: [0] })
        .then(() => undefined, (e: unknown) => e as Error);

      expect(err?.message).toContain('The app under test is showing a system dialog');
    });

    it('ignores the phrase in the app\'s own UI when no system dialog is up', async () => {
      const ctx = withOwner();
      const appText = hierarchy(`<hierarchy><node package="${PKG}" text="The server isn&apos;t responding" /><node package="${PKG}" text="OK" /></hierarchy>`);
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(appText);

      await expect(ensureSessionReady(ctx, 'before test', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual([]);
      expect(ctx.device.pressBack).not.toHaveBeenCalled();
      expect(ctx.device.launchApp).not.toHaveBeenCalled();
    });

    it('taps the dialog\'s own button, not a same-labelled control of the app underneath', async () => {
      const ctx = withOwner('system');
      const underneath = hierarchy(launcherAnr.hierarchyXml.replace(
        '<hierarchy>', `<hierarchy><node package="${PKG}" text="Not Now" /><node package="${PKG}" text="Wait" />`,
      ));
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(underneath).mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      // "Not Now" is only the app's; "Wait" is tapped by the dialog button's id.
      expect(tapped(ctx)).toEqual(['id:Wait']);
    });

    it('says several dialogs kept appearing when the dismissals were of different dialogs', async () => {
      const ctx = withOwner(LAUNCHER);
      const dialog = (text: string) => hierarchy(
        `<node package="android" resource-id="android:id/alertTitle" text="${text} isn&apos;t responding" /><node package="android" text="Close app" />`,
      );
      vi.mocked(ctx.client.getUiHierarchy)
        // Each one's gone-check already shows the next.
        .mockResolvedValueOnce(dialog('Google Play services'))
        .mockResolvedValueOnce(dialog('Pixel Launcher'))
        .mockResolvedValueOnce(dialog('Pixel Launcher'))
        .mockResolvedValueOnce(dialog('System UI'))
        .mockResolvedValueOnce(dialog('System UI'))
        .mockResolvedValueOnce(dialog('Google Play services'))
        .mockResolvedValueOnce(dialog('Google Play services'))
        .mockResolvedValue(dialog('Maps'));

      const err = await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })
        .then(() => undefined, (e: unknown) => e as Error);

      expect(err?.message).toContain('"Maps isn\'t responding"');
      expect(err?.message).toContain('Tapsmith dismissed 4 system dialogs in a row and they kept appearing.');
    });

    it('taps stacked ANR dialogs\' shared button id with first()', async () => {
      const ctx = withOwner(LAUNCHER);
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(launcherAnr).mockResolvedValue(home);

      await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] });

      expect(ctx.device.locator).toHaveBeenCalledWith({ id: 'android:id/aerr_close' });
      const handle = vi.mocked(ctx.device.locator).mock.results[0].value as { first: ReturnType<typeof vi.fn> };
      expect(handle.first).toHaveBeenCalled();
    });

    it('presses BACK instead of tapping a label the app underneath also shows', async () => {
      // An app "OK" under a system dialog's "OK" makes a text tap ambiguous:
      // a strict-mode error would be swallowed and nothing dismissed.
      const ctx = withOwner(LAUNCHER);
      const okDialog = (appOk: boolean) => hierarchy(
        `<hierarchy>${appOk ? `<node package="${PKG}" text="OK" />` : ''}`
        + '<node package="android" resource-id="android:id/alertTitle" text="Maps keeps stopping" /><node package="android" text="OK" /></hierarchy>',
      );
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(okDialog(true)).mockResolvedValue(home);
      await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] });
      expect(tapped(ctx)).toEqual([]);
      expect(ctx.device.pressBack).toHaveBeenCalledTimes(1);

      const alone = withOwner(LAUNCHER);
      vi.mocked(alone.client.getUiHierarchy).mockResolvedValueOnce(okDialog(false)).mockResolvedValue(home);
      await ensureSessionReady(alone, 'startup', undefined, { retryBackoffMs: [0] });
      expect(tapped(alone)).toEqual(['OK']);
    });

    it('taps the ANR button by id when its text differs from the English label', async () => {
      const ctx = withOwner(LAUNCHER);
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(hierarchy(launcherAnr.hierarchyXml.replace('text="Close app"', 'text="App schließen"')))
        .mockResolvedValue(home);

      await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] });

      expect(tapped(ctx)).toEqual(['id:Close app']);
      expect(ctx.device.pressBack).not.toHaveBeenCalled();
    });

    it('never taps "Close app" on system_server\'s ANR, even when "Wait" is missing from the dump', async () => {
      const ctx = withOwner('system');
      const noWait = hierarchy(
        '<hierarchy><node package="android" resource-id="android:id/alertTitle" text="Process system isn&apos;t responding" />'
        + '<node package="android" resource-id="android:id/aerr_close" text="Close app" /></hierarchy>',
      );
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(noWait).mockResolvedValue(home);

      await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] });

      expect(tapped(ctx)).toEqual([]);
      expect(ctx.device.pressBack).toHaveBeenCalledTimes(1);
    });

    it('does not take an empty or failed read after a tap as the dialog having left', async () => {
      const ctx = withOwner(LAUNCHER);
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(launcherAnr)
        .mockResolvedValueOnce(hierarchy('')) // agent could not read the screen
        .mockRejectedValueOnce(new Error('Agent command timed out'))
        .mockResolvedValueOnce(launcherAnr) // still leaving
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual(['id:Close app']);
    });

    it('waits for a dismissed dialog to leave instead of counting it again', async () => {
      // On an overloaded emulator the dialog can linger past the tap; a
      // re-read must not count that as the dialog coming back.
      const ctx = withOwner(LAUNCHER);
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(launcherAnr)
        .mockResolvedValueOnce(launcherAnr) // still leaving
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual(['id:Close app']);
    });

    it('names no owner when several foreign dialog windows are listed, but still closes', async () => {
      const ctx = withOwner(LAUNCHER, 'com.google.android.gms');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(launcherAnr).mockResolvedValue(home);
        await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] });
        const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(written).toContain('Dismissing system dialog "Pixel Launcher isn\'t responding" (1/4)');
      } finally {
        stderr.mockRestore();
      }
      expect(tapped(ctx)).toEqual(['id:Close app']);
    });

    it('ignores app text even while dumpsys lists an error window', async () => {
      const ctx = withOwner(LAUNCHER);
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(
        hierarchy(`<hierarchy><node package="${PKG}" text="The server isn&apos;t responding" /></hierarchy>`),
      );

      await expect(ensureSessionReady(ctx, 'before test', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      expect(tapped(ctx)).toEqual([]);
      expect(ctx.device.pressBack).not.toHaveBeenCalled();
    });

    it('still dismisses a dialog found during a recovery round, tapping only labels it shows', async () => {
      // recoverSession runs for non-dialog failures (here a disconnected
      // agent) and clears whatever dialog is up before restarting the agent.
      const ctx = makeContext();
      vi.mocked(ctx.client.ping)
        .mockResolvedValueOnce({ version: '0.1.0', agentConnected: false })
        .mockResolvedValue({ version: '0.1.0', agentConnected: true });
      const anr = hierarchy('<node text="Google Play services isn&apos;t responding" /><node text="Wait" /><node text="Close app" />');
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(anr)
        .mockResolvedValue(home);

      await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();

      // A blind tap costs a full auto-wait timeout per absent label; "Wait"
      // wins over "Close app" there, and "Not Now"/"OK" are never tried.
      expect(vi.mocked(ctx.device.getByText).mock.calls.map(([label]) => label)).toEqual(['Wait']);
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    });

    it('logs the raw hierarchy only under TAPSMITH_DEBUG', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        for (const debug of [undefined, '1']) {
          stderr.mockClear();
          vi.stubEnv('TAPSMITH_DEBUG', debug);
          const ctx = withOwner(LAUNCHER);
          vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(launcherAnr).mockResolvedValue(home);
          await ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] });
          const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
          expect(written).toContain('Dismissing system dialog "Pixel Launcher isn\'t responding"');
          expect(written.includes('android:id/alertTitle')).toBe(debug === '1');
        }
      } finally {
        vi.unstubAllEnvs();
        stderr.mockRestore();
      }
    });
  });

  describe('reset capabilities', () => {
    it('detects the in-app hooks marker after a launch and records it on the context', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=app:///" /></hierarchy>',
        errorMessage: '',
      });

      await launchConfiguredApp(ctx, 'startup launch', { freshInstall: true, hooksProbeMs: 0 });

      expect(ctx.capabilities).toEqual({ hooksDetected: true, hooksUrlPrefix: 'app:///' });
    });

    it('a marker without a URL prefix does not count as usable hooks', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=" /></hierarchy>',
        errorMessage: '',
      });
      expect(await probeResetCapabilities(ctx, { pollMs: 0 })).toEqual({ hooksDetected: false });
    });

    it('a startup probe whose dumps all came back as errors still lets the next clear reset upgrade (PILOT-774)', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android' },
      });
      ctx.capabilities = {};
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({ requestId: '1', hierarchyXml: '', errorMessage: 'Interrupting test' });
      await probeResetCapabilities(ctx, { pollMs: 0 });
      expect(ctx.capabilities).toEqual({ hooksDetected: false });

      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
        errorMessage: '',
      });
      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.capabilities.hooksDetected).toBe(true);
    });

    it('a clear reset under appReset auto re-reads the marker so a missed startup probe upgrades', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android' },
      });
      ctx.capabilities = { hooksDetected: false };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
        errorMessage: '',
      });

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.capabilities.hooksDetected).toBe(true);
    });

    describe('warning when @tapsmith/react-native is installed but its hooks never show up (PILOT-774)', () => {
      const NO_MARKER = '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>';
      const MARKER = '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>';
      const PROBE = { phase: 'file reset', hooksProbeMs: 0 };
      let tmp: string;

      function appDir(deps: Record<string, string>, devDeps: Record<string, string> = {}, dir = tmp): string {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: deps, devDependencies: devDeps }));
        return dir;
      }
      function hookedContext(rootDir: string | undefined, xml = NO_MARKER, extra: Record<string, unknown> = {}) {
        const ctx = makeContext({
          config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android', rootDir, ...extra },
        });
        ctx.capabilities = { hooksDetected: false };
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({ requestId: '1', hierarchyXml: xml, errorMessage: '' });
        return ctx;
      }
      // The runner passes a fresh spread of the session context to every reset.
      const reset = (ctx: ReturnType<typeof hookedContext>, opts = PROBE) => executeAppReset({ ...ctx }, CLEAR_FILE, opts);
      const hooksNotices = (ctx: ReturnType<typeof hookedContext>) => ctx.notices.filter((n) => n.kind === 'hooks-missing');
      // Hierarchy reads a clear reset makes up to and including its single
      // re-read, counted on an app without the dependency (no check follows).
      async function countReadsBeforeCheck(): Promise<number> {
        const counter = hookedContext(appDir({ expo: '~58.0.0' }, {}, path.join(tmp, 'count')));
        await reset(counter);
        return vi.mocked(counter.client.getUiHierarchy).mock.calls.length;
      }

      beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-hooks-warn-')); });
      afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

      it('leaves one notice per session after clear resets still find no marker, naming the cause and the fix', async () => {
        const ctx = hookedContext(appDir({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }));

        await reset(ctx);
        await reset(ctx);

        const notices = hooksNotices(ctx);
        expect(notices).toHaveLength(1);
        expect(notices[0].message).toContain('enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}');
        expect(notices[0].message).toContain('node_modules');
        expect(notices[0].message).toContain('bare React Native');
        expect(notices[0].message).toContain('https://tapsmith.dev/guides/warm-reset/');
        expect(notices[0].message).toContain("appReset: 'clear'");
        // MCP clips each warning line at 500 characters.
        expect(notices[0].message.length).toBeLessThanOrEqual(500);
      });

      it('looks again before blaming the build: a marker that appears within the budget upgrades instead', async () => {
        const ctx = hookedContext(appDir({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }));
        const readsBeforeCheck = await countReadsBeforeCheck();
        let calls = 0;
        vi.mocked(ctx.client.getUiHierarchy).mockImplementation(async () => {
          calls += 1;
          // Every read up to the reset's own re-read misses; the check's second look sees it.
          const xml = calls <= readsBeforeCheck + 1 ? NO_MARKER : MARKER;
          return { requestId: '1', hierarchyXml: xml, errorMessage: '' };
        });

        await reset(ctx, { phase: 'file reset', hooksProbeMs: 1_000 });

        expect(calls).toBeGreaterThan(readsBeforeCheck + 1);
        expect(ctx.capabilities?.hooksDetected).toBe(true);
        expect(hooksNotices(ctx)).toEqual([]);
      });

      it('stays quiet on a bare probe, and when the check could not read the app (asks again next reset)', async () => {
        const ctx = hookedContext(appDir({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }));
        ctx.capabilities = {};
        await probeResetCapabilities(ctx, { pollMs: 0 });
        expect(ctx.capabilities).toEqual({ hooksDetected: false });
        expect(hooksNotices(ctx)).toEqual([]);

        // Only the check's own reads fail: everything up to and including the
        // reset's single re-read succeeds.
        const readsBeforeCheck = await countReadsBeforeCheck();
        let calls = 0;
        vi.mocked(ctx.client.getUiHierarchy).mockImplementation(async () => {
          calls += 1;
          if (calls > readsBeforeCheck) throw new Error('agent settling');
          return { requestId: '1', hierarchyXml: NO_MARKER, errorMessage: '' };
        });
        await reset(ctx);
        expect(calls).toBeGreaterThan(readsBeforeCheck);
        expect(hooksNotices(ctx)).toEqual([]);

        // The agent can also answer with an error and no hierarchy instead of throwing.
        calls = 0;
        vi.mocked(ctx.client.getUiHierarchy).mockImplementation(async () => {
          calls += 1;
          if (calls > readsBeforeCheck) return { requestId: '1', hierarchyXml: '', errorMessage: 'Interrupting test' };
          return { requestId: '1', hierarchyXml: NO_MARKER, errorMessage: '' };
        });
        await reset(ctx);
        expect(calls).toBeGreaterThan(readsBeforeCheck);
        expect(hooksNotices(ctx)).toEqual([]);

        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({ requestId: '1', hierarchyXml: NO_MARKER, errorMessage: '' });
        await reset(ctx);
        expect(hooksNotices(ctx)).toHaveLength(1);
      });

      it('checks after the startup launch too: a single-file session never reaches an inline reset', async () => {
        const ctx = hookedContext(appDir({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }));
        ctx.capabilities = {};

        await launchConfiguredApp(ctx, 'startup launch', { freshInstall: true, hooksProbeMs: 0 });

        expect(ctx.capabilities).toEqual({ hooksDetected: false });
        expect(hooksNotices(ctx)).toHaveLength(1);
      });

      it('stays quiet when resetAppDeepLink makes auto resolve warm without the hooks', async () => {
        const ctx = hookedContext(appDir({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }), NO_MARKER, { resetAppDeepLink: 'app:///__reset' });
        ctx.capabilities = {};

        await launchConfiguredApp(ctx, 'startup launch', { freshInstall: true, hooksProbeMs: 0 });

        expect(hooksNotices(ctx)).toEqual([]);
      });

      it('finds the app package.json above a config in a subfolder', async () => {
        appDir({ expo: '~58.0.0' }, { '@tapsmith/react-native': '^0.7.1' });
        const ctx = hookedContext(appDir({ tapsmith: '^0.7.1' }, {}, path.join(tmp, 'e2e')));

        await reset(ctx);

        expect(hooksNotices(ctx)).toHaveLength(1);
      });

      it('finds the app from its build path when the config sits outside the app (monorepo)', async () => {
        appDir({ private: 'true' });
        appDir({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }, {}, path.join(tmp, 'apps', 'mobile'));
        const ctx = hookedContext(tmp, NO_MARKER, { apk: 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk' });

        await reset(ctx);

        expect(hooksNotices(ctx)).toHaveLength(1);
      });

      it('stays quiet when the app does not depend on the package, without a rootDir, or with an explicit appReset', async () => {
        const plain = hookedContext(appDir({ expo: '~58.0.0' }));
        const noRoot = hookedContext(undefined);
        const explicit = hookedContext(appDir({ '@tapsmith/react-native': '^0.7.1' }, {}, path.join(tmp, 'x')), NO_MARKER, { appReset: 'clear' });

        for (const ctx of [plain, noRoot, explicit]) await reset(ctx);

        expect([plain, noRoot, explicit].flatMap(hooksNotices)).toEqual([]);
      });
    });

    it('an explicit appReset: clear does not spend a hierarchy read on hook detection', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android', appReset: 'clear' },
      });
      ctx.capabilities = { hooksDetected: false };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
        errorMessage: '',
      });

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.capabilities.hooksDetected).toBe(false);
    });

    it('a probe whose every read fails records nothing (not "no hooks")', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockRejectedValue(new Error('agent busy'));

      expect(await probeResetCapabilities(ctx, { pollMs: 300 })).toEqual({});
      expect(vi.mocked(ctx.client.getUiHierarchy).mock.calls.length).toBeGreaterThan(1);
    });

    it('a warm reset refreshes hooksDetected from the daemon answer', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android' },
      });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 1, epochAfter: 2 }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(ctx.capabilities?.hooksDetected).toBe(true);
    });

    it('a probe that misses the marker never demotes hooksDetected (sticky under load)', async () => {
      const ctx = makeContext();
      (ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities = { hooksDetected: true };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="mid-transition, no marker" /></hierarchy>',
        errorMessage: '',
      });

      const caps = await probeResetCapabilities(ctx);

      expect(caps.hooksDetected).toBe(true);
    });

    it('a fallback reset (daemon saw no marker this time) does not demote hooksDetected', async () => {
      const ctx = makeContext();
      (ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities = { hooksDetected: true };
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', {
        modeUsed: 'restart', fellBack: true, coldLaunch: true, hooksDetected: false,
      }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect((ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities?.hooksDetected).toBe(true);
    });

    it('a session-level probe keeps looking for the marker while the app is still mounting', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" text="splash" /></hierarchy>', errorMessage: '' })
        .mockRejectedValueOnce(new Error('agent busy'))
        .mockResolvedValueOnce({
          requestId: '3',
          hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
          errorMessage: '',
        });

      expect(await probeResetCapabilities(ctx, { pollMs: 5_000 })).toEqual({ hooksDetected: true, hooksUrlPrefix: 'exp://x/' });
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
    });

    it('the probe gives up on the marker at the poll budget and records false once', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" text="no marker" /></hierarchy>', errorMessage: '',
      });

      expect(await probeResetCapabilities(ctx, { pollMs: 600 })).toEqual({ hooksDetected: false });
      const polled = vi.mocked(ctx.client.getUiHierarchy).mock.calls.length;
      expect(polled).toBeGreaterThan(1);

      // Already concluded: a later probe is single-shot (watch/MCP re-probe per file).
      await probeResetCapabilities(ctx, { pollMs: 5_000 });
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(polled + 1);
    });

    describe('stopping early on an app that has rendered without the marker', () => {
      const HOME = '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>';
      const SPLASH = '<hierarchy><node package="com.example.app" text="" /><node package="com.android.systemui" text="12:00" /></hierarchy>';
      const MARKER_XML = '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>';
      const read = (xml: string) => ({ requestId: '1', hierarchyXml: xml, errorMessage: '' });
      let tmp: string;
      beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-hooks-probe-')); });
      afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

      /** A project whose package.json lists `deps`. */
      function project(deps: Record<string, string>): string {
        fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: deps }));
        return tmp;
      }
      function probeContext(rootDir: string | undefined, platform: 'android' | 'ios' = 'android') {
        return makeContext({ config: { package: 'com.example.app', activity: '.MainActivity', platform, rootDir } });
      }

      it('stops after two reads of rendered UI without the marker, for a project without the hooks', async () => {
        // Every app without @tapsmith/react-native paid the whole budget at
        // each session start.
        const ctx = probeContext(project({ expo: '~58.0.0' }));
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(read(HOME));

        expect(await probeResetCapabilities(ctx, { pollMs: 5_000 })).toEqual({ hooksDetected: false });
        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
      });

      it('keeps the whole budget for a project that depends on the hooks, or one it cannot look up', async () => {
        // A hooked app can render a screen before the root that mounts the marker.
        for (const rootDir of [project({ expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' }), undefined]) {
          const ctx = probeContext(rootDir);
          vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(read(HOME));
          await probeResetCapabilities(ctx, { pollMs: 700 });
          expect(vi.mocked(ctx.client.getUiHierarchy).mock.calls.length).toBeGreaterThan(2);
        }
      });

      it('counts only consecutive reads of the app\'s own rendered UI', async () => {
        const ctx = probeContext(project({}));
        vi.mocked(ctx.client.getUiHierarchy)
          .mockResolvedValueOnce(read(SPLASH))
          .mockResolvedValueOnce(read(HOME))
          .mockRejectedValueOnce(new Error('agent busy'))
          .mockResolvedValueOnce(read(HOME))
          .mockResolvedValueOnce(read(SPLASH))
          .mockResolvedValue(read(HOME));

        expect(await probeResetCapabilities(ctx, { pollMs: 5_000 })).toEqual({ hooksDetected: false });
        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(7);
      });

      it('still finds a marker that mounts after the first rendered read', async () => {
        const ctx = probeContext(project({}));
        vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce(read(HOME)).mockResolvedValue(read(MARKER_XML));

        expect(await probeResetCapabilities(ctx, { pollMs: 5_000 })).toEqual({ hooksDetected: true, hooksUrlPrefix: 'exp://x/' });
      });

      it('on iOS, counts an element of the app with a label or identifier, not the application node or keyboard', async () => {
        const app = (inner: string) => `<hierarchy><XCUIElementTypeApplication label="Example" identifier="" type="XCUIElementTypeApplication">${inner}</XCUIElementTypeApplication></hierarchy>`;
        const ctx = probeContext(project({}), 'ios');
        vi.mocked(ctx.client.getUiHierarchy)
          .mockResolvedValueOnce(read(app('<XCUIElementTypeWindow label="" identifier="" type="XCUIElementTypeWindow" />')))
          .mockResolvedValueOnce(read(app('<XCUIElementTypeKeyboard label="" identifier="" type="XCUIElementTypeKeyboard" tapsmith-non-app="true"><XCUIElementTypeKey label="q" identifier="q" type="XCUIElementTypeKey" /></XCUIElementTypeKeyboard>')))
          .mockResolvedValue(read(app('<XCUIElementTypeStaticText label="Welcome" identifier="" type="XCUIElementTypeStaticText" />')));

        expect(await probeResetCapabilities(ctx, { pollMs: 5_000 })).toEqual({ hooksDetected: false });
        expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(4);
      });
    });

    it('a probe failure leaves the capabilities as they were', async () => {
      const ctx = makeContext();
      ctx.capabilities = { hooksDetected: true };
      vi.mocked(ctx.client.getUiHierarchy).mockRejectedValueOnce(new Error('agent busy'));
      expect(await probeResetCapabilities(ctx)).toEqual({ hooksDetected: true });
    });
  });
});

describe('collectAnsweredSystemDialogs (PILOT-977)', () => {
  const event = (overrides: Partial<import('../grpc-client.js').SystemDialogEvent> = {}): import('../grpc-client.js').SystemDialogEvent => ({
    title: 'Pixel Launcher isn\'t responding',
    owner: 'com.google.android.apps.nexuslauncher',
    ownedByTarget: false,
    kind: 'anr',
    button: 'Close app',
    timestampMs: 1_793_463_831_403,
    ...overrides,
  });

  it('turns another app\'s answered dialog into a foreign-dialog notice', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.takeSystemDialogEvents).mockResolvedValueOnce({ requestId: '1', events: [event()] });
    await collectAnsweredSystemDialogs(ctx);
    expect(ctx.notices).toEqual([{
      kind: 'foreign-dialog',
      title: 'Pixel Launcher isn\'t responding',
      owner: 'com.google.android.apps.nexuslauncher',
      message: 'A system dialog from another app came up: '
        + '"Pixel Launcher isn\'t responding" (com.google.android.apps.nexuslauncher). Tapsmith pressed Close app.',
      timestamp: 1_793_463_831_403,
    }]);
  });

  it('reports the app under test\'s own ANR as an app-dialog notice, so the test gets a warning', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.takeSystemDialogEvents).mockResolvedValueOnce({
      requestId: '1',
      events: [event({ title: 'Example isn\'t responding', owner: 'com.example.app', ownedByTarget: true, button: 'Wait' })],
    });
    await collectAnsweredSystemDialogs(ctx);
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]).toMatchObject({ kind: 'app-dialog', owner: 'com.example.app', title: 'Example isn\'t responding' });
    expect(ctx.notices[0].message).toBe(
      'The app under test (com.example.app) stopped responding and showed "Example isn\'t responding"; '
      + 'Tapsmith pressed Wait. Check the app\'s logs (adb logcat) for what blocked its main thread.',
    );
  });

  it('names no owner when the window list did not, and keeps the events in order', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.takeSystemDialogEvents).mockResolvedValueOnce({
      requestId: '1',
      events: [event({ owner: '', title: 'A isn\'t responding' }), event({ title: 'B keeps stopping', kind: 'crash' })],
    });
    await collectAnsweredSystemDialogs(ctx);
    expect(ctx.notices.map((n) => n.title)).toEqual(['A isn\'t responding', 'B keeps stopping']);
    expect(ctx.notices[0].owner).toBeUndefined();
    expect(ctx.notices[0].message).toContain('"A isn\'t responding". Tapsmith pressed Close app.');
  });

  it('falls back to a generic title and to now when the agent sent none', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.takeSystemDialogEvents).mockResolvedValueOnce({ requestId: '1', events: [event({ title: '', timestampMs: 0 })] });
    const before = Date.now();
    await collectAnsweredSystemDialogs(ctx);
    expect(ctx.notices[0].title).toBe('an app isn\'t responding or keeps stopping');
    expect(ctx.notices[0].timestamp).toBeGreaterThanOrEqual(before);
  });

  it('is best effort: a failed call (an older agent, a dead daemon) adds nothing and does not throw', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.takeSystemDialogEvents).mockRejectedValueOnce(new Error('12 UNIMPLEMENTED'));
    await expect(collectAnsweredSystemDialogs(ctx)).resolves.toBeUndefined();
    expect(ctx.notices).toEqual([]);
  });

  it('does not ask an iOS device, which has no such dialogs', async () => {
    const ctx = makeContext({ config: { package: 'com.example.app', platform: 'ios' } });
    await collectAnsweredSystemDialogs(ctx);
    expect(ctx.client.takeSystemDialogEvents).not.toHaveBeenCalled();
  });

  it('asks with a short deadline, so a wedged agent cannot hold the end of the test', async () => {
    const ctx = makeContext();
    await collectAnsweredSystemDialogs(ctx);
    const [deadline] = vi.mocked(ctx.client.takeSystemDialogEvents).mock.calls[0] as unknown as [number];
    expect(deadline).toBeGreaterThan(0);
    expect(deadline).toBeLessThanOrEqual(5_000);
  });
});
