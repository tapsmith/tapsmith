/**
 * Configuration for Tapsmith tests.
 *
 * Users create a `tapsmith.config.ts` at their project root:
 *
 *   import { defineConfig } from 'tapsmith';
 *   export default defineConfig({ timeout: 15000 });
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReporterConfig } from './reporter.js';
import type { TraceMode, TraceConfig } from './trace/types.js';
import type { VideoMode, VideoConfig } from './video/types.js';

export type ScreenshotMode = 'always' | 'only-on-failure' | 'never';
export type DeviceStrategy = 'prefer-connected' | 'avd-only';
/** How the app is reset before tests — see {@link TapsmithConfig.appReset}. */
export type AppResetMode = 'auto' | 'clear' | 'restart' | 'warm' | 'none';
/** How often the app reset runs — see {@link TapsmithConfig.appResetScope}. */
export type AppResetScope = 'auto' | 'file' | 'test';
export const APP_RESET_MODES: readonly AppResetMode[] = ['auto', 'clear', 'restart', 'warm', 'none'];
export const APP_RESET_SCOPES: readonly AppResetScope[] = ['auto', 'file', 'test'];
/** Default for {@link TapsmithConfig.appResetColdEvery}. */
export const DEFAULT_APP_RESET_COLD_EVERY = 10;
export type Platform = 'android' | 'ios';

export type { TraceMode, TraceConfig, VideoMode, VideoConfig };

/**
 * One member of a device group — see {@link TapsmithConfig.devices}.
 */
export interface DeviceGroupEntry {
  /**
   * How tests and traces refer to this device: `devices[i]` in the fixture
   * order, the `deviceId` on every trace event it produces, the suffix on its
   * failure screenshots, and the `device` argument MCP tools accept. Must be
   * unique within the group.
   */
  name: string;
  /**
   * Pin this member to a specific serial / UDID. Optional for emulators and
   * simulators (Tapsmith provisions them); required for physical iOS devices
   * beyond the first, which cannot be auto-picked.
   */
  device?: string;
}

export interface TapsmithConfig {
  /**
   * Target platform. Required for iOS; defaults to Android behavior when unset.
   */
  platform?: Platform;

  /** Path to the APK under test (Android). */
  apk?: string;

  /** Path to the .app bundle under test (iOS simulator). */
  app?: string;

  /**
   * Optional activity name to use when auto-launching the app under test.
   * Usually not needed. When unset, Tapsmith launches the package's default
   * launcher activity and falls back to resolving it automatically.
   */
  activity?: string;

  /** Default timeout for actions and assertions in milliseconds. */
  timeout: number;

  /** Number of times to retry a failed test. */
  retries: number;

  /** When to capture screenshots. */
  screenshot: ScreenshotMode;

  /** Glob patterns for discovering test files. */
  testMatch: string[];

  /** Address of the Tapsmith daemon. */
  daemonAddress: string;

  /** Path to the tapsmith-core binary. Defaults to 'tapsmith-core' (must be on PATH). */
  daemonBin?: string;

  /**
   * Target a specific device serial for single-device runs or debugging.
   * Prefer `avd` for parallel emulator provisioning.
   */
  device?: string;

  /**
   * Drive several devices from one test — the mobile analogue of Playwright's
   * multi-context tests (two users chatting with each other). A "context" on
   * mobile is a whole device: every member gets its own daemon, agent and app
   * install, is reset per the declared `appReset` policy, and records into the
   * same trace tagged with its name.
   *
   * - a number: that many devices, named `device-1`, `device-2`, …
   * - an array: named members, optionally pinned to a serial / UDID.
   *
   * Tests receive them as the `devices` fixture (`device` stays an alias for
   * `devices[0]`). Device-shaping, so project-level only — a `test.use()`
   * cannot change the group a worker holds. Each two-device test costs two
   * device slots, so a group project halves the parallelism of its bucket.
   *
   * @example
   * projects: [{
   *   name: 'chat',
   *   testMatch: '**\/multi-user/**',
   *   use: { devices: [{ name: 'alice' }, { name: 'bob' }] },
   * }]
   */
  devices?: number | DeviceGroupEntry[];

  /**
   * How Tapsmith chooses devices when `device` is not explicitly set.
   * When unset, Tapsmith defaults to `avd-only` if `avd` is configured and
   * `prefer-connected` otherwise.
   * `prefer-connected` uses any healthy connected device first.
   * `avd-only` ignores non-matching devices and only uses the configured AVD.
   */
  deviceStrategy?: DeviceStrategy;

  /** Working directory for test discovery. */
  rootDir: string;

  /** Directory to write screenshots and artifacts to. */
  outputDir: string;

  /** Android package name of the app under test. Launched automatically before tests. */
  package?: string;

  /** Path to the Tapsmith agent APK. Used for auto-install if agent is not on device. */
  agentApk?: string;

  /** Path to the Tapsmith agent test APK. Used for auto-install if agent is not on device. */
  agentTestApk?: string;

  /** Path to the iOS agent .xctestrun file. Used for auto-launch of the iOS agent. */
  iosXctestrun?: string;

  /**
   * Optional deep link used to soft-reset the app between files on platforms
   * where hard restarts are slow or unstable. Intended for app-specific test
   * hooks such as a reset route in a first-party test app. The route should
   * clear app state and navigate to the desired start screen itself.
   */
  resetAppDeepLink?: string;

  /**
   * How long to wait after opening `resetAppDeepLink` before continuing.
   * Defaults to 750ms when the deep link is configured.
   */
  resetAppWaitMs?: number;

  /**
   * How the app is reset to a known state before tests run (the mobile
   * analogue of Playwright's per-test browser context). Recorded in the trace
   * as fixture setup under the BEFORE ALL / BEFORE EACH group.
   *
   * - `'auto'` (default): `'warm'` when the app exposes a reset hook
   *   (`resetAppDeepLink`, or `@tapsmith/react-native` once detected),
   *   otherwise `'clear'`.
   * - `'clear'`: wipe app data and cold-launch (slowest, fully hermetic).
   * - `'restart'`: terminate and relaunch, keeping persisted data.
   * - `'warm'`: in-app reset via the reset hook, no process restart (fastest).
   * - `'none'`: no reset — only verify the session is healthy.
   *
   * Overridable per project (`projects[].use`) and per scope (`test.use()`).
   */
  appReset?: AppResetMode;

  /**
   * Whether the reset runs once per test file or before every test.
   * `'auto'` (default) resolves to `'file'`: one reset on scope entry. Files
   * that need a fresh app before every test opt in with
   * `test.use({ appResetScope: 'test' })` — still warm when hooks are present.
   */
  appResetScope?: AppResetScope;

  /**
   * Bound the warm window: after this many consecutive warm resets the next
   * one is delivered cold (terminate + relaunch), which keeps iOS simulator
   * accessibility trees from drifting during long all-warm sessions. Only
   * affects `appReset: 'warm'`. `0` disables the valve. Default 10.
   */
  appResetColdEvery?: number;

  /**
   * UI-mode defaults. These seed the session; a person's explicit choice in
   * the UI (the device chip's context menu, persisted in their browser) still
   * wins for them.
   */
  ui?: {
    /**
     * Prepare the device (run the declared app reset) in the background
     * between runs. Default true. Turn off at the config level when resets
     * have side effects your team must control (backend calls in `onReset`,
     * rate limits) or on personal physical devices.
     */
    prepareBetweenRuns?: boolean;
    /** Quiet time in milliseconds after a run before the device is prepared (default 0 = immediately). */
    prepareDelayMs?: number;
  };

  /**
   * Anonymous usage telemetry (default true). Tapsmith reports one event per
   * test-file run — run mode, platform, pass/fail counts, SDK/Node/OS
   * versions — under a random per-machine id. It never sends test names,
   * locators, app identifiers, or file paths. Set `false` to opt out; the
   * `TAPSMITH_TELEMETRY=0` environment variable does the same without a
   * config change. See `docs/telemetry.md`.
   */
  telemetry?: boolean;

  /**
   * Delay in milliseconds between keystrokes when typing text.
   * Helps prevent dropped characters on slow CI simulators/emulators.
   * Defaults to 0 (no delay).
   */
  typingDelay?: number;

  /**
   * Interval in milliseconds between the two taps of a double-tap gesture.
   * Must be a positive number. Increase if double-taps are being registered
   * as single taps on slow devices. Defaults to 100 when not set.
   */
  doubleTapInterval?: number;

  /**
   * iOS simulator name or UDID. Analogous to `avd` for Android.
   * Run `xcrun simctl list devices` to see available simulators.
   */
  simulator?: string;

  /**
   * Test reporter configuration.
   *
   * Can be a reporter name ('list', 'dot', 'line', 'json', 'junit', 'html',
   * 'github', 'blob'), a tuple with options (['json', { outputFile: 'r.json' }]),
   * an array of these, or undefined for auto-detection (list locally, dot in CI).
   */
  reporter?: ReporterConfig;

  /**
   * Number of parallel workers. Each worker gets its own device and daemon.
   * Defaults to 1 (sequential execution).
   */
  workers: number;

  /**
   * Shard specification for splitting tests across CI machines.
   * Usually set via the `--shard=x/y` CLI flag.
   */
  shard?: { current: number; total: number };

  /**
   * Automatically launch emulators to fill the requested worker count.
   * When true, the dispatcher starts Android emulators for any workers that
   * don't already have a healthy connected device.
   * Defaults to true when `avd` is set, false otherwise.
   */
  launchEmulators: boolean;

  /**
   * Android Virtual Device (AVD) name to use when launching emulators.
   * When set, Tapsmith automatically launches emulator instances of this AVD
   * to fill the requested worker count. Set `launchEmulators: false` to disable.
   * Run `emulator -list-avds` to see available AVDs.
   */
  avd?: string;

  /**
   * Trace recording configuration.
   *
   * Can be a mode string ('off', 'on', 'retain-on-failure', etc.) or an
   * object with granular options. Defaults to 'off'.
   *
   * @example
   * // String shorthand
   * trace: 'on'
   *
   * @example
   * // Object form with granular control
   * trace: { mode: 'retain-on-failure', screenshots: true, snapshots: true }
   */
  trace?: TraceMode | Partial<TraceConfig>;

  /**
   * Continuous video recording of the device screen during test execution
   * (PILOT-114). Mirrors Playwright's `video` config.
   *
   * Defaults to `'off'`. The supported modes are the same as `trace`.
   *
   * Implementation: Android via `adb shell screenrecord` (3-min hard cap per
   * recording — videos beyond 3 minutes are truncated by the device-side
   * encoder); iOS Simulator via `xcrun simctl io recordVideo`; iOS physical
   * devices via `ffmpeg -f avfoundation` (requires `ffmpeg` on PATH).
   *
   * @example
   * // String shorthand
   * video: 'retain-on-failure'
   *
   * @example
   * // Object form — `size` is honoured on Android only; iOS records at
   * // native resolution and emits a one-time warning when `size` is set.
   * video: { mode: 'on', size: { width: 1280, height: 720 } }
   */
  video?: VideoMode | Partial<VideoConfig>;

  /**
   * Named test groups with dependency ordering, mirroring Playwright's projects.
   * Setup projects run first; dependent projects run after their dependencies complete.
   *
   * @example
   * projects: [
   *   { name: 'setup', testMatch: ['auth.setup.ts'] },
   *   { name: 'authenticated', dependencies: ['setup'], use: { appState: './auth.tar.gz' } },
   * ]
   */
  projects?: ProjectConfig[];

  /** Base URL for API requests made via the `request` fixture. */
  baseURL?: string;

  /**
   * Extra HTTP headers sent with every `request` fixture call.
   * Per-request headers override these when names collide.
   */
  extraHTTPHeaders?: Record<string, string>;

  /**
   * Run only tests whose fullName (`describe > test`) matches at least one of
   * these regular expressions. Mirrors Playwright's `grep` /  `--grep` CLI flag.
   * Combined with `grepInvert` via logical AND.
   */
  grep?: RegExp | RegExp[];

  /**
   * Skip tests whose fullName (`describe > test`) matches any of these regular
   * expressions. Mirrors Playwright's `grepInvert` / `--grep-invert` CLI flag.
   */
  grepInvert?: RegExp | RegExp[];
}

// ─── Per-scope option overrides ───

/**
 * Options that can be overridden per-describe via `test.use()` or per-project
 * via `projects[].use`.
 *
 * Device-shaping fields (`platform`, `avd`, `simulator`, `app`, `apk`, etc.)
 * may only be overridden at the project level — they have no effect from
 * `test.use()` since the device is bound to the worker before any test runs.
 */
export type UseOptions = Partial<Pick<TapsmithConfig,
  | 'timeout'
  | 'screenshot'
  | 'retries'
  | 'trace'
  | 'video'
  | 'platform'
  | 'device'
  | 'devices'
  | 'avd'
  | 'simulator'
  | 'apk'
  | 'app'
  | 'package'
  | 'activity'
  | 'agentApk'
  | 'agentTestApk'
  | 'iosXctestrun'
  | 'deviceStrategy'
  | 'launchEmulators'
  | 'resetAppDeepLink'
  | 'resetAppWaitMs'
  | 'appReset'
  | 'appResetScope'
  | 'appResetColdEvery'
  | 'doubleTapInterval'
  | 'baseURL'
  | 'extraHTTPHeaders'
>> & {
  /**
   * Path to a saved app state archive (created by `device.saveAppState()`).
   * When set, the runner restores this state before running tests in the scope,
   * mirroring Playwright's `storageState` pattern for reusable auth.
   */
  appState?: string;
}

/**
 * Merge a project's `use` options over the root config to produce the
 * effective configuration for running that project's tests. Undefined
 * project values are skipped so they don't clobber root defaults.
 */
export function effectiveConfigForProject(
  config: TapsmithConfig,
  project: { use?: UseOptions } | undefined,
): TapsmithConfig {
  if (!project?.use) return config;
  const merged = { ...config } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(project.use)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return applyConfigDefaults(merged as unknown as TapsmithConfig, project.use);
}

// ─── Projects ───

export interface ProjectConfig {
  /** Unique project name, used for dependency references and reporter output. */
  name: string;
  /** Glob patterns for test file discovery. Inherits global `testMatch` if unset. */
  testMatch?: string[];
  /** Glob patterns to exclude from test file discovery. */
  testIgnore?: string[];
  /** Projects that must complete successfully before this project runs. */
  dependencies?: string[];
  /** Per-project option overrides applied as a base layer under file-level `test.use()`. */
  use?: UseOptions;
  /**
   * Number of parallel workers (devices) for this project. When unset,
   * the global `workers` budget is split proportionally across projects
   * that don't specify a count. Explicit values are additive — they don't
   * consume from the global budget.
   *
   * @example
   * projects: [
   *   { name: 'android', workers: 2, use: { platform: 'android', avd: 'Pixel_6' } },
   *   { name: 'ios',     workers: 1, use: { platform: 'ios', simulator: 'iPhone 16' } },
   * ]
   */
  workers?: number;
  /**
   * Per-project grep filter, intersected with the root `grep`. Mirrors
   * Playwright's per-project `grep`.
   */
  grep?: RegExp | RegExp[];
  /**
   * Per-project grep-invert filter, unioned with the root `grepInvert`.
   * Mirrors Playwright's per-project `grepInvert`.
   */
  grepInvert?: RegExp | RegExp[];
}

const DEFAULT_CONFIG: TapsmithConfig = {
  timeout: 30_000,
  retries: 0,
  screenshot: 'only-on-failure',
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  daemonAddress: 'localhost:50051',
  rootDir: process.cwd(),
  outputDir: 'tapsmith-results',
  workers: 1,
  launchEmulators: false,
};

/**
 * Drop keys whose value is explicitly `undefined` so spread-merging cannot
 * clobber defaults — `{ ...DEFAULT_CONFIG, ...raw }` would otherwise turn
 * e.g. `defineConfig({ retries: maybeUndefined })` into `retries: undefined`,
 * which downstream code typed as `number` cannot handle (the runner's retry
 * loop `attempt <= retries` would never execute).
 */
function omitUndefined<T extends object>(raw: T): T {
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Define a Tapsmith configuration. Merges the provided overrides with defaults.
 */
export function defineConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  const clean = omitUndefined(overrides);
  const merged = applyConfigDefaults({ ...DEFAULT_CONFIG, ...clean }, clean);
  withExplicitRootDir(merged, clean.rootDir !== undefined);
  return withExplicitWorkers(merged, clean.workers !== undefined);
}

function applyConfigDefaults(
  config: TapsmithConfig,
  raw: Partial<TapsmithConfig>,
): TapsmithConfig {
  if (raw.launchEmulators === undefined && raw.avd) {
    config.launchEmulators = true;
  }
  validateAppResetOptions(raw);
  validateRecordingModes(raw);
  validateUiOptions(raw);
  validateDevicesOption(raw);
  return config;
}

// ─── Device groups ───

/** Name given to the members of a `devices: N` group. */
function defaultDeviceName(index: number): string {
  return `device-${index + 1}`;
}

/**
 * The largest device group a project may declare. The UI-mode and watch-mode
 * port allocators give each worker a band of 10 member ports
 * (`memberPorts()`), so an 11th member would collide with the next worker's
 * first — and no hosted runner drives more devices than this at usable speed.
 */
export const MAX_DEVICE_GROUP_SIZE = 10;

/**
 * Reject malformed `devices` values at load time, naming the accepted shapes,
 * instead of letting a typo provision a wrong-sized group. Shared by root
 * config loading and project `use` (via `effectiveConfigForProject`).
 */
export function validateDevicesOption(
  options: Pick<Partial<TapsmithConfig>, 'devices'>,
  source = 'config',
): void {
  const devices = options.devices;
  if (devices === undefined) return;
  if (typeof devices === 'number') {
    if (!Number.isInteger(devices) || devices < 1) {
      throw new Error(`${source}: devices must be a positive integer or an array of { name, device? } entries (got ${JSON.stringify(devices)})`);
    }
    if (devices > MAX_DEVICE_GROUP_SIZE) {
      throw new Error(`${source}: devices must be at most ${MAX_DEVICE_GROUP_SIZE} (got ${devices})`);
    }
    return;
  }
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(`${source}: devices must be a positive integer or a non-empty array of { name, device? } entries (got ${JSON.stringify(devices)})`);
  }
  if (devices.length > MAX_DEVICE_GROUP_SIZE) {
    throw new Error(`${source}: devices may declare at most ${MAX_DEVICE_GROUP_SIZE} members (got ${devices.length})`);
  }

  const names = new Set<string>();
  const serials = new Set<string>();
  for (const [i, entry] of devices.entries()) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new Error(`${source}: devices[${i}] must be an object with a non-empty string \`name\` (got ${JSON.stringify(entry)})`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) {
      throw new Error(`${source}: devices[${i}].name "${entry.name}" may only contain letters, digits, '-' and '_' (it names trace and screenshot files)`);
    }
    if (names.has(entry.name)) {
      throw new Error(`${source}: devices[${i}].name "${entry.name}" is used by another entry; names must be unique within the group`);
    }
    names.add(entry.name);
    if (entry.device !== undefined) {
      if (typeof entry.device !== 'string' || entry.device.trim() === '') {
        throw new Error(`${source}: devices[${i}].device must be a non-empty serial / UDID when set (got ${JSON.stringify(entry.device)})`);
      }
      if (serials.has(entry.device)) {
        throw new Error(`${source}: devices[${i}].device "${entry.device}" is pinned by another entry; one device cannot serve two members`);
      }
      serials.add(entry.device);
    }
  }
}

/**
 * The device group a config declares, normalised to named entries with the
 * primary first. A config without `devices` is a group of one whose primary
 * is `config.device` (when pinned). `config.device` also pins the primary of
 * an explicit group whose first entry leaves `device` unset, so
 * `--device <serial>` keeps meaning "run the primary on this device".
 */
export function resolveDeviceGroup(
  config: Pick<TapsmithConfig, 'devices' | 'device'>,
): DeviceGroupEntry[] {
  const devices = config.devices;
  let entries: DeviceGroupEntry[];
  if (devices === undefined) {
    entries = [{ name: defaultDeviceName(0) }];
  } else if (typeof devices === 'number') {
    entries = Array.from({ length: devices }, (_, i) => ({ name: defaultDeviceName(i) }));
  } else {
    entries = devices.map((e) => ({ name: e.name, ...(e.device ? { device: e.device } : {}) }));
  }
  if (entries[0] && !entries[0].device && config.device) {
    entries[0] = { ...entries[0], device: config.device };
  }
  return entries;
}

/**
 * The serial the primary device is pinned to, if any.
 *
 * The primary is the group's first member, so its pin is that entry's
 * `device` — with root `device` (and `--device`) as the fallback that
 * {@link resolveDeviceGroup} already folds in. Every embedder that picks the
 * primary must read it from here rather than from `config.device`: the two
 * that read `config.device` directly honoured `bob`'s pin and silently
 * auto-picked `alice`'s, the exact shape `docs/multi-device.md` documents.
 */
export function primaryDevicePin(config: Pick<TapsmithConfig, 'devices' | 'device'>): string | undefined {
  return resolveDeviceGroup(config)[0]?.device;
}

/**
 * Every serial the config's device group pins, primary first — root `device`
 * (and so `--device`) included, via {@link resolveDeviceGroup}.
 *
 * A pinned device can host exactly one worker, so any pin fixes its target to
 * a single worker. Every embedder that sizes a worker pool asks this rather
 * than checking one kind of pin: checking only the members' let the parallel
 * dispatcher and watch mode spread a `--device` run across other devices.
 */
export function pinnedDeviceSerials(config: Pick<TapsmithConfig, 'devices' | 'device'>): string[] {
  return resolveDeviceGroup(config).flatMap((e) => (e.device ? [e.device] : []));
}

/**
 * The member names of a `use.devices` project (`['alice', 'bob']`), or
 * `undefined` for a single-device project. What MCP consumers see beside a
 * project so they know its tests need a group and which names the device
 * tools accept.
 */
export function deviceGroupNames(config: Pick<TapsmithConfig, 'devices' | 'device'>): string[] | undefined {
  if (deviceGroupSize(config) <= 1) return undefined;
  return resolveDeviceGroup(config).map((d) => d.name);
}

/** Number of devices every test of this config drives (1 without `devices`). */
export function deviceGroupSize(config: Pick<TapsmithConfig, 'devices'>): number {
  const devices = config.devices;
  if (devices === undefined) return 1;
  return typeof devices === 'number' ? devices : devices.length;
}

/**
 * The device each *member* of a group (every entry after the primary) runs
 * on: a pinned member keeps its `device`, an unpinned one takes the next
 * device of `pool` that is neither the primary nor pinned elsewhere, in
 * declaration order. Returns `undefined` when the pool cannot fill every
 * unpinned member.
 *
 * Every embedder that turns a provisioned device list into a group goes
 * through here, so a partially pinned group (`[{name:'a'}, {name:'b',
 * device:'X'}, {name:'c'}]`) resolves the same way sequentially, in parallel
 * workers and per bucket — two of those used to drop the unpinned members.
 */
export function assignGroupMemberDevices(
  group: DeviceGroupEntry[],
  primary: string | undefined,
  pool: string[],
): string[] | undefined {
  const pinned = new Set(group.flatMap((e) => (e.device ? [e.device] : [])));
  const free = pool.filter((s) => s !== primary && !pinned.has(s));
  let next = 0;
  const serials: string[] = [];
  for (const member of group.slice(1)) {
    const serial = member.device ?? free[next++];
    if (serial === undefined) return undefined;
    serials.push(serial);
  }
  return serials;
}

/** Fail fast on malformed `ui` config values instead of silently ignoring them. */
function validateUiOptions(raw: Partial<TapsmithConfig>): void {
  if (raw.telemetry !== undefined && typeof raw.telemetry !== 'boolean') {
    // A string `'false'` would read as opted-in; refuse rather than guess.
    throw new Error(`config: telemetry must be a boolean (got ${JSON.stringify(raw.telemetry)})`);
  }
  if (raw.ui === undefined) return;
  if (raw.ui.prepareBetweenRuns !== undefined && typeof raw.ui.prepareBetweenRuns !== 'boolean') {
    throw new Error(`config: ui.prepareBetweenRuns must be a boolean (got ${JSON.stringify(raw.ui.prepareBetweenRuns)})`);
  }
  if (raw.ui.prepareDelayMs !== undefined
    && (!Number.isInteger(raw.ui.prepareDelayMs) || raw.ui.prepareDelayMs < 0)) {
    throw new Error(`config: ui.prepareDelayMs must be a non-negative integer (got ${JSON.stringify(raw.ui.prepareDelayMs)})`);
  }
}

/**
 * Reject an unknown `trace` / `video` mode, in its string or `{ mode }` form.
 * An unknown mode used to record nothing without a word (PILOT-254): a CI
 * pipeline with a typo looked healthy until someone needed a failure trace.
 * Shared by config loading, project `use`, and `test.use()`.
 */
// The trace/video modes, mirrored from TRACE_MODES / VIDEO_MODES rather than
// imported: config.ts keeps its local imports type-only so it loads under
// plain Node type stripping (config.test.ts runs it that way). The checks
// below stop compiling if this list and either type drift apart.
const RECORDING_MODES = [
  'off',
  'on',
  'on-first-retry',
  'on-all-retries',
  'retain-on-failure',
  'retain-on-first-failure',
  'retain-on-failure-and-retries',
] as const;
type RecordingMode = (typeof RECORDING_MODES)[number];
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _traceModesMatch: SameUnion<TraceMode, RecordingMode> = true;
const _videoModesMatch: SameUnion<VideoMode, RecordingMode> = true;
void _traceModesMatch;
void _videoModesMatch;

export function validateRecordingModes(
  options: Pick<Partial<TapsmithConfig>, 'trace' | 'video'>,
  source = 'config',
): void {
  const modes: readonly string[] = RECORDING_MODES;
  for (const key of ['trace', 'video'] as const) {
    const value: unknown = options[key];
    if (value == null) continue;
    const mode: unknown = typeof value === 'object' ? (value as { mode?: unknown }).mode : value;
    if (mode === undefined && typeof value === 'object') continue;
    if (typeof mode !== 'string' || !modes.includes(mode)) {
      throw new Error(
        `${source}: ${key} must be one of ${modes.map((m) => `'${m}'`).join(', ')} (got ${JSON.stringify(mode)})`,
      );
    }
  }
}

/**
 * Reject unknown `appReset` / `appResetScope` literals. Shared by config
 * loading, project `use`, and `test.use()` so a typo fails fast with the
 * accepted values instead of silently falling back to a default.
 */
export function validateAppResetOptions(
  options: Pick<Partial<TapsmithConfig>, 'appReset' | 'appResetScope' | 'appResetColdEvery'>,
  source = 'config',
): void {
  if (options.appResetColdEvery !== undefined
    && (!Number.isInteger(options.appResetColdEvery) || options.appResetColdEvery < 0)) {
    throw new Error(`${source}: appResetColdEvery must be a non-negative integer (got ${JSON.stringify(options.appResetColdEvery)})`);
  }
  if (options.appReset !== undefined && !APP_RESET_MODES.includes(options.appReset)) {
    throw new Error(
      `${source}: appReset must be one of ${APP_RESET_MODES.map((m) => `'${m}'`).join(', ')} (got ${JSON.stringify(options.appReset)})`,
    );
  }
  if (options.appResetScope !== undefined && !APP_RESET_SCOPES.includes(options.appResetScope)) {
    throw new Error(
      `${source}: appResetScope must be one of ${APP_RESET_SCOPES.map((s) => `'${s}'`).join(', ')} (got ${JSON.stringify(options.appResetScope)})`,
    );
  }
}

/**
 * Normalize a `grep` / `grepInvert` value (RegExp, RegExp[], or undefined)
 * into a plain RegExp[]. Returns an empty array when undefined.
 */
export function normalizeGrep(value: RegExp | RegExp[] | undefined): RegExp[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolve the effective device selection strategy for a config.
 * When an AVD is configured, default to using only that AVD unless the user
 * explicitly opts back into preferring already-connected devices.
 */
export function resolveDeviceStrategy(
  config: Pick<TapsmithConfig, 'deviceStrategy' | 'avd'>,
): DeviceStrategy {
  if (config.deviceStrategy) {
    return config.deviceStrategy;
  }
  return config.avd ? 'avd-only' : 'prefer-connected';
}

/**
 * Load tapsmith.config.ts from the given directory (or cwd). Falls back to
 * defaults if no config file exists.
 */
/**
 * Hidden symbol marking whether `workers` was explicitly set by the user
 * (in the config file or via CLI). Used by the multi-bucket budget warning
 * to distinguish "user asked for N" from "default of 1".
 */
export const EXPLICIT_WORKERS = Symbol.for('tapsmith.explicitWorkers');

/** Set when a config file itself pinned `rootDir`, as opposed to inheriting the default. */
export const EXPLICIT_ROOT_DIR = Symbol.for('tapsmith.explicitRootDir');

function withExplicitRootDir(config: TapsmithConfig, explicit: boolean): void {
  Object.defineProperty(config, EXPLICIT_ROOT_DIR, {
    value: explicit,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

function withExplicitWorkers(config: TapsmithConfig, explicit: boolean): TapsmithConfig {
  Object.defineProperty(config, EXPLICIT_WORKERS, {
    value: explicit,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return config;
}

export function isExplicitWorkers(config: TapsmithConfig): boolean {
  return (config as unknown as Record<symbol, boolean>)[EXPLICIT_WORKERS] === true;
}

/**
 * A user's raw config was "explicit" about workers if either (a) it went
 * through `defineConfig` which stamped the EXPLICIT_WORKERS symbol, or (b)
 * it's a plain object literal that directly set `workers`.
 *
 * Subtlety: we must check whether the symbol is *present* on `raw`, not
 * just its value. `defineConfig()` without a `workers` override stamps the
 * symbol to `false` AND populates `raw.workers = 1` from the default merge.
 * A naive `symbolValue || workers !== undefined` check would then treat
 * every `defineConfig({})` without a workers field as explicit — reintroducing
 * the spurious budget warning the symbol was designed to prevent.
 *
 * So: if the symbol is present at all on `raw`, trust its value (defineConfig
 * already did the right thing). Only fall back to "workers is defined on
 * raw" when the symbol is missing entirely — meaning the user exported a
 * raw object literal instead of using defineConfig.
 */
function rawHasExplicitWorkers(raw: Partial<TapsmithConfig>): boolean {
  const symbolPresent = Object.getOwnPropertySymbols(raw).includes(EXPLICIT_WORKERS);
  if (symbolPresent) return isExplicitWorkers(raw as TapsmithConfig);
  return raw.workers !== undefined;
}

/**
 * Whether the user actually wrote `rootDir` in their config.
 *
 * `defineConfig` merges DEFAULT_CONFIG, which fills `rootDir` with the
 * *loading* process's cwd — so by the time `loadConfig` sees the object, a
 * config that never mentioned rootDir is indistinguishable from one that
 * pinned it, and `raw.rootDir ?? root` always kept cwd. That silently
 * overrode the root the caller asked for: an MCP server started in a repo
 * root, loading a config discovered in a subdirectory, swept the whole repo
 * (including the SDK's own unit tests) instead of that subdirectory.
 *
 * Same subtlety as EXPLICIT_WORKERS: check for the symbol's *presence*, since
 * `defineConfig` stamps it false while still populating `rootDir` from the
 * defaults. Only fall back to "rootDir is set" for raw object literals that
 * never went through `defineConfig`.
 */
function rawHasExplicitRootDir(raw: Partial<TapsmithConfig>): boolean {
  // Every config this module hands out carries the symbol, so the fallback
  // below only ever sees an object literal from a config file — never one of
  // our own results fed back in, whose concrete rootDir would otherwise read
  // as a deliberate pin and override the root its new caller asked for.
  const symbolPresent = Object.getOwnPropertySymbols(raw).includes(EXPLICIT_ROOT_DIR);
  if (symbolPresent) return (raw as unknown as Record<symbol, boolean>)[EXPLICIT_ROOT_DIR] === true;
  return raw.rootDir !== undefined;
}

/**
 * The root a loaded config's relative paths are anchored to: what the caller
 * asked for, unless the config pinned `rootDir` itself.
 *
 * Deliberately NOT the config file's own directory. `tapsmith test -c
 * configs/ci.config.ts` has always discovered tests relative to the working
 * directory, and re-anchoring to `configs/` would find none — a green-to-red
 * change for every project whose config does not sit where it is invoked
 * from. Callers that do want the config's directory as the root pass it in
 * (see `loadMcpConfig`).
 */
function resolveRootDir(raw: Partial<TapsmithConfig>, root: string): string {
  return rawHasExplicitRootDir(raw) && raw.rootDir ? path.resolve(root, raw.rootDir) : root;
}

export const CONFIG_CANDIDATES = ['tapsmith.config.ts', 'tapsmith.config.js', 'tapsmith.config.mjs'];

/**
 * The config file `loadConfig(dir, configFile)` would read, or undefined when
 * it would fall back to built-in defaults. Callers that report which config
 * backs a session need this: `loadConfig` returns the merged config only, so
 * without it a synthesized default is indistinguishable from a real project.
 */
/** Set to the config file a loaded config was actually read from. */
export const CONFIG_PATH = Symbol.for('tapsmith.configPath');

function withConfigPath(config: TapsmithConfig, configPath?: string): TapsmithConfig {
  Object.defineProperty(config, CONFIG_PATH, {
    value: configPath,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return config;
}

/**
 * The file a config was read from, or undefined for built-in defaults.
 *
 * Undefined means no config file exists: `loadConfig` rejects when one exists
 * but cannot be imported, so a config this returns undefined for was never
 * backed by a file (PILOT-262).
 */
export function configPathOf(config: TapsmithConfig): string | undefined {
  return (config as unknown as Record<symbol, string | undefined>)[CONFIG_PATH];
}

/** tsx fallback imports run one at a time; see `importConfigModule`. */
let configImportQueue: Promise<unknown> = Promise.resolve();

/**
 * Failures of the process's own loader, as opposed to the config running and
 * throwing — each one something tsx handles and bare Node does not: a
 * specifier it cannot resolve (`./helpers.js` for `helpers.ts`, a directory
 * import), TypeScript it cannot strip (an `enum`, a `.ts` file inside
 * node_modules), an extension it does not know, a JSON import without its
 * `type` attribute. Raised by a static import, they come before any of the
 * config's code runs; raised by a dynamic import or `require` while it runs,
 * the retry evaluates the config a second time — as `tapsmith test` always
 * has, parent and tsx child each evaluating it — and the stack cannot tell
 * the two apart, so they are treated alike.
 */
const LOADER_ERROR_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNKNOWN_MODULE_FORMAT',
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  'ERR_INVALID_TYPESCRIPT_SYNTAX',
  'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
  'ERR_IMPORT_ATTRIBUTE_MISSING',
  'ERR_IMPORT_ASSERTION_TYPE_MISSING',
  'ERR_REQUIRE_ESM',
]);

function isLoaderError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && LOADER_ERROR_CODES.has(code)) return true;
  // Node strips a `.ts` config's types and, finding `import`/`export`, runs it
  // as ESM even in a package without `"type": "module"`, where tsx compiles
  // it to CommonJS and `__dirname`/`require` exist. The config has started
  // running by then — as it always did in `tapsmith test`'s bare parent
  // before the tsx child ran it again.
  if (err instanceof ReferenceError && /is not defined in ES module scope/.test(err.message)) return true;
  // A SyntaxError is a parse or link failure only when Node's loader threw
  // it: the first located frame is a compile or link step. One the config
  // raised while running (`JSON.parse` of a bad file, read or required; a bad
  // `RegExp` or `vm` script) starts elsewhere, and retrying it through tsx
  // would run the config's side effects a second time.
  return err instanceof SyntaxError && firstStackFrameIsCompileStep(err);
}

// The ESM and CommonJS compile steps, and ESM linking (a named import the
// target does not export — a type-only import, which tsx elides).
const COMPILE_STEP_FRAME = /^(?:compileSourceTextModule|wrapSafe|compileFunctionForCJSLoader|#?(?:async)?[Ii]nstantiate|ModuleJob\.#?_?(?:async)?[Ii]nstantiate|ModuleJob\.(?:sync)?[Ll]ink|ModuleJobSync\.\w+) \(node:/;

function firstStackFrameIsCompileStep(err: Error): boolean {
  for (const line of (err.stack ?? '').split('\n')) {
    const frame = /^\s+at (?:async )?(.*)$/.exec(line);
    if (!frame) continue;
    // Builtins such as `JSON.parse` report no location; the next frame is
    // whoever called them.
    if (/\((?:<anonymous>|native)\)$/.test(frame[1])) continue;
    return COMPILE_STEP_FRAME.test(frame[1]);
  }
  return false;
}

/**
 * Import a config file, rejecting with an error that names it.
 *
 * Natively first, exactly as before, so a config the process can import
 * shares its module instances (the SDK included) with the process. Only when
 * the process's loader cannot handle it does the import go through tsx. The
 * CLI loads the config before it re-execs under tsx, and bare Node cannot
 * import every valid config: a TypeScript one with a `./helpers.js`
 * specifier for `helpers.ts` or an `enum`, or a JavaScript one that imports a
 * TypeScript helper. The old warn-and-use-defaults fallback hid that, and
 * with a load failure now fatal it would break those configs outright. A
 * config that ran and threw is reported as it is, not run a second time.
 *
 * The fallback registers tsx's ESM and CommonJS hooks for the duration of the
 * import — what the `tsx` binary does, and CommonJS is what tsx compiles a
 * TypeScript config to in a package without `"type": "module"`. The config
 * is imported under a fresh URL, so it and anything it imports through tsx
 * are separate module instances from the process's: nothing may rely on
 * identity between config values and the process's modules beyond the
 * `Symbol.for` markers used here. tsx's namespaced registration would scope
 * the hooks more tightly, but from tsx 4.23 it cannot load a CommonJS-compiled
 * config at all. Node cannot remove a `module.register` hook, so each
 * fallback load leaves one deactivated hook behind; fallback loads are rare
 * and few per process. Fallback loads are serialised because the hooks are
 * process-global: two overlapping ones would each restore the other's
 * half-registered state. A load started from inside one (a config calling
 * `loadConfig`) runs within it rather than queueing behind it.
 *
 * Validation errors raised after the import (by `applyConfigDefaults`) already
 * say what is wrong and propagate as they are, and so does a failure to load
 * tsx itself, which is not the config's fault.
 */
/**
 * Set while a tsx fallback load runs: a config that calls `loadConfig` itself
 * (one config extending another) must not queue behind its own load.
 */
const insideFallbackLoad = new AsyncLocalStorage<true>();

async function importConfigModule(configPath: string): Promise<Record<string, unknown>> {
  let nativeError: unknown;
  try {
    // Not queued: a native import that runs while another load's tsx hooks
    // are registered is compiled by them, and `unwrapCommonJsConfig` gives
    // the same result either way.
    return unwrapCommonJsConfig((await import(pathToFileURL(configPath).href)) as Record<string, unknown>);
  } catch (err) {
    // Every loader failure is retried: whether tsx can get past one (an
    // extensionless require of a `.ts` file, a tsconfig `paths` alias) cannot
    // be told from Node's error, and a valid config failing is worse than an
    // invalid one being evaluated a second time before it fails — which
    // `tapsmith test` has always done, in its bare parent and its tsx child.
    if (!isLoaderError(err)) throw configLoadError(configPath, err);
    nativeError = err;
  }
  if (insideFallbackLoad.getStore()) return importConfigModuleWithTsx(configPath, nativeError);
  const result = configImportQueue.then(() =>
    insideFallbackLoad.run(true, () => importConfigModuleWithTsx(configPath, nativeError)));
  configImportQueue = result.catch(() => undefined);
  return result;
}

/**
 * A config compiled to CommonJS — by tsx in a package without
 * `"type": "module"`, or ahead of time (`exports.__esModule = true;
 * exports.default = …`) — comes back with the whole `module.exports` as the
 * namespace's `default`: the `__esModule`-marked object whose own `default`
 * is the config. The tsx binary unwraps that itself; Node and tsx's
 * in-process hooks do not.
 */
function unwrapCommonJsConfig(mod: Record<string, unknown>): Record<string, unknown> {
  const exportsObject = mod.default as { __esModule?: unknown } | undefined;
  if (exportsObject && typeof exportsObject === 'object' && exportsObject.__esModule === true) {
    return exportsObject as Record<string, unknown>;
  }
  return mod;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The rejection for a config that could not be imported. When the tsx retry
 * failed too, Node's own error rides along: either one can be the actionable
 * one (tsx's for a config that runs and throws; Node's for a mistyped import
 * that tsx then trips over something else on).
 */
function configLoadError(configPath: string, err: unknown, nativeError?: unknown, note?: string): Error {
  let detail = errorMessage(err);
  if (nativeError !== undefined && errorMessage(nativeError) !== detail && isUnresolvedForTsxToo(nativeError)) {
    detail += `\n(Without tsx, Node reported: ${errorMessage(nativeError)})`;
  }
  if (note) detail += `\n(${note})`;
  const error = new Error(`Failed to load config file ${configPath}: ${detail}`, { cause: err });
  // Callers print `stack`, which never includes `cause`: without this the
  // trace shows Tapsmith's loader frames and not the line in the config.
  const causeStack = err instanceof Error ? err.stack : undefined;
  if (causeStack) error.stack = `${error.name}: ${error.message}\nCaused by: ${causeStack}`;
  return error;
}

/**
 * Whether Node's error names an import tsx could not resolve either — the
 * one kind of native failure worth showing beside tsx's own error. Anything
 * else (TypeScript it cannot strip, an extension it does not know) only says
 * why tsx was needed, and next to the config's own error it misleads. So does
 * a `./helpers.js` that tsx resolved to `helpers.ts`.
 */
function isUnresolvedForTsxToo(nativeError: unknown): boolean {
  const { code, url } = nativeError as { code?: unknown; url?: unknown };
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  if (typeof url !== 'string' || !url.startsWith('file:')) return true;
  const missing = fileURLToPath(url);
  const stem = missing.replace(/\.[cm]?jsx?$/, '');
  return !['.ts', '.tsx', '.mts', '.cts'].some((ext) => fs.existsSync(stem + ext));
}

async function importConfigModuleWithTsx(configPath: string, nativeError: unknown): Promise<Record<string, unknown>> {
  let esm: typeof import('tsx/esm/api');
  let cjs: typeof import('tsx/cjs/api');
  try {
    [esm, cjs] = await Promise.all([import('tsx/esm/api'), import('tsx/cjs/api')]);
  } catch (tsxError) {
    // Not the config's fault, but the config's own error is still the one to
    // show: the retry that might have got past it could not start.
    throw configLoadError(configPath, nativeError, undefined, `tsx, which could have loaded it, failed to start: ${errorMessage(tsxError)}`);
  }
  // tsx's CJS unregister deletes the `.ts`/`.tsx`/`.jsx`/`.mjs` handlers it
  // replaced instead of restoring them, so in a process already running under
  // tsx it would strip tsx's own handlers and break later extensionless
  // requires of TypeScript files. Undo exactly what the registration did,
  // leaving any handler the config itself installed while loading.
  const extensions = createRequire(import.meta.url).extensions;
  // Descriptors, not a spread: tsx installs `.mjs` non-enumerable.
  const before = Object.getOwnPropertyDescriptors(extensions);
  let installed: typeof before = before;
  let unregisterCjs: (() => void) | undefined;
  let unregisterEsm: (() => Promise<void>) | undefined;
  try {
    unregisterCjs = cjs.register();
    installed = Object.getOwnPropertyDescriptors(extensions);
    unregisterEsm = esm.register();
    // A query gives the config a URL the failed native attempt did not leave
    // in the ESM cache; without it Node replays that failure. Only the config
    // itself gets one: a module it imports that Node evaluated and that threw
    // (a `.ts` helper using `__dirname`, run as ESM) stays cached as failed.
    // tsx's namespaced API would re-key the whole graph, but it cannot load a
    // CommonJS-compiled config (tsx 4.23) or hook a CommonJS config's own
    // `require` calls. The config sees the query in `import.meta.url`
    // (`fileURLToPath` and `import.meta.dirname` are unaffected).
    const url = `${pathToFileURL(configPath).href}?tapsmith-config=${Date.now()}`;
    const mod = (await import(url)) as Record<string, unknown>;
    return unwrapCommonJsConfig(mod);
  } catch (err) {
    throw configLoadError(configPath, err, nativeError);
  } finally {
    unregisterCjs?.();
    await unregisterEsm?.();
    for (const key of Object.keys(installed)) {
      const tsxValue = installed[key]?.value;
      const previous = before[key];
      if (tsxValue === previous?.value) continue;
      const current = Object.getOwnPropertyDescriptor(extensions, key)?.value;
      // Changed since registration by someone other than tsx: leave it.
      if (current !== undefined && current !== tsxValue && current !== previous?.value) continue;
      if (previous) Object.defineProperty(extensions, key, previous);
      else delete extensions[key];
    }
  }
}

export async function loadConfig(dir?: string, configFile?: string): Promise<TapsmithConfig> {
  const root = dir ?? process.cwd();

  if (configFile) {
    const configPath = path.resolve(root, configFile);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const mod = await importConfigModule(configPath);
    // Keep the original for rawHasExplicitWorkers — omitUndefined produces a
    // fresh object, dropping the non-enumerable EXPLICIT_WORKERS symbol that
    // defineConfig-produced configs carry.
    const original: Partial<TapsmithConfig> = mod.default ?? mod;
    const raw = omitUndefined(original);
    const merged = applyConfigDefaults(
      { ...DEFAULT_CONFIG, ...raw, rootDir: resolveRootDir(original, root) },
      raw,
    );
    withExplicitRootDir(merged, rawHasExplicitRootDir(original));
    withConfigPath(merged, configPath);
    return withExplicitWorkers(merged, rawHasExplicitWorkers(original));
  }

  for (const name of CONFIG_CANDIDATES) {
    const configPath = path.resolve(root, name);
    if (fs.existsSync(configPath)) {
      // The first candidate that exists is the config, loadable or not. A
      // broken one is a hard error, never a reason to try the next candidate
      // or fall back to the defaults: either would run the session under a
      // config the user is not editing (PILOT-262).
      const mod = await importConfigModule(configPath);
      const original: Partial<TapsmithConfig> = (mod.default as Partial<TapsmithConfig>) ?? mod;
      const raw = omitUndefined(original);
      const merged = applyConfigDefaults(
        { ...DEFAULT_CONFIG, ...raw, rootDir: resolveRootDir(original, root) },
        raw,
      );
      withExplicitRootDir(merged, rawHasExplicitRootDir(original));
      withConfigPath(merged, configPath);
      return withExplicitWorkers(merged, rawHasExplicitWorkers(original));
    }
  }

  const defaults: TapsmithConfig = { ...DEFAULT_CONFIG, rootDir: root };
  withExplicitRootDir(defaults, false);
  withConfigPath(defaults, undefined);
  return withExplicitWorkers(defaults, false);
}
