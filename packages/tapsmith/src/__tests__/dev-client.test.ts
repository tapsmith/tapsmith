import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  devClientLaunchUrl,
  devClientScheme,
  devClientScreen,
  devServerPorts,
  devServerUrlForDevice,
  findDevServer,
  inspectDevBuild,
  type DevServerFetch,
} from '../dev-client.js';

const fixture = (name: string): string => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

describe('devClientScreen', () => {
  it('recognises the Android dev launcher with a server list (SDK 58, Tapsmith agent dump)', () => {
    expect(devClientScreen(fixture('android-dev-launcher.xml'))).toBe('launcher');
  });

  it('recognises the Android dev launcher with no server found (uiautomator dump)', () => {
    expect(devClientScreen(fixture('android-dev-launcher-empty.xml'))).toBe('launcher');
  });

  it('recognises the dev menu Expo opens over the app at launch', () => {
    expect(devClientScreen(fixture('android-dev-menu-at-launch.xml'))).toBe('dev-menu');
  });

  it('recognises the dev launcher\'s load error screen', () => {
    expect(devClientScreen(fixture('android-dev-launcher-load-error.xml'))).toBe('load-error');
  });

  it('recognises React Native\'s red screen on Android, whose text holds double quotes (single-quoted in the dump)', () => {
    expect(devClientScreen(fixture('android-redbox-no-metro.xml'))).toBe('no-dev-server');
  });

  it('recognises the iOS dev launcher (SDK 58, Tapsmith agent dump)', () => {
    expect(devClientScreen(fixture('ios-dev-launcher.xml'))).toBe('launcher');
  });

  it('recognises React Native\'s red screen for a missing Metro', () => {
    const android = '<hierarchy><node text="Unable to load script. Make sure you&apos;re either running Metro (run &apos;npx react-native start&apos;) or that your bundle &apos;index.android.bundle&apos; is packaged correctly for release." package="com.example"/></hierarchy>';
    expect(devClientScreen(android)).toBe('no-dev-server');
    const ios = '<XCUIElementTypeApplication><XCUIElementTypeStaticText label="Could not connect to development server.&#10;&#10;Ensure the following:"/></XCUIElementTypeApplication>';
    expect(devClientScreen(ios)).toBe('no-dev-server');
    // iOS with no packager at all: RCTBundleURLProvider has no URL to try.
    const noUrl = '<XCUIElementTypeApplication><XCUIElementTypeStaticText label="No bundle URL present.&#10;&#10;Make sure you&apos;re running a packager server or have included a .jsbundle file in your application bundle."/></XCUIElementTypeApplication>';
    expect(devClientScreen(noUrl)).toBe('no-dev-server');
  });

  it('reads the loaded app (with its hooks marker and the status bar) as no development screen', () => {
    expect(devClientScreen(fixture('android-dev-client-app.xml'))).toBeUndefined();
  });

  it('recognises React Native\'s dev loading banner on both platforms', () => {
    const node = (t: string): string => `<hierarchy><node package="x" text="${t}" /></hierarchy>`;
    for (const t of ['Loading from 10.0.2.2:8081…', 'Loading from Metro…', 'Bundling 45%…', 'Downloading 100%…', 'Refreshing...', 'Connecting to the development server...']) {
      expect(devClientScreen(node(t))).toBe('loading');
    }
    // An app's own progress copy is not the banner.
    expect(devClientScreen(node('Downloading your files'))).toBeUndefined();
    expect(devClientScreen(node('Loading from your library'))).toBeUndefined();
  });

  it('reads a launcher whose server list has not drawn yet as the launcher', () => {
    const drawn = ['App Icon', 'devclient', 'Development Build', 'User', 'Home', 'Updates', 'Settings'];
    expect(devClientScreen(`<hierarchy>${drawn.map((t) => `<node text="${t}"/>`).join('')}</hierarchy>`)).toBe('launcher');
    // An app's own badge and tabs are not it.
    expect(devClientScreen('<hierarchy><node text="Development Build"/><node text="Home"/><node text="Settings"/></hierarchy>')).toBeUndefined();
  });

  it('reads the red box of a bundle that does not compile as a load error, not one from the running app', () => {
    const box = (message: string): string => `<hierarchy><XCUIElementTypeStaticText label="${message}"/><XCUIElementTypeButton label="Dismiss&#10;(ESC)"/><XCUIElementTypeButton label="Extra Info&#10;(⌘E)"/></hierarchy>`;
    expect(devClientScreen(box('SyntaxError: /app/_layout.tsx: Unexpected token (19:10)'))).toBe('load-error');
    expect(devClientScreen(box('SyntaxError: JSON Parse error: Unexpected token'))).toBeUndefined();
    expect(devClientScreen(box('Unhandled JS Exception: boom'))).toBeUndefined();
  });

  it('leaves an app\'s own screen alone, even one that says "Reload" or "Development servers" in passing', () => {
    expect(devClientScreen('<hierarchy><node text="Welcome to Expo" package="x"/><node text="Reload" package="x"/></hierarchy>')).toBeUndefined();
    expect(devClientScreen('<hierarchy><node text="Development servers" package="x"/><node text="Settings" package="x"/></hierarchy>')).toBeUndefined();
    expect(devClientScreen('<hierarchy><node text="How to fix: Unable to load script." package="x"/></hierarchy>')).toBeUndefined();
  });
});

describe('inspectDevBuild', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-devbuild-'));

  /** An APK whose binary manifest's string pool holds `strings` as aapt2 writes them (UTF-16: length, characters, zero). */
  function apk(name: string, strings: string[], files: string[] = []): string {
    const header = Buffer.from([0x03, 0x00, 0x08, 0x00, 0x10, 0x20, 0x00, 0x00]);
    const utf16 = Buffer.concat([header, ...strings.map((s) => {
      const len = Buffer.alloc(2);
      len.writeUInt16LE(s.length);
      return Buffer.concat([len, Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
    })]);
    const file = path.join(tmp, name);
    fs.writeFileSync(file, zipSync({ 'AndroidManifest.xml': new Uint8Array(utf16), 'classes.dex': strToU8('dex'), ...Object.fromEntries(files.map((f) => [f, strToU8('x')])) }));
    return file;
  }

  it('reads a debug APK as a dev client, with its exp+ scheme', () => {
    const file = apk('debug.apk', ['dev.tapsmith.devclient', 'expo.modules.devlauncher.launcher.DevLauncherActivity', 'exp+devclient', 'devclient']);
    expect(inspectDevBuild(file)).toEqual({ devClient: true, embedsJs: false, scheme: 'exp+devclient' });
  });

  it('reads a release APK as not a dev client', () => {
    // A string of 57 characters has a printable length unit ('9'): it must not run into the scheme.
    const file = apk('release.apk', ['dev.tapsmith.devclient', 'exp+devclient', 'expo.modules.adapters.react.apploader.RNHeadlessAppLoader', '.MainActivity'], ['assets/index.android.bundle']);
    expect(inspectDevBuild(file)).toEqual({ devClient: false, embedsJs: true, scheme: 'exp+devclient' });
  });

  it('reads a debug .app by its EXDevLauncher bundle and its registered exp+ scheme', () => {
    const app = path.join(tmp, 'Debug.app');
    fs.mkdirSync(path.join(app, 'EXDevLauncher.bundle'), { recursive: true });
    const readIosSchemes = vi.fn(() => ['devclient', 'dev.tapsmith.devclient', 'exp+devclient']);
    expect(inspectDevBuild(app, { readIosSchemes })).toEqual({ devClient: true, embedsJs: false, scheme: 'exp+devclient' });
  });

  it('reads a release .app as not a dev client', () => {
    const app = path.join(tmp, 'Release.app');
    fs.mkdirSync(path.join(app, 'Frameworks'), { recursive: true });
    fs.writeFileSync(path.join(app, 'main.jsbundle'), 'js');
    expect(inspectDevBuild(app, { readIosSchemes: () => [] })).toEqual({ devClient: false, embedsJs: true });
  });

  it('cannot tell without a readable build', () => {
    expect(inspectDevBuild(undefined)).toBeUndefined();
    expect(inspectDevBuild(path.join(tmp, 'missing.apk'))).toBeUndefined();
    const notZip = path.join(tmp, 'broken.apk');
    fs.writeFileSync(notZip, 'not a zip');
    expect(inspectDevBuild(notZip)).toBeUndefined();
  });
});

describe('findDevServer', () => {
  /** A fake host: `servers` maps a port to what its Metro serves (`undefined` manifest = bare React Native). */
  function host(servers: Record<number, { manifest?: object } | 'down'>): DevServerFetch {
    return async (url, headers) => {
      const port = Number(new URL(url).port);
      const server = servers[port];
      if (!server || server === 'down') return undefined;
      if (url.endsWith('/status')) return { status: 200, body: 'packager-status:running' };
      expect(headers['expo-platform']).toBeDefined();
      return server.manifest ? { status: 200, body: JSON.stringify(server.manifest) } : { status: 404, body: 'Cannot GET /' };
    };
  }
  const expoManifest = (slug: string, android: string, ios: string): object => ({
    extra: { expoClient: { slug, android: { package: android }, ios: { bundleIdentifier: ios } } },
  });

  it('picks the Metro whose Expo config names the app, over another app\'s on a lower port', async () => {
    const fetch = host({
      8081: { manifest: expoManifest('other', 'com.other', 'com.other') },
      8082: { manifest: expoManifest('devclient', 'dev.tapsmith.devclient', 'dev.tapsmith.devclient') },
    });
    const found = await findDevServer('dev.tapsmith.devclient', 'android', { fetch, ports: [8081, 8082, 8083] });
    expect(found).toEqual({ server: { port: 8082, appId: 'dev.tapsmith.devclient', slug: 'devclient' } });
  });

  it('reads the id for the platform asked about', async () => {
    const fetch = host({ 8081: { manifest: expoManifest('app', 'com.example.android', 'com.example.ios') } });
    expect((await findDevServer('com.example.ios', 'ios', { fetch, ports: [8081] })).server?.port).toBe(8081);
    expect((await findDevServer('com.example.ios', 'android', { fetch, ports: [8081] })).server).toBeUndefined();
  });

  it('falls back to a Metro that names no app (bare React Native, or a config without the id)', async () => {
    const fetch = host({ 8081: {} });
    expect(await findDevServer('com.example', 'ios', { fetch, ports: [8081, 8082] })).toEqual({ server: { port: 8081 } });
  });

  it('never uses another app\'s Metro, and says whose it is', async () => {
    const fetch = host({ 8081: { manifest: expoManifest('other', 'com.other', 'com.other') } });
    const found = await findDevServer('com.example', 'android', { fetch, ports: [8081, 8082] });
    expect(found.server).toBeUndefined();
    expect(found).toMatchObject({ reason: expect.stringContaining('com.other on 8081') });
  });

  it('says which ports it tried when no Metro runs', async () => {
    const found = await findDevServer('com.example', 'android', { fetch: host({}), ports: devServerPorts({}) });
    expect(found).toEqual({ reason: 'no Metro server answered on ports 8081–8090' });
    const one = await findDevServer('com.example', 'android', { fetch: host({}), ports: [9000] });
    expect(one).toEqual({ reason: 'no Metro server answered on port 9000' });
  });

  it('matches a debug or variant build by its dev-client scheme', async () => {
    const fetch = host({ 8081: { manifest: expoManifest('My App', 'com.example', 'com.example') } });
    const found = await findDevServer('com.example.dev', 'android', { fetch, ports: [8081], scheme: 'exp+myapp' });
    expect(found.server?.port).toBe(8081);
    expect((await findDevServer('com.example.dev', 'android', { fetch, ports: [8081], scheme: 'exp+other' })).server).toBeUndefined();
  });

  it('does not guess at another project\'s Metro that names no app id, or past one it could not read', async () => {
    const slugOnly = { extra: { expoClient: { slug: 'playground' } } };
    const found = await findDevServer('com.shop', 'android', { fetch: host({ 8081: { manifest: slugOnly } }), ports: [8081], scheme: 'exp+shop' });
    expect(found).toEqual({ reason: expect.stringContaining('playground on 8081') });
    const fetch: DevServerFetch = async (url) => (url.endsWith('/status')
      ? { status: 200, body: 'packager-status:running' }
      : url.includes(':8082') ? undefined : { status: 404, body: '' });
    expect((await findDevServer('com.shop', 'android', { fetch, ports: [8081, 8082] })).server).toBeUndefined();
  });

  it('does not take a Metro whose Expo config could not be read for a bare one', async () => {
    for (const manifest of [undefined, { status: 500, body: '{}' }]) {
      const fetch: DevServerFetch = async (url) => (url.endsWith('/status') ? { status: 200, body: 'packager-status:running' } : manifest);
      const found = await findDevServer('com.example', 'android', { fetch, ports: [8081] });
      expect(found).toEqual({ reason: expect.stringContaining('port 8081 did not answer with its Expo config') });
    }
  });

  it('does not take a server that is not Metro', async () => {
    const fetch: DevServerFetch = async () => ({ status: 200, body: '<html>webpack</html>' });
    expect((await findDevServer('com.example', 'ios', { fetch, ports: [8081] })).server).toBeUndefined();
  });
});

describe('devServerPorts', () => {
  it('uses RCT_METRO_PORT when set to a port, else 8081–8090', () => {
    expect(devServerPorts({ RCT_METRO_PORT: '9090' })).toEqual([9090]);
    expect(devServerPorts({ RCT_METRO_PORT: 'nope' })).toHaveLength(10);
    expect(devServerPorts({})[0]).toBe(8081);
  });
});

describe('devServerUrlForDevice', () => {
  it('reaches the host from an Android emulator at 10.0.2.2 without adb', async () => {
    const adb = vi.fn(async () => undefined);
    expect(await devServerUrlForDevice({ platform: 'android', serial: 'emulator-5554', port: 8081 }, { adb })).toBe('http://10.0.2.2:8081');
    expect(adb).not.toHaveBeenCalled();
  });

  it('reverses the port to a physical Android device', async () => {
    const adb = vi.fn(async () => undefined);
    expect(await devServerUrlForDevice({ platform: 'android', serial: 'R58M123', port: 8082 }, { adb })).toBe('http://localhost:8082');
    expect(adb).toHaveBeenCalledWith(['-s', 'R58M123', 'reverse', 'tcp:8082', 'tcp:8082']);
  });

  it('names a failed adb reverse', async () => {
    const adb = vi.fn(async () => new Error('device offline'));
    await expect(devServerUrlForDevice({ platform: 'android', serial: 'R58M123', port: 8081 }, { adb })).rejects.toThrow(/adb reverse failed: device offline/);
  });

  it('uses localhost on an iOS simulator and the Mac\'s address on an iPhone', async () => {
    expect(await devServerUrlForDevice({ platform: 'ios', serial: '4178D98F-5543-4DD8-B444-C409CE0EFB78', port: 8081 })).toBe('http://localhost:8081');
    expect(await devServerUrlForDevice({ platform: 'ios', serial: '00008110-001A2B3C4D5E6F70', port: 8081 }, { hostIp: () => '192.168.1.20' })).toBe('http://192.168.1.20:8081');
    await expect(devServerUrlForDevice({ platform: 'ios', serial: '00008110-001A2B3C4D5E6F70', port: 8081 }, { hostIp: () => undefined })).rejects.toThrow(/network address/);
  });
});

describe('devClientLaunchUrl', () => {
  it('builds the dev-client link with the server and the dev menu switched off', () => {
    const url = new URL(devClientLaunchUrl('exp+devclient', 'http://10.0.2.2:8081'));
    expect(url.protocol).toBe('exp+devclient:');
    expect(url.host).toBe('expo-development-client');
    expect(url.searchParams.get('url')).toBe('http://10.0.2.2:8081?disableOnboarding=1');
    expect(url.searchParams.get('disableOnboarding')).toBe('1');
    expect(url.searchParams.get('__expo_disable_auto_launch')).toBe('1');
    expect(url.searchParams.get('__expo_disable_fab')).toBe('1');
  });

  it('derives the scheme from the slug as expo-dev-client does', () => {
    expect(devClientScheme('devclient')).toBe('exp+devclient');
    expect(devClientScheme('My App')).toBe('exp+myapp');
  });
});
