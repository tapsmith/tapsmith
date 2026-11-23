/**
 * Expo development builds (`expo-dev-client`) and Metro.
 *
 * A dev-client build carries no JavaScript: it opens Expo's dev launcher, and
 * the app appears only once the launcher loads a bundle from a dev server.
 * A launch after a clear (Tapsmith's default reset) has no "recently opened"
 * server and stays on the launcher; a launch that does reload the last server
 * opens the dev menu over the app. So after every launch Tapsmith makes of a
 * dev-client build, it connects the build to the Metro server running for
 * this app with the dev-client link Expo's own CLI opens
 * (`exp+<slug>://expo-development-client/?url=…`), with the dev menu and its
 * floating button switched off for that process.
 *
 * Everything here is pure or host-side (HTTP to Metro, `adb reverse`); the
 * device side is in session-preflight.
 */

import * as fs from 'node:fs';
import { unzipSync } from 'fflate';
import { decodeXmlEntities } from './xml-entities.js';
import { getCurrentHostIp } from './ios-host-ip-check.js';
import { readIosUrlSchemes } from './ios-app-bundle.js';

// ─── What is on screen ───

/**
 * A development-build screen standing in for the app:
 * - `launcher`: Expo's dev launcher (its server list), no bundle loaded.
 * - `dev-menu`: the dev menu Expo opens over the app at launch.
 * - `load-error`: the dev launcher's "There was a problem loading the
 *   project." screen (the server is down or the bundle failed).
 * - `no-dev-server`: React Native's red screen for a Debug build that could
 *   not reach Metro (a bare React Native app, or a dev client's last server).
 */
export type DevClientScreen = 'launcher' | 'dev-menu' | 'load-error' | 'no-dev-server';

/** Every text-bearing attribute value in a hierarchy dump (Android or iOS), decoded. */
function hierarchyTexts(hierarchyXml: string): Set<string> {
  const texts = new Set<string>();
  for (const m of hierarchyXml.matchAll(/\b(?:text|content-desc|label|value|name)="([^"]*)"/g)) {
    const value = decodeXmlEntities(m[1]!).trim();
    if (value) texts.add(value);
  }
  return texts;
}

/**
 * Which development-build screen the hierarchy shows, if any. Read from the
 * screens' own words (expo-dev-launcher and expo-dev-menu are not localised),
 * matched whole so an app's own copy cannot set them off by accident.
 */
export function devClientScreen(hierarchyXml: string): DevClientScreen | undefined {
  const texts = hierarchyTexts(hierarchyXml);
  const has = (t: string): boolean => texts.has(t);
  const hasPrefix = (p: string): boolean => [...texts].some((t) => t.startsWith(p));
  if (has('There was a problem loading the project.')) return 'load-error';
  if (
    [...texts].some((t) => /^development servers$/i.test(t))
    && (has('Development Build') || has('Fetch development servers') || has('Enter URL manually')
      || has('New development server') || has('Start a local development server with:'))
  ) return 'launcher';
  if (has('Go home') && has('Reload') && (has('Toggle performance monitor') || has('Toggle element inspector'))) {
    return 'dev-menu';
  }
  if (['Unable to load script.', 'No bundle URL present', 'Could not connect to development server', 'No script URL provided'].some(hasPrefix)) {
    return 'no-dev-server';
  }
  return undefined;
}

// ─── Is the build a dev client? ───

/** What an app build says about itself. */
export interface DevBuildInfo {
  /** It bundles expo-dev-launcher: an Expo development build (Debug). */
  devClient: boolean
  /** The `exp+<slug>` scheme expo-dev-client registered for it, when found. */
  scheme?: string
}

const EXP_SCHEME = /^exp\+[a-z0-9][a-z0-9+.-]*$/i;

/**
 * The strings of a binary AndroidManifest.xml. Its string pool holds each one
 * as UTF-16: a length unit, the characters, a zero unit.
 */
function manifestStrings(manifest: Uint8Array): string[] {
  const text = Buffer.from(manifest.buffer, manifest.byteOffset, manifest.byteLength - (manifest.byteLength % 2)).toString('utf16le');
  const strings: string[] = [];
  for (const chunk of text.split('\0')) {
    // A string is the chunk after its length unit, when that unit matches.
    if (chunk.length > 1 && chunk.charCodeAt(0) === chunk.length - 1) strings.push(chunk.slice(1));
  }
  return strings;
}

/** Read an APK's manifest: dev-launcher's activity and the `exp+` scheme. */
function inspectApk(apkPath: string): DevBuildInfo | undefined {
  try {
    const entries = unzipSync(fs.readFileSync(apkPath), { filter: (f) => f.name === 'AndroidManifest.xml' });
    const manifest = entries['AndroidManifest.xml'];
    if (!manifest) return undefined;
    const strings = manifestStrings(manifest);
    const devClient = strings.includes('expo.modules.devlauncher.launcher.DevLauncherActivity');
    const scheme = strings.find((s) => EXP_SCHEME.test(s));
    return { devClient, ...(scheme ? { scheme } : {}) };
  } catch {
    return undefined;
  }
}

/** Read a simulator or device `.app`: dev-launcher's bundle and the `exp+` scheme. */
function inspectApp(appPath: string, readSchemes: (appPath: string) => string[]): DevBuildInfo | undefined {
  try {
    if (!fs.statSync(appPath).isDirectory()) return undefined;
    const devClient = fs.readdirSync(appPath).some((f) => /^EXDevLauncher.*\.bundle$/.test(f));
    const scheme = readSchemes(appPath).find((s) => EXP_SCHEME.test(s));
    return { devClient, ...(scheme ? { scheme } : {}) };
  } catch {
    return undefined;
  }
}

const buildInfoCache = new Map<string, DevBuildInfo | undefined>();

/**
 * Whether the app build at `buildPath` (an `.apk` or a `.app`) is an Expo
 * development build, and its dev-client scheme. Undefined when it cannot be
 * told (no such file, an unreadable archive): the screen after launch
 * decides then. Cached per path and modification time, since a rebuild can
 * change the answer.
 */
export function inspectDevBuild(
  buildPath: string | undefined,
  deps: { readIosSchemes?: (appPath: string) => string[] } = {},
): DevBuildInfo | undefined {
  if (!buildPath) return undefined;
  let key: string;
  try {
    key = `${buildPath}\0${fs.statSync(buildPath).mtimeMs}`;
  } catch {
    return undefined;
  }
  if (buildInfoCache.has(key)) return buildInfoCache.get(key);
  const info = buildPath.endsWith('.apk')
    ? inspectApk(buildPath)
    : inspectApp(buildPath, deps.readIosSchemes ?? readIosUrlSchemes);
  buildInfoCache.set(key, info);
  return info;
}

// ─── Finding Metro ───

/** Metro's default port and the ones Expo's CLI moves to when it is taken. */
const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 8081 + i);

/**
 * The ports to look for Metro on: `RCT_METRO_PORT` when set (React Native's
 * own variable for a Metro on another port), else 8081–8090.
 */
export function devServerPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const port = Number(env.RCT_METRO_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? [port] : DEFAULT_PORTS;
}

/** A Metro server on this machine, as read from its status page and Expo manifest. */
export interface DevServer {
  port: number
  /** The app id its Expo config declares for the platform (`android.package` / `ios.bundleIdentifier`). */
  appId?: string
  /** The Expo project's slug: the dev client's scheme is `exp+<slug>`. */
  slug?: string
}

/** One HTTP GET, bounded. Undefined on any failure. */
export type DevServerFetch = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number; body: string } | undefined>;

const defaultFetch: DevServerFetch = async (url, headers, timeoutMs) => {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch {
    return undefined;
  }
};

const PROBE_TIMEOUT_MS = 1_500;

/** Read one port: undefined when no Metro answers there. */
async function probeDevServer(port: number, platform: 'android' | 'ios', get: DevServerFetch): Promise<DevServer | undefined> {
  const status = await get(`http://127.0.0.1:${port}/status`, {}, PROBE_TIMEOUT_MS);
  if (!status || !status.body.includes('packager-status:running')) return undefined;
  const server: DevServer = { port };
  const manifest = await get(`http://127.0.0.1:${port}/`, {
    'expo-platform': platform,
    accept: 'application/expo+json,application/json',
  }, PROBE_TIMEOUT_MS * 2);
  if (manifest && manifest.status === 200) {
    try {
      const json = JSON.parse(manifest.body) as { extra?: { expoClient?: Record<string, unknown> } };
      const expo = json.extra?.expoClient;
      if (expo) {
        if (typeof expo.slug === 'string') server.slug = expo.slug;
        const section = expo[platform] as Record<string, unknown> | undefined;
        const id = platform === 'android' ? section?.package : section?.bundleIdentifier;
        if (typeof id === 'string') server.appId = id;
      }
    } catch {
      // Not an Expo manifest: a bare React Native Metro.
    }
  }
  return server;
}

/** The outcome of looking for this app's Metro. */
export type DevServerSearch =
  | { server: DevServer }
  | { server?: undefined; reason: string };

/**
 * Find the Metro serving this app: a server on one of {@link devServerPorts}
 * whose Expo config names `appId`, else one whose config names no app id for
 * the platform. A server whose config names another app is never used (two
 * projects' Metros side by side is common); with several for this app, the
 * lowest port wins.
 */
export async function findDevServer(
  appId: string,
  platform: 'android' | 'ios',
  options: { ports?: number[]; fetch?: DevServerFetch } = {},
): Promise<DevServerSearch> {
  const ports = options.ports ?? devServerPorts();
  const get = options.fetch ?? defaultFetch;
  const servers = (await Promise.all(ports.map((p) => probeDevServer(p, platform, get))))
    .filter((s): s is DevServer => s !== undefined);
  const exact = servers.find((s) => s.appId === appId);
  if (exact) return { server: exact };
  const unnamed = servers.find((s) => s.appId === undefined);
  if (unnamed) return { server: unnamed };
  const where = ports.length === 1 ? `port ${ports[0]}` : `ports ${ports[0]}–${ports.at(-1)}`;
  if (servers.length > 0) {
    const others = servers.map((s) => `${s.appId} on ${s.port}`).join(', ');
    return { reason: `the Metro servers running on this machine are for other apps (${others}), none for ${appId}` };
  }
  return { reason: `no Metro server answered on ${where}` };
}

// ─── Connecting ───

/** Where the device reaches a server on this machine. */
export interface DevServerHostOptions {
  platform: 'android' | 'ios'
  /** The device's adb serial or simulator/device UDID. */
  serial: string
  port: number
}

/** Shell out, bounded; resolves even on failure (with the error). */
async function run(cmd: string, args: string[], timeoutMs: number): Promise<Error | undefined> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve(err ?? undefined));
  });
}

const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * The server's address as the device sees it: an Android emulator reaches
 * the host as `10.0.2.2`; any other Android device through an `adb reverse`
 * of the port (as `expo run:android` sets up); an iOS simulator shares the
 * Mac's network (`localhost`); a physical iPhone needs the Mac's LAN address,
 * which Metro listens on by default.
 */
export async function devServerUrlForDevice(
  options: DevServerHostOptions,
  deps: { adb?: (args: string[]) => Promise<Error | undefined>; hostIp?: () => string | undefined } = {},
): Promise<string> {
  const { platform, serial, port } = options;
  if (platform === 'android') {
    if (/^emulator-\d+$/.test(serial)) return `http://10.0.2.2:${port}`;
    const adb = deps.adb ?? ((args) => run('adb', args, 10_000));
    const err = await adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
    if (err) throw new Error(`could not forward port ${port} to ${serial} for Metro (adb reverse failed: ${err.message})`);
    return `http://localhost:${port}`;
  }
  if (SIMULATOR_UDID.test(serial)) return `http://localhost:${port}`;
  const ip = (deps.hostIp ?? getCurrentHostIp)();
  if (!ip) throw new Error('could not find this Mac\'s network address for the iPhone to reach Metro on');
  return `http://${ip}:${port}`;
}

/**
 * The link that has a dev client load `serverUrl`: the legacy
 * `expo-development-client` host every expo-dev-client version understands,
 * plus switches for the dev menu. `disableOnboarding` and `disableAutoLaunch`
 * are saved in the build's preferences, so the menu stays closed on later
 * launches too (a restart reloads the last server without this link, and the
 * menu it would open lands after the app has drawn, past any check). The
 * floating tools button is hidden for this process only (`__expo_disable_fab`,
 * read by newer versions and ignored by older ones), leaving the button the
 * developer sees outside tests alone.
 */
export function devClientLaunchUrl(scheme: string, serverUrl: string): string {
  const params = new URLSearchParams({
    url: serverUrl,
    disableOnboarding: '1',
    disableAutoLaunch: '1',
    __expo_disable_onboarding: '1',
    __expo_disable_auto_launch: '1',
    __expo_disable_fab: '1',
  });
  return `${scheme}://expo-development-client/?${params.toString()}`;
}

/** The scheme expo-dev-client registers for a project (`exp+<slug>`). */
export function devClientScheme(slug: string): string {
  return `exp+${slug.toLowerCase().replace(/[^a-z0-9+.-]/g, '')}`;
}
