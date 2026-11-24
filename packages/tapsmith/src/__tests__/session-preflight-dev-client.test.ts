import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { connectDevClient, connectDevClientForTool, ensureSessionReady, executeAppReset, launchConfiguredApp, type SessionPreflightContext } from '../session-preflight.js';
import type { DevServerFetch } from '../dev-client.js';

const fixture = (name: string): string => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

const LAUNCHER = fixture('android-dev-launcher.xml');
const DEV_MENU = fixture('android-dev-menu-at-launch.xml');
const LOAD_ERROR = fixture('android-dev-launcher-load-error.xml');
const APP = '<hierarchy><node package="dev.tapsmith.devclient" text="Welcome to Expo" /><node package="dev.tapsmith.devclient" text="Explore" /></hierarchy>';
const PKG = 'dev.tapsmith.devclient';

/** A project folder whose package.json depends on `deps`. */
function project(deps: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-devclient-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }));
  return dir;
}
const DEV_CLIENT_PROJECT = project({ expo: '~58.0.0', 'react-native': '0.88.1', 'expo-dev-client': '~58.0.0' });
const PLAIN_RN_PROJECT = project({ expo: '~58.0.0', 'react-native': '0.88.1' });

/** Metro on 8081 serving this app's Expo config. */
const metro: DevServerFetch = async (url) => {
  if (!url.startsWith('http://127.0.0.1:8081/')) return undefined;
  if (url.endsWith('/status')) return { status: 200, body: 'packager-status:running' };
  return { status: 200, body: JSON.stringify({ extra: { expoClient: { slug: 'devclient', android: { package: PKG }, ios: { bundleIdentifier: PKG } } } }) };
};
const noMetro: DevServerFetch = async () => undefined;

/** A context whose hierarchy reads return `screens` in turn (the last one repeats). */
function makeContext(screens: string[], overrides: { rootDir?: string; platform?: 'android' | 'ios'; device?: string } = {}) {
  let i = 0;
  const device = {
    _sessionLaunches: undefined as number | undefined,
    startAgent: vi.fn(async () => undefined),
    terminateApp: vi.fn(async () => undefined),
    launchApp: vi.fn(async () => undefined),
    restartApp: vi.fn(async () => undefined),
    openDeepLink: vi.fn(async (_url: string) => undefined),
    waitForIdle: vi.fn(async () => undefined),
    currentPackage: vi.fn(async () => PKG),
    getByText: vi.fn(() => ({ tap: vi.fn(async () => undefined) }) as never),
    locator: vi.fn(() => ({ tap: vi.fn(async () => undefined) }) as never),
    pressBack: vi.fn(async () => undefined),
    clearAppData: vi.fn(async () => undefined),
    restoreAppState: vi.fn(async () => undefined),
    getAppState: vi.fn(async () => 'foreground' as const),
    _resetApp: vi.fn(async () => ({
      modeRequested: 'clear' as const, modeUsed: 'clear' as const, fellBack: false, coldLaunch: true,
      durationMs: 100, hooksDetected: false, targetReached: false, steps: [],
    })),
  };
  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({ requestId: '1', hierarchyXml: screens[Math.min(i++, screens.length - 1)]!, errorMessage: '' })),
    waitForAppReady: vi.fn(async () => ({ requestId: '1', ready: true, supported: true })),
    takeSystemDialogEvents: vi.fn(async () => ({ requestId: '1', events: [] })),
  };
  const ctx: SessionPreflightContext = {
    label: 'Worker 0',
    notices: [],
    relaunches: { count: 0 },
    deviceSerial: overrides.device ?? 'emulator-5554',
    config: {
      package: PKG,
      platform: overrides.platform ?? 'android',
      rootDir: overrides.rootDir ?? DEV_CLIENT_PROJECT,
      appReset: 'clear',
    } as SessionPreflightContext['config'],
    device: device as unknown as SessionPreflightContext['device'],
    client: client as unknown as SessionPreflightContext['client'],
    capabilities: {},
  };
  return { ctx, device, client };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connectDevClient', () => {
  it('points a dev client on its launcher at Metro and waits for the app', async () => {
    const { ctx, device } = makeContext([LAUNCHER, LAUNCHER, APP]);
    await connectDevClient(ctx, { fetch: metro });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
    const url = new URL(device.openDeepLink.mock.calls[0]![0]);
    expect(url.protocol).toBe('exp+devclient:');
    expect(url.searchParams.get('url')).toBe('http://10.0.2.2:8081?disableOnboarding=1');
    expect(url.searchParams.get('__expo_disable_auto_launch')).toBe('1');
    expect(ctx.capabilities?.devClientSeen).toBe(true);
  });

  it('reads again while the launch has drawn nothing yet (a test\'s own launchApp() comes straight here)', async () => {
    const blank = `<hierarchy><node package="${PKG}" class="android.widget.FrameLayout" text="" content-desc="" /></hierarchy>`;
    const { ctx, device } = makeContext([blank, blank, LAUNCHER, APP]);
    await connectDevClient(ctx, { fetch: metro });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('takes a first screen with nothing readable on it for the app, after a while', async () => {
    vi.useFakeTimers();
    try {
      const dialog = '<hierarchy><node package="com.google.android.permissioncontroller" text="Allow" /></hierarchy>';
      const { ctx, device } = makeContext([LAUNCHER, dialog]);
      const done = connectDevClient(ctx, { fetch: metro });
      await vi.advanceTimersByTimeAsync(35_000);
      await done;
      expect(device.openDeepLink).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not take Expo\'s splash screen on iOS for the app', async () => {
    const ios = (inner: string): string => `<hierarchy><XCUIElementTypeApplication label="devclient">${inner}</XCUIElementTypeApplication></hierarchy>`;
    const splash = ios('<XCUIElementTypeImage label="" identifier="SplashScreenLogo" />');
    const { ctx, client } = makeContext(
      [ios('<XCUIElementTypeOther label="This is the developer menu. It gives you access to useful tools in your development builds." />'), splash, splash, ios('<XCUIElementTypeStaticText label="Welcome" />')],
      { platform: 'ios', device: '4178D98F-5543-4DD8-B444-C409CE0EFB78' },
    );
    await connectDevClient(ctx, { fetch: metro });
    expect(client.getUiHierarchy).toHaveBeenCalledTimes(4);
  });

  it('waits out the loading banner before calling the app ready', async () => {
    const banner = `<hierarchy><node package="${PKG}" text="Bundling 12%…" /></hierarchy>`;
    const { ctx, device, client } = makeContext([LAUNCHER, LAUNCHER, banner, banner, APP]);
    await connectDevClient(ctx, { fetch: metro });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
    expect(client.getUiHierarchy).toHaveBeenCalledTimes(5);
  });

  it('waits through a relaunch that is still loading the last server, then handles what comes up', async () => {
    const banner = `<hierarchy><node package="${PKG}" text="Loading from 10.0.2.2:8081…" /></hierarchy>`;
    const { ctx, device } = makeContext([banner, banner, DEV_MENU, APP]);
    await connectDevClient(ctx, { fetch: metro });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('reloads through the link when the dev menu opened over the app', async () => {
    const { ctx, device } = makeContext([DEV_MENU, APP]);
    await connectDevClient(ctx, { fetch: metro });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('uses localhost for an iOS simulator', async () => {
    const launcher = '<XCUIElementTypeApplication label="devclient"><XCUIElementTypeStaticText label="Development Build"/><XCUIElementTypeStaticText label="DEVELOPMENT SERVERS"/></XCUIElementTypeApplication>';
    const app = '<XCUIElementTypeApplication label="devclient"><XCUIElementTypeStaticText label="Welcome to Expo"/></XCUIElementTypeApplication>';
    const { ctx, device } = makeContext([launcher, app], { platform: 'ios', device: '4178D98F-5543-4DD8-B444-C409CE0EFB78' });
    await connectDevClient(ctx, { fetch: metro });
    expect(new URL(device.openDeepLink.mock.calls[0]![0]).searchParams.get('url')).toBe('http://localhost:8081?disableOnboarding=1');
  });

  it('leaves an app that is already showing alone', async () => {
    const { ctx, device, client } = makeContext([APP]);
    await connectDevClient(ctx, { fetch: metro });
    expect(client.getUiHierarchy).toHaveBeenCalledTimes(1);
    expect(device.openDeepLink).not.toHaveBeenCalled();
  });

  it('costs nothing for a project without expo-dev-client', async () => {
    const { ctx, client } = makeContext([LAUNCHER], { rootDir: PLAIN_RN_PROJECT });
    await connectDevClient(ctx, { fetch: metro });
    expect(client.getUiHierarchy).not.toHaveBeenCalled();
  });

  it('still looks in such a project once this session has seen a dev-client screen', async () => {
    const { ctx, device } = makeContext([LAUNCHER, APP], { rootDir: PLAIN_RN_PROJECT });
    ctx.capabilities = { devClientSeen: true };
    await connectDevClient(ctx, { fetch: metro });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('names the launcher and the missing Metro instead of treating the launcher as the app', async () => {
    const { ctx, device } = makeContext([LAUNCHER]);
    const err = await connectDevClient(ctx, { fetch: noMetro }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`${PKG} is an Expo development build and opened on Expo's dev launcher`);
    expect((err as Error).message).toContain('no Metro server answered on ports 8081–8090');
    expect((err as Error).message).toContain('npx expo start');
    expect(device.openDeepLink).not.toHaveBeenCalled();
  });

  it('names the load-error screen when the bundle cannot load', async () => {
    const { ctx } = makeContext([LAUNCHER, LOAD_ERROR]);
    await expect(connectDevClient(ctx, { fetch: metro })).rejects.toThrow(/could not load its JavaScript .*could not load from http:\/\/10\.0\.2\.2:8081/);
  });

  it('names React Native\'s red screen for a missing Metro', async () => {
    const red = `<hierarchy><node package="${PKG}" text="Unable to load script. Make sure you're either running Metro or that your bundle is packaged correctly for release." /></hierarchy>`;
    const { ctx } = makeContext([red]);
    await expect(connectDevClient(ctx, { fetch: metro })).rejects.toThrow(/Unable to load script.*Metro is not reachable/);
  });
});

describe('dev clients through the launch and reset paths', () => {
  it('the startup launch connects a dev client before probing for hooks', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const r = await metro(url, {}, 0);
      if (!r) throw new Error('ECONNREFUSED');
      return { status: r.status, text: async () => r.body };
    }));
    const { ctx, device } = makeContext([LAUNCHER, LAUNCHER, APP]);
    await launchConfiguredApp(ctx, 'startup', { freshInstall: true, hooksProbeMs: 0 });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('names React Native\'s red screen at the startup launch of a plain Debug build', async () => {
    const red = `<hierarchy><node package="${PKG}" text="Unable to load script. Make sure you're either running Metro or that your bundle is packaged correctly for release." /></hierarchy>`;
    const { ctx } = makeContext([red], { rootDir: PLAIN_RN_PROJECT });
    await expect(launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 })).rejects.toThrow(/React Native Debug build and could not load its JavaScript from Metro/);
  });

  it('starts a plain React Native app that rendered with one extra read', async () => {
    const { ctx, client, device } = makeContext([APP], { rootDir: PLAIN_RN_PROJECT });
    await launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 });
    expect(device.openDeepLink).not.toHaveBeenCalled();
    expect(client.getUiHierarchy.mock.calls.length).toBeGreaterThan(0);
  });

  it('an iOS clear reset whose daemon already waited for the render still connects the dev client', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const r = await metro(url, {}, 0);
      if (!r) throw new Error('ECONNREFUSED');
      return { status: r.status, text: async () => r.body };
    }));
    const launcher = '<XCUIElementTypeApplication label="devclient"><XCUIElementTypeStaticText label="Development Build"/><XCUIElementTypeStaticText label="DEVELOPMENT SERVERS"/></XCUIElementTypeApplication>';
    const app = '<XCUIElementTypeApplication label="devclient"><XCUIElementTypeStaticText label="Welcome to Expo"/></XCUIElementTypeApplication>';
    const { ctx, device } = makeContext([launcher, launcher, app], { platform: 'ios', device: '4178D98F-5543-4DD8-B444-C409CE0EFB78' });
    ctx.capabilities = { daemonWaitsForRender: true };
    await executeAppReset(ctx, { mode: 'clear', scope: 'file' }, { phase: 'file reset', hooksProbeMs: 0 });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('an acknowledged in-app warm reset does not look for a dev-client screen', async () => {
    const { ctx, device, client } = makeContext([APP]);
    device._resetApp.mockImplementation(async () => ({
      modeRequested: 'warm' as const, modeUsed: 'warm' as const, fellBack: false, coldLaunch: false,
      durationMs: 100, hooksDetected: true, targetReached: false, steps: [],
    }) as never);
    ctx.capabilities = { hooksDetected: true };
    await executeAppReset(ctx, { mode: 'warm', scope: 'file' }, { phase: 'file reset', hooksProbeMs: 0 });
    expect(device.openDeepLink).not.toHaveBeenCalled();
    // The session check reads the hierarchy once; nothing reads it for a dev-client screen.
    expect(client.getUiHierarchy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('the per-test readiness check connects a dev client it had to relaunch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const r = await metro(url, {}, 0);
      if (!r) throw new Error('ECONNREFUSED');
      return { status: r.status, text: async () => r.body };
    }));
    // The previous test left another app in front: the check relaunches ours,
    // and the relaunch lands on the dev launcher.
    const home = '<hierarchy><node package="com.google.android.apps.nexuslauncher" text="Phone" /></hierarchy>';
    const { ctx, device } = makeContext([home, LAUNCHER, LAUNCHER, LAUNCHER, APP]);
    device.currentPackage.mockResolvedValueOnce('com.google.android.apps.nexuslauncher');
    await ensureSessionReady(ctx, 'before test');
    expect(device.launchApp).toHaveBeenCalledTimes(1);
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('the per-test readiness check reads nothing extra when it relaunched nothing', async () => {
    const { ctx, device } = makeContext([APP]);
    await ensureSessionReady(ctx, 'before test');
    expect(device.launchApp).not.toHaveBeenCalled();
    expect(device.openDeepLink).not.toHaveBeenCalled();
  });

  it('marks its own launches so the device\'s after-launch hook (for a test\'s calls) stays out', async () => {
    const { ctx, device } = makeContext([APP]);
    const during: Array<number | undefined> = [];
    device.launchApp.mockImplementation(async () => { during.push(device._sessionLaunches); });
    await launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 });
    expect(during).toEqual([1]);
    expect(device._sessionLaunches).toBe(0);
  });

  it('a clear reset connects the relaunched dev client', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const r = await metro(url, {}, 0);
      if (!r) throw new Error('ECONNREFUSED');
      return { status: r.status, text: async () => r.body };
    }));
    const { ctx, device } = makeContext([APP, LAUNCHER, LAUNCHER, APP]);
    await executeAppReset(ctx, { mode: 'clear', scope: 'file' }, { phase: 'file reset', hooksProbeMs: 0 });
    expect(device.openDeepLink).toHaveBeenCalledTimes(1);
  });
});

describe('connectDevClientForTool (the MCP server\'s own launches)', () => {
  it('connects a dev client in the project the server runs in', async () => {
    const { ctx, device, client } = makeContext([LAUNCHER, APP]);
    const fetch = vi.fn(async (url: string) => {
      const r = await metro(url, {}, 0);
      if (!r) throw new Error('ECONNREFUSED');
      return { status: r.status, text: async () => r.body };
    });
    vi.stubGlobal('fetch', fetch);
    await connectDevClientForTool({
      client: ctx.client, device, packageName: PKG, platform: 'android', serial: 'emulator-5554', rootDir: DEV_CLIENT_PROJECT,
    });
    expect(client.getUiHierarchy).toHaveBeenCalled();
    expect(new URL(device.openDeepLink.mock.calls[0]![0]).searchParams.get('url')).toBe('http://10.0.2.2:8081?disableOnboarding=1');
  });

  it('leaves other projects alone', async () => {
    const { ctx, device, client } = makeContext([LAUNCHER]);
    await connectDevClientForTool({ client: ctx.client, device, packageName: PKG, platform: 'android', rootDir: PLAIN_RN_PROJECT });
    expect(client.getUiHierarchy).not.toHaveBeenCalled();
    expect(device.openDeepLink).not.toHaveBeenCalled();
  });
});
