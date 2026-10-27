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
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { distance as levenshtein } from 'fastest-levenshtein';
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
/** `macos` is experimental: this Mac, sequential `tapsmith test` only. */
export type Platform = 'android' | 'ios' | 'macos';
/**
 * Whether a config targets Android, which an unset `platform` always has.
 * Say this rather than `platform !== 'ios'`: with macOS that no longer means
 * Android, and a Mac would run adb work against a device adb doesn't know.
 */
export function isAndroid(platform: Platform | undefined): boolean {
  return (platform ?? 'android') === 'android';
}

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
   *   testMatch: ['**\/multi-user/**'],
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
   * How Tapsmith launches the emulators it boots for `avd` (Android). Only
   * applies to emulators Tapsmith launches, not ones you start yourself.
   * Root-level only: projects on one device target share its emulators.
   */
  emulatorLaunchOptions?: EmulatorLaunchOptions;

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
  // Root-level only: projects on one device target share its emulators, so a
  // per-project value could not be honoured consistently.
  if ('emulatorLaunchOptions' in project.use) {
    throw invalid('config', 'emulatorLaunchOptions is a root-level option; move it out of the project\'s `use`.');
  }
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

/** `emulatorLaunchOptions` in the config — mirrors Playwright's `launchOptions`. */
export interface EmulatorLaunchOptions {
  /**
   * Run without a window. Defaults to `false` locally: the emulator opens a
   * window, keeps the AVD's GPU setting and quick-boots from the AVD's snapshot, which
   * is much faster than a headless cold boot. `true` runs it headless (no
   * window, software GPU, cold boot). Always headless in CI, over
   * SSH, or on Linux with no display.
   */
  headless?: boolean;
  /**
   * Extra arguments for the `emulator` command, added after Tapsmith's own.
   * `-avd`/`@name`, `-port`/`-ports` and `-read-only` are refused: Tapsmith
   * sets the AVD, console port and read-only mode itself.
   */
  args?: string[];
}

/** Emulator flags that would change what Tapsmith sets and relies on: the AVD, console port, read-only mode. */
const RESERVED_EMULATOR_ARGS = ['-avd', '-port', '-ports', '-read-only'];

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

// ─── Validation errors (PILOT-552) ───

/**
 * A config key or value Tapsmith refuses. Configs run through tsx without
 * type-checking, so everything `TapsmithConfig`'s types promise is checked
 * again at load, as Playwright does: the error names the file and each bad
 * key or value, and the run stops before doing any work.
 */
export class ConfigValidationError extends Error {
  readonly code = 'TAPSMITH_INVALID_CONFIG';
  /** Each problem, starting with the key it is about (`workers must be …`). */
  readonly issues: readonly string[];
  /** The config file, once the error has been traced to one. */
  readonly configPath: string | undefined;

  // No parameter properties: Node's type stripping cannot run them.
  constructor(issues: readonly string[], where: { source?: string; configPath?: string } = {}) {
    const body = issues.length === 1 ? ` ${issues[0]}` : issues.map((issue) => `\n  - ${issue}`).join('');
    super(where.configPath ? `Invalid config file ${where.configPath}:${body}` : `${where.source ?? 'config'}:${body}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
    this.configPath = where.configPath;
  }
}

/** By code, not class: the error may come from another copy of this module (a config loaded through tsx). */
export function isConfigValidationError(err: unknown): err is ConfigValidationError {
  return err instanceof Error && (err as { code?: unknown }).code === 'TAPSMITH_INVALID_CONFIG';
}

function invalid(source: string, issue: string): ConfigValidationError {
  return new ConfigValidationError([issue], { source });
}

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
  // Every problem at once, as loadConfig reports them: the per-key validators
  // below stop at the first, and a typo'd key would only surface after it.
  const issues = isPlainObject(overrides) ? configShapeIssues(overrides) : [];
  if (issues.length > 0) throw new ConfigValidationError(issues);
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
  validateEmulatorLaunchOptions(raw);
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
      throw invalid(source, `devices must be a positive integer or an array of { name, device? } entries (got ${JSON.stringify(devices)})`);
    }
    if (devices > MAX_DEVICE_GROUP_SIZE) {
      throw invalid(source, `devices must be at most ${MAX_DEVICE_GROUP_SIZE} (got ${devices})`);
    }
    return;
  }
  if (!Array.isArray(devices) || devices.length === 0) {
    throw invalid(source, `devices must be a positive integer or a non-empty array of { name, device? } entries (got ${JSON.stringify(devices)})`);
  }
  if (devices.length > MAX_DEVICE_GROUP_SIZE) {
    throw invalid(source, `devices may declare at most ${MAX_DEVICE_GROUP_SIZE} members (got ${devices.length})`);
  }

  const names = new Set<string>();
  const serials = new Set<string>();
  for (const [i, entry] of devices.entries()) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw invalid(source, `devices[${i}] must be an object with a non-empty string \`name\` (got ${JSON.stringify(entry)})`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) {
      throw invalid(source, `devices[${i}].name "${entry.name}" may only contain letters, digits, '-' and '_' (it names trace and screenshot files)`);
    }
    if (names.has(entry.name)) {
      throw invalid(source, `devices[${i}].name "${entry.name}" is used by another entry; names must be unique within the group`);
    }
    names.add(entry.name);
    if (entry.device !== undefined) {
      if (typeof entry.device !== 'string' || entry.device.trim() === '') {
        throw invalid(source, `devices[${i}].device must be a non-empty serial / UDID when set (got ${JSON.stringify(entry.device)})`);
      }
      if (serials.has(entry.device)) {
        throw invalid(source, `devices[${i}].device "${entry.device}" is pinned by another entry; one device cannot serve two members`);
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

function validateEmulatorLaunchOptions(raw: Partial<TapsmithConfig>): void {
  const options = raw.emulatorLaunchOptions;
  if (options === undefined) return;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalid('config', `emulatorLaunchOptions must be an object (got ${JSON.stringify(options)})`);
  }
  const unknown = Object.keys(options).filter((key) => key !== 'headless' && key !== 'args');
  if (unknown.length > 0) {
    throw invalid('config', `emulatorLaunchOptions has unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')} (expected headless, args)`);
  }
  if (options.headless !== undefined && typeof options.headless !== 'boolean') {
    throw invalid('config', `emulatorLaunchOptions.headless must be a boolean (got ${JSON.stringify(options.headless)})`);
  }
  if (options.args === undefined) return;
  if (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string')) {
    throw invalid('config', `emulatorLaunchOptions.args must be an array of strings (got ${JSON.stringify(options.args)})`);
  }
  // `@Name` is the emulator's shorthand for `-avd Name`, and it reads `--flag` as `-flag`.
  const reserved = options.args.filter((arg) => RESERVED_EMULATOR_ARGS.includes(arg.replace(/^--/, '-')) || arg.startsWith('@'));
  if (reserved.length > 0) {
    throw invalid(
      'config',
      `emulatorLaunchOptions.args must not include ${reserved.join(', ')}: Tapsmith sets the AVD, `
      + 'console port and read-only mode itself (use `avd` to choose the AVD).',
    );
  }
}

/** Fail fast on malformed `ui` config values instead of silently ignoring them. */
function validateUiOptions(raw: Partial<TapsmithConfig>): void {
  if (raw.telemetry !== undefined && typeof raw.telemetry !== 'boolean') {
    // A string `'false'` would read as opted-in; refuse rather than guess.
    throw invalid('config', `telemetry must be a boolean (got ${JSON.stringify(raw.telemetry)})`);
  }
  if (raw.ui === undefined) return;
  if (raw.ui.prepareBetweenRuns !== undefined && typeof raw.ui.prepareBetweenRuns !== 'boolean') {
    throw invalid('config', `ui.prepareBetweenRuns must be a boolean (got ${JSON.stringify(raw.ui.prepareBetweenRuns)})`);
  }
  if (raw.ui.prepareDelayMs !== undefined
    && (!Number.isInteger(raw.ui.prepareDelayMs) || raw.ui.prepareDelayMs < 0)) {
    throw invalid('config', `ui.prepareDelayMs must be a non-negative integer (got ${JSON.stringify(raw.ui.prepareDelayMs)})`);
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
    // false, null and '' have always meant off in untyped configs
    // (`CI ? 'on' : false`, `process.env.TRACE ?? 'off'` with an empty variable).
    if (value == null || value === false || value === '') continue;
    // Only a plain object is the `{ mode, … }` form; an array would resolve to off.
    const objectForm = typeof value === 'object' && !Array.isArray(value);
    const mode: unknown = objectForm ? (value as { mode?: unknown }).mode : value;
    if (objectForm && (mode == null || mode === false || mode === '')) continue;
    if (typeof mode !== 'string' || !modes.includes(mode)) {
      throw invalid(
        source,
        `${key} must be one of ${modes.map((m) => `'${m}'`).join(', ')} (got ${JSON.stringify(mode)})`,
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
    throw invalid(source, `appResetColdEvery must be a non-negative integer (got ${JSON.stringify(options.appResetColdEvery)})`);
  }
  if (options.appReset !== undefined && !APP_RESET_MODES.includes(options.appReset)) {
    throw invalid(
      source,
      `appReset must be one of ${APP_RESET_MODES.map((m) => `'${m}'`).join(', ')} (got ${JSON.stringify(options.appReset)})`,
    );
  }
  if (options.appResetScope !== undefined && !APP_RESET_SCOPES.includes(options.appResetScope)) {
    throw invalid(
      source,
      `appResetScope must be one of ${APP_RESET_SCOPES.map((s) => `'${s}'`).join(', ')} (got ${JSON.stringify(options.appResetScope)})`,
    );
  }
}

// ─── Config shape (PILOT-552) ───
//
// Every key a config file may set, with the check its value must pass. The
// tables are typed against `TapsmithConfig`, `UseOptions` and `ProjectConfig`,
// so a key added to one of them does not compile until it has a check here.

/** Checks one value; returns its issues, or undefined when the value is fine. `name` is the key's full path. */
type KeyCheck = (value: unknown, name: string) => string | string[] | undefined;

/** An object literal (or `Object.create(null)`): not an array, RegExp, Promise or function. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]' && typeof value === 'object';
}

function isRegExp(value: unknown): value is RegExp {
  // Not `instanceof`: a config can come from another realm or module copy.
  return Object.prototype.toString.call(value) === '[object RegExp]';
}

/** A value as the error shows it: `"iOS"`, `[/a/, "b"]`, `a function`. */
function describeValue(value: unknown): string {
  if (typeof value === 'function') return 'a function';
  // JSON would show NaN and Infinity as null, which reads as an explicit `null`.
  if (typeof value === 'number') return String(value);
  if (isRegExp(value)) return String(value);
  if (Array.isArray(value) && value.some(isRegExp)) return `[${value.map(describeValue).join(', ')}]`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The candidate `input` most likely meant: a case-insensitive match, else the
 * closest within a small edit distance (`timout` → `timeout`, `apkk` → `apk`).
 */
function suggestFrom(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  const sameCase = candidates.find((c) => c.toLowerCase() === lower);
  if (sameCase) return sameCase;
  const limit = Math.max(1, Math.min(2, Math.floor(input.length / 3)));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = levenshtein(lower, candidate.toLowerCase());
    if (d <= limit && d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function check(ok: (value: unknown) => boolean, expected: string, hint?: (value: unknown) => string | undefined): KeyCheck {
  return (value, name) => {
    if (ok(value)) return undefined;
    const extra = hint?.(value);
    return `${name} must be ${expected} (got ${describeValue(value)}${extra ? `; ${extra}` : ''})`;
  };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

const aString = check((v) => typeof v === 'string', 'a string');
/**
 * An optional path, name or serial. `null` means unset, as it always has
 * downstream: `device: process.env.DEVICE ?? null`. Other kinds of option
 * refuse `null` — their validators and defaults never accepted it.
 */
const optionalString = check((v) => v === null || typeof v === 'string', 'a string');
const aBoolean = check((v) => typeof v === 'boolean', 'a boolean');
const nonNegativeMs = check((v) => isFiniteNumber(v) && v >= 0, 'a non-negative number of milliseconds');
const positiveMs = check((v) => isFiniteNumber(v) && v > 0, 'a positive number of milliseconds');
const nonNegativeInteger = check((v) => Number.isInteger(v) && (v as number) >= 0, 'a non-negative integer');
const positiveInteger = check((v) => Number.isInteger(v) && (v as number) >= 1, 'a positive integer');
const globs = check(isStringArray, 'an array of glob strings', (v) => (typeof v === 'string' ? `wrap it: ['${v}']` : undefined));
/**
 * `null`, `false` and `''` mean "off" for options whose consumers have always
 * read any falsy value as unset (`reporter: CI && 'github'`,
 * `grep: GREP ? new RegExp(GREP) : null`), as for `trace` and `video`.
 */
function orOff(inner: KeyCheck): KeyCheck {
  return (value, name) => (value === null || value === false || value === '' ? undefined : inner(value, name));
}
const regExps = orOff(check((v) => isRegExp(v) || (Array.isArray(v) && v.every(isRegExp)), 'a RegExp or an array of RegExps'));

function oneOf(values: readonly string[]): KeyCheck {
  const listed = values.map((v) => `'${v}'`);
  const expected = values.length === 2 ? `${listed[0]} or ${listed[1]}` : `one of ${listed.join(', ')}`;
  return check(
    (v) => typeof v === 'string' && values.includes(v),
    expected,
    (v) => {
      const suggestion = typeof v === 'string' ? suggestFrom(v, values) : undefined;
      return suggestion ? `did you mean '${suggestion}'?` : undefined;
    },
  );
}

/** A reporter name, or `[name]` / `[name, options]`. */
function isReporterDescription(v: unknown): boolean {
  if (typeof v === 'string') return true;
  return Array.isArray(v) && typeof v[0] === 'string'
    // `['html', CI ? { open: 'never' } : undefined]`: every reporter defaults its options.
    && (v.length === 1 || (v.length === 2 && (v[1] === undefined || isPlainObject(v[1]))));
}

/**
 * Run one of the throwing validators above on a single key, so a project's
 * `use` gets exactly the root's checks and messages. Their issues start with
 * the key, which is swapped for its full path.
 */
function delegated(key: string, validate: (options: Partial<TapsmithConfig>) => void): KeyCheck {
  return (value, name) => {
    try {
      validate({ [key]: value } as Partial<TapsmithConfig>);
      return undefined;
    } catch (err) {
      if (!isConfigValidationError(err)) throw err;
      const issue = err.issues[0] ?? err.message;
      return issue.startsWith(key) ? name + issue.slice(key.length) : `${name}: ${issue}`;
    }
  };
}

/**
 * Check an option object's keys against `known` (unknown keys, with a
 * suggestion), then its values with `values`. Typed records make the key
 * lists complete: a new nested option does not compile until it is listed.
 */
function optionObject(known: Readonly<Record<string, true>>, values?: KeyCheck): KeyCheck {
  const keys = Object.keys(known);
  return (value, name) => {
    if (!isPlainObject(value)) return `${name} must be an object (got ${describeValue(value)})`;
    const issues = Object.keys(value)
      .filter((key) => !Object.prototype.hasOwnProperty.call(known, key))
      .map((key) => unknownKey(key, `${name}.`, keys));
    const valueIssue = values?.(value, name);
    return [...issues, ...(valueIssue === undefined ? [] : [valueIssue].flat())];
  };
}

const UI_KEYS: { readonly [K in keyof NonNullable<TapsmithConfig['ui']>]-?: true } = {
  prepareBetweenRuns: true,
  prepareDelayMs: true,
};

const TRACE_KEYS: { readonly [K in keyof TraceConfig]-?: true } = {
  mode: true,
  screenshots: true,
  snapshots: true,
  sources: true,
  attachments: true,
  network: true,
  networkHosts: true,
  networkIgnoreHosts: true,
  networkPassthroughHosts: true,
  networkHttpPorts: true,
  deviceLogs: true,
  daemonLogs: true,
};

const VIDEO_KEYS: { readonly [K in keyof VideoConfig]-?: true } = {
  mode: true,
  size: true,
};

/** `trace` / `video`: the mode in either form, plus the object form's keys. */
function recordingOption(key: 'trace' | 'video', known: Readonly<Record<string, true>>): KeyCheck {
  const mode = delegated(key, (o) => validateRecordingModes(o));
  const object = optionObject(known);
  return (value, name) => {
    const modeIssue = mode(value, name);
    if (modeIssue !== undefined || !isPlainObject(value)) return modeIssue;
    return object(value, name);
  };
}

const ROOT_CHECKS: { readonly [K in keyof TapsmithConfig]-?: KeyCheck } = {
  platform: oneOf(['android', 'ios', 'macos']),
  apk: optionalString,
  app: optionalString,
  activity: optionalString,
  // Positive: 0 is not "no timeout" (as in Playwright) but a budget already spent.
  timeout: positiveMs,
  retries: nonNegativeInteger,
  screenshot: oneOf(['always', 'only-on-failure', 'never']),
  testMatch: globs,
  daemonAddress: aString,
  daemonBin: optionalString,
  device: optionalString,
  devices: delegated('devices', (o) => validateDevicesOption(o)),
  deviceStrategy: oneOf(['prefer-connected', 'avd-only']),
  rootDir: aString,
  outputDir: aString,
  package: optionalString,
  agentApk: optionalString,
  agentTestApk: optionalString,
  iosXctestrun: optionalString,
  resetAppDeepLink: optionalString,
  resetAppWaitMs: nonNegativeMs,
  appReset: delegated('appReset', (o) => validateAppResetOptions(o)),
  appResetScope: delegated('appResetScope', (o) => validateAppResetOptions(o)),
  appResetColdEvery: delegated('appResetColdEvery', (o) => validateAppResetOptions(o)),
  ui: optionObject(UI_KEYS, delegated('ui', (o) => validateUiOptions(o))),
  telemetry: aBoolean,
  typingDelay: nonNegativeMs,
  doubleTapInterval: positiveMs,
  simulator: optionalString,
  reporter: orOff(check(
    (v) => isReporterDescription(v) || (Array.isArray(v) && v.every(isReporterDescription)),
    'a reporter name, a [name, options] tuple, or an array of them',
  )),
  workers: positiveInteger,
  shard: check(
    (v) => isPlainObject(v) && Number.isInteger(v.current) && Number.isInteger(v.total)
      && (v.current as number) >= 1 && (v.current as number) <= (v.total as number),
    '{ current, total } with 1 <= current <= total',
  ),
  launchEmulators: aBoolean,
  avd: optionalString,
  emulatorLaunchOptions: delegated('emulatorLaunchOptions', (o) => validateEmulatorLaunchOptions(o)),
  trace: recordingOption('trace', TRACE_KEYS),
  video: recordingOption('video', VIDEO_KEYS),
  projects: check(Array.isArray, 'an array of project objects'),
  baseURL: optionalString,
  extraHTTPHeaders: check(
    (v) => isPlainObject(v) && Object.values(v).every((h) => typeof h === 'string'),
    'an object of string header values',
  ),
  grep: regExps,
  grepInvert: regExps,
};

const USE_CHECKS: { readonly [K in keyof UseOptions]-?: KeyCheck } = {
  timeout: ROOT_CHECKS.timeout,
  screenshot: ROOT_CHECKS.screenshot,
  retries: ROOT_CHECKS.retries,
  trace: ROOT_CHECKS.trace,
  video: ROOT_CHECKS.video,
  platform: ROOT_CHECKS.platform,
  device: ROOT_CHECKS.device,
  devices: ROOT_CHECKS.devices,
  avd: ROOT_CHECKS.avd,
  simulator: ROOT_CHECKS.simulator,
  apk: ROOT_CHECKS.apk,
  app: ROOT_CHECKS.app,
  package: ROOT_CHECKS.package,
  activity: ROOT_CHECKS.activity,
  agentApk: ROOT_CHECKS.agentApk,
  agentTestApk: ROOT_CHECKS.agentTestApk,
  iosXctestrun: ROOT_CHECKS.iosXctestrun,
  deviceStrategy: ROOT_CHECKS.deviceStrategy,
  launchEmulators: ROOT_CHECKS.launchEmulators,
  resetAppDeepLink: ROOT_CHECKS.resetAppDeepLink,
  resetAppWaitMs: ROOT_CHECKS.resetAppWaitMs,
  appReset: ROOT_CHECKS.appReset,
  appResetScope: ROOT_CHECKS.appResetScope,
  appResetColdEvery: ROOT_CHECKS.appResetColdEvery,
  doubleTapInterval: ROOT_CHECKS.doubleTapInterval,
  baseURL: ROOT_CHECKS.baseURL,
  extraHTTPHeaders: ROOT_CHECKS.extraHTTPHeaders,
  appState: optionalString,
};

const PROJECT_CHECKS: { readonly [K in keyof ProjectConfig]-?: KeyCheck } = {
  name: check((v) => typeof v === 'string' && v.trim() !== '', 'a non-empty string'),
  testMatch: globs,
  testIgnore: globs,
  dependencies: check(isStringArray, 'an array of project names'),
  use: (value, name) => (isPlainObject(value) ? undefined : `${name} must be an object (got ${describeValue(value)})`),
  workers: positiveInteger,
  grep: regExps,
  grepInvert: regExps,
};

/** What to say about a root key Tapsmith does not know, when a near-miss suggestion would not help. */
const ROOT_KEY_HINTS: Record<string, string> = {
  use: "Tapsmith has no root-level `use`: set these options at the top level, or in a project's `use`",
  testDir: 'Tapsmith finds tests under `rootDir` with `testMatch`',
  appState: "appState is set in a project's `use` or with test.use()",
  testIgnore: 'testIgnore is set per project (projects[].testIgnore)',
};

/**
 * Check `object`'s keys against `checks`, appending each problem to `issues`.
 * `prefix` is the path to `object` (`projects[0].use.`); `unknown` words the
 * issue for a key that is not in `checks`.
 */
function checkKeys(
  object: Record<string, unknown>,
  checks: Readonly<Record<string, KeyCheck>>,
  prefix: string,
  issues: string[],
  unknown: (key: string) => string,
): void {
  for (const [key, value] of Object.entries(object)) {
    if (!Object.prototype.hasOwnProperty.call(checks, key)) {
      issues.push(unknown(key));
      continue;
    }
    // Unset. `null` is a value: each check says whether it accepts it.
    if (value === undefined) continue;
    const issue = checks[key](value, prefix + key);
    if (issue !== undefined) issues.push(...[issue].flat());
  }
}

function unknownKey(key: string, prefix: string, known: readonly string[], hint?: string): string {
  if (hint) return `unknown option '${prefix}${key}' (${hint})`;
  const suggestion = suggestFrom(key, known);
  return `unknown option '${prefix}${key}'${suggestion ? ` (did you mean '${prefix}${suggestion}'?)` : ''}`;
}

function checkProjectUse(use: Record<string, unknown>, prefix: string, issues: string[]): void {
  const useKeys = Object.keys(USE_CHECKS);
  checkKeys(use, USE_CHECKS, `${prefix}use.`, issues, (key) => {
    const name = `${prefix}use.${key}`;
    if (key !== 'use' && Object.prototype.hasOwnProperty.call(PROJECT_CHECKS, key)) {
      return `${name} can't be set in \`use\`; set it on the project itself (${prefix}${key})`;
    }
    if (Object.prototype.hasOwnProperty.call(ROOT_CHECKS, key)) {
      return `${name} can't be set per project; set it at the top level of the config`;
    }
    return unknownKey(key, `${prefix}use.`, useKeys);
  });
}

/**
 * Every problem with a config file's default export, in key order: unknown
 * keys (with a near-miss suggestion), values of the wrong type, enum values
 * Tapsmith does not accept — at the root, in `ui`, in each project and its
 * `use`. Empty when the config is valid.
 */
function configShapeIssues(config: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const rootKeys = Object.keys(ROOT_CHECKS);
  checkKeys(config, ROOT_CHECKS, '', issues, (key) => unknownKey(key, '', rootKeys, ROOT_KEY_HINTS[key]));

  if (Array.isArray(config.projects)) {
    const projectKeys = Object.keys(PROJECT_CHECKS);
    config.projects.forEach((project: unknown, i: number) => {
      const prefix = `projects[${i}].`;
      if (!isPlainObject(project)) {
        issues.push(`projects[${i}] must be a project object (got ${describeValue(project)})`);
        return;
      }
      // Required, so checked even when absent.
      if (project.name === undefined) issues.push(`${prefix}name must be a non-empty string (got undefined)`);
      checkKeys(project, PROJECT_CHECKS, prefix, issues, (key) => unknownKey(key, prefix, projectKeys));
      if (isPlainObject(project.use)) checkProjectUse(project.use, prefix, issues);
    });
  }
  return issues;
}

/**
 * The config a loaded module exports, validated. A config file must export
 * the config as its default: without one, its named exports used to be read
 * as the config, so `export const config = defineConfig(…)` ran on the
 * built-in defaults.
 */
function configFromModule(mod: Record<string, unknown>, configPath: string): Partial<TapsmithConfig> {
  if (mod.default === undefined) {
    const named = Object.keys(mod).filter((key) => key !== 'default' && key !== '__esModule');
    const found = named.length === 0
      ? ''
      : ` (found named export${named.length === 1 ? '' : 's'} ${named.map((n) => `\`${n}\``).join(', ')})`;
    throw new ConfigValidationError(
      [`it has no default export${found}. Export the config as the default: \`export default defineConfig({ ... })\``],
      { configPath },
    );
  }
  const config = mod.default;
  if (!isPlainObject(config)) {
    throw new ConfigValidationError(
      [`the default export must be a config object (got ${describeValue(config)})`],
      { configPath },
    );
  }
  const issues = configShapeIssues(config);
  if (issues.length > 0) throw new ConfigValidationError(issues, { configPath });
  return config as Partial<TapsmithConfig>;
}

/** A validation error raised while a config was imported or merged, traced to its file. */
function withConfigFile(err: unknown, configPath: string): unknown {
  const validation = [err, (err as { cause?: unknown } | null)?.cause].find(isConfigValidationError);
  if (!validation) return err;
  // Raised by a config this one loads (`loadConfig` inside a config): already names its file.
  if (validation.configPath) return validation;
  return new ConfigValidationError(validation.issues ?? [validation.message], { configPath });
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
 * The config file `loadConfig(dir, configFile)` reads: `configFile` resolved
 * against `dir` (whether or not it exists — loadConfig then reports it
 * missing), else the first of `CONFIG_CANDIDATES` present in `dir`, else
 * undefined (built-in defaults). Anything that reports on "the config"
 * (doctor, verify) finds it here, so it cannot disagree with the runner.
 */
export function findConfigFile(dir: string, configFile?: string): string | undefined {
  if (configFile) return path.resolve(dir, configFile);
  return CONFIG_CANDIDATES.map((name) => path.resolve(dir, name)).find((p) => fs.existsSync(p));
}

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

// ─── Tapsmith not installed (PILOT-551) ───
//
// `npx tapsmith init` and a global install run Tapsmith from outside the
// project, but the config and example test `init` writes import `tapsmith`,
// so a project that never added the dependency cannot load its own config.
// Here rather than in a module of its own: config.ts has no runtime imports
// of Tapsmith's own modules, which lets its loader tests run it in bare Node.

export interface InstallCommand {
  /** The add command, to run in the directory: only where it has a package.json. */
  command: string;
  args: string[];
  /**
   * What the user should type: `npm i -D tapsmith`, or, in a directory without
   * a package.json, `npm init -y && npm i -D tapsmith` (PILOT-631).
   */
  display: string;
  /** Set when the directory has no package.json: says so, naming the project a bare add would change. */
  note?: string;
}

/** Whether `import 'tapsmith'` from a file in `dir` finds a package. */
export function isTapsmithResolvableFrom(dir: string): boolean {
  try {
    // Any file name in `dir` anchors the lookup; it need not exist.
    createRequire(path.join(dir, 'noop.js')).resolve('tapsmith');
    return true;
  } catch {
    return false;
  }
}

/**
 * The package manager the project at `dir` uses, as package-manager-detector
 * names it (`npm`, `pnpm`, `yarn`, `yarn@berry`, `bun`, …): the one its
 * lockfile or `packageManager` field names, looking up from `dir` so a
 * workspace root's lockfile counts, else npm. Exported for hints that name
 * the project's own commands (PILOT-709).
 */
export async function projectPackageManager(dir: string): Promise<string> {
  // Loaded only when needed: config.ts is part of the SDK every test imports.
  const { detect } = await import('package-manager-detector');
  const detected = await detect({ cwd: dir }).catch(() => null);
  return detected?.agent ?? 'npm';
}

/**
 * How the project at `dir` runs its own Tapsmith, for the commands init and
 * its hints print (PILOT-721): `pnpm exec tapsmith`, `yarn tapsmith` (Yarn
 * 2+), `bunx tapsmith`, else `npx tapsmith`. Yarn 1 keeps npx, which finds
 * the local bin in its node_modules: `yarn tapsmith` prints a banner on
 * stdout, which breaks `mcp-server`'s stdio and `--json` output.
 */
export async function tapsmithExecCommand(dir: string): Promise<string> {
  const agent = await projectPackageManager(dir);
  return TAPSMITH_EXEC[agent] ?? 'npx tapsmith';
}

const TAPSMITH_EXEC: Record<string, string> = {
  pnpm: 'pnpm exec tapsmith',
  'pnpm@6': 'pnpm exec tapsmith',
  'yarn@berry': 'yarn tapsmith',
  bun: 'bunx tapsmith',
};

/**
 * `<package manager> add -D <packages>` for the project at `dir`, with the
 * manager `projectPackageManager` finds. `what` names the packages in the
 * note for a directory without a package.json ("Tapsmith", "the Android
 * agent").
 */
export async function devDependencyInstallCommand(dir: string, packages: string[], what: string): Promise<InstallCommand> {
  const { resolveCommand } = await import('package-manager-detector');
  const agent = await projectPackageManager(dir) as Parameters<typeof resolveCommand>[0];
  const resolved = resolveCommand(agent, 'add', ['-D', ...packages])
    ?? { command: 'npm', args: ['i', '-D', ...packages] };
  const add = [resolved.command, ...resolved.args].join(' ');
  if (fs.existsSync(path.join(dir, 'package.json'))) return { ...resolved, display: add };

  // Without a package.json here, the add goes to the nearest ancestor project
  // (PILOT-631): right for a monorepo root, wrong for the home directory or an
  // unrelated parent. Only the user knows which, so the note says where it
  // would go and the command creates this directory's package.json first.
  const ancestor = nearestProjectAbove(dir, agent === 'npm' || agent === 'deno');
  return {
    ...resolved,
    display: `${PACKAGE_JSON_INIT[agent] ?? 'npm init -y'} && ${add}`,
    note: ancestor
      ? `There's no package.json in ${dir}: on its own, \`${add}\` would add ${what} to ${ancestor} instead. If that is this project's root, run it there; otherwise create a package.json here first.`
      : `There's no package.json in ${dir}: create one before installing ${what}.`,
  };
}

/** `<package manager> add -D tapsmith` for the project at `dir`. */
export function tapsmithInstallCommand(dir: string): Promise<InstallCommand> {
  return devDependencyInstallCommand(dir, ['tapsmith'], 'Tapsmith');
}

/**
 * Each package manager's non-interactive way to create a package.json. Bun's
 * `bun init -y` also scaffolds an entry file and a tsconfig, so npm's.
 */
const PACKAGE_JSON_INIT: Record<string, string> = {
  yarn: 'yarn init -y',
  'yarn@berry': 'yarn init -y',
  pnpm: 'pnpm init',
  'pnpm@6': 'pnpm init',
};

/**
 * The project an add run in `dir` would change: the nearest ancestor with a
 * package.json — or, for npm, one with a node_modules folder too (npm's
 * prefix rule) — or undefined when there is none, or when npm would use
 * `dir` itself for its node_modules.
 */
function nearestProjectAbove(dir: string, nodeModulesCounts: boolean): string | undefined {
  if (nodeModulesCounts && fs.existsSync(path.join(dir, 'node_modules'))) return undefined;
  for (let current = path.dirname(dir), prev = dir; current !== prev; prev = current, current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (nodeModulesCounts && fs.existsSync(path.join(current, 'node_modules'))) return current;
  }
  return undefined;
}

/**
 * Node's error for an unresolvable `tapsmith` (or `tapsmith/…`) import: the
 * CommonJS `Cannot find module 'tapsmith'` and the ESM `Cannot find package
 * 'tapsmith' imported from …`.
 */
export function isMissingTapsmithError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false;
  return /Cannot find (?:module|package) 'tapsmith(?:\/[^']*)?'/.test(err.message);
}

/** The error a config that imports `tapsmith` fails with in a project without it. */
export class TapsmithNotInstalledError extends Error {
  readonly code = 'TAPSMITH_NOT_INSTALLED';
  readonly configPath: string;
  readonly installCommand: InstallCommand;

  // No parameter properties: Node's type stripping cannot run them.
  constructor(configPath: string, installCommand: InstallCommand, cause: unknown) {
    super(
      `Failed to load config file ${configPath}: Tapsmith isn't installed in this project. Run \`${installCommand.display}\`.${installCommand.note ? ` ${installCommand.note}` : ''}`,
      { cause },
    );
    this.name = 'TapsmithNotInstalledError';
    this.configPath = configPath;
    this.installCommand = installCommand;
  }
}

/** By code, not class: the error may come from another copy of this module. */
export function isTapsmithNotInstalledError(err: unknown): err is TapsmithNotInstalledError {
  return err instanceof Error && (err as { code?: unknown }).code === 'TAPSMITH_NOT_INSTALLED';
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
  try {
    return await importConfigModuleOnce(configPath);
  } catch (err) {
    // `defineConfig`'s own checks throw while the config is imported: say
    // which file, the way load-time validation does, not as a load failure.
    const traced = withConfigFile(err, configPath);
    if (traced !== err) throw traced;
    throw await explainMissingTapsmith(configPath, err);
  }
}

/**
 * A config importing `tapsmith` in a project without it — one written by
 * `npx tapsmith init` or a global install — fails with Node's "Cannot find
 * module 'tapsmith'", which says nothing about installing it (PILOT-551).
 * Only when `tapsmith` really does not resolve from the config's directory:
 * a module missing inside an installed Tapsmith is a different problem.
 */
async function explainMissingTapsmith(configPath: string, err: unknown): Promise<unknown> {
  const failures = [(err as { cause?: unknown } | null)?.cause, (err as Record<symbol, unknown> | null)?.[NATIVE_ERROR]];
  if (!failures.some(isMissingTapsmithError)) return err;
  const dir = path.dirname(configPath);
  if (isTapsmithResolvableFrom(dir)) return err;
  return new TapsmithNotInstalledError(configPath, await tapsmithInstallCommand(dir), (err as { cause?: unknown }).cause ?? err);
}

// ─── Module-type warnings ───

/**
 * Whether a warning is Node complaining about the module type of a file it
 * imports natively: MODULE_TYPELESS_PACKAGE_JSON for ESM syntax in a package
 * without `"type"` (Node reparses it as ESM), or "Failed to load the ES
 * module" for ESM syntax in a `"type": "commonjs"` package (the load fails
 * and tsx retries it). Both advise adding `"type": "module"`, which can break
 * an Expo/RN app, for a config Tapsmith loads either way (PILOT-540).
 */
function isModuleTypeWarning(warning: unknown): boolean {
  if (!(warning instanceof Error)) return false;
  if ((warning as { code?: unknown }).code === 'MODULE_TYPELESS_PACKAGE_JSON') return true;
  return warning.message.startsWith('Failed to load the ES module');
}

let moduleTypeWarningScopes = 0;
let moduleTypeWarningFilter: typeof process.emit | undefined;
let emitBeforeFilter: typeof process.emit | undefined;

/**
 * Run a native config import with Node's module-type warnings dropped.
 *
 * Node has no runtime switch for `--disable-warning`. The bin drops the
 * typeless warning for its own process (`ignoreTypelessPackageWarnings`), but
 * not for `node dist/cli.js` or a child that loads the CLI another way, and
 * nothing else covers the CommonJS warning at all. Both warnings reach `process.emit('warning')`: the CommonJS
 * one synchronously from Node's loader, the typeless one from
 * `process.emitWarning` on a later tick — after the import has settled, so
 * the filter stays until the next macrotask, by which time every warning
 * queued during the load has been emitted. Every other event and warning
 * passes through. Native imports are not serialised, so overlapping ones
 * share one filter, inert once the last of them is done.
 */
async function withoutModuleTypeWarnings<T>(load: () => Promise<T>): Promise<T> {
  if (moduleTypeWarningScopes++ === 0) {
    const emit = process.emit as (event: string | symbol, ...args: unknown[]) => boolean;
    emitBeforeFilter = process.emit;
    moduleTypeWarningFilter = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
      if (moduleTypeWarningScopes > 0 && event === 'warning' && isModuleTypeWarning(args[0])) return false;
      return emit.call(this, event, ...args);
    } as typeof process.emit;
    process.emit = moduleTypeWarningFilter;
  }
  try {
    return await load();
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    // Something that wrapped `process.emit` meanwhile (signal-exit does)
    // keeps its wrapper; ours stays beneath it, passing everything through.
    if (--moduleTypeWarningScopes === 0 && process.emit === moduleTypeWarningFilter && emitBeforeFilter) {
      process.emit = emitBeforeFilter;
      moduleTypeWarningFilter = undefined;
      emitBeforeFilter = undefined;
    }
  }
}

/** The native import's error, kept on a tsx-retry failure for `explainMissingTapsmith`. */
const NATIVE_ERROR = Symbol('tapsmith.nativeConfigError');

async function importConfigModuleOnce(configPath: string): Promise<Record<string, unknown>> {
  let nativeError: unknown;
  try {
    // Not queued: a native import that runs while another load's tsx hooks
    // are registered is compiled by them, and `unwrapCommonJsConfig` gives
    // the same result either way.
    return unwrapCommonJsConfig(
      (await withoutModuleTypeWarnings(() => import(pathToFileURL(configPath).href))) as Record<string, unknown>,
    );
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
  const syntax = syntaxErrorsOf(configPath, err);
  let detail = syntax ? syntaxErrorDetail(configPath, syntax) : errorMessage(err);
  if (nativeError !== undefined && errorMessage(nativeError) !== errorMessage(err) && isUnresolvedForTsxToo(nativeError)) {
    detail += `\n(Without tsx, Node reported: ${errorMessage(nativeError)})`;
  }
  if (note) detail += `\n(${note})`;
  // A syntax error in the config itself reads `<file>:<line>:<col>: <text>`.
  const separator = syntax && sameFile(syntax[0].file, configPath) ? '' : ' ';
  const error = new Error(`Failed to load config file ${configPath}:${separator}${detail}`, { cause: err });
  Object.defineProperty(error, CONFIG_LOAD_FAILURE, {
    value: { configPath, location: syntax?.[0] } satisfies ConfigLoadFailure,
  });
  if (nativeError !== undefined) Object.defineProperty(error, NATIVE_ERROR, { value: nativeError });
  // Callers print `stack`, which never includes `cause`: without this the
  // trace shows Tapsmith's loader frames and not the line in the config.
  const causeStack = err instanceof Error ? err.stack : undefined;
  if (causeStack) error.stack = `${error.name}: ${error.message}\nCaused by: ${causeStack}`;
  return error;
}

// ─── Config load failures (PILOT-569) ───

/** Where a syntax error in a config (or a file it imports) is. */
export interface ConfigErrorLocation {
  file: string;
  line: number;
  column?: number;
  text: string;
}

/** What the CLI needs to report a config that could not be imported. */
export interface ConfigLoadFailure {
  configPath: string;
  /** The (first) syntax error's location, when the failure is one. */
  location?: ConfigErrorLocation;
}

// Symbol.for: the error may come from another copy of this module.
const CONFIG_LOAD_FAILURE = Symbol.for('tapsmith.configLoadFailure');

/** The config file and syntax-error location of an error `loadConfig` rejected with an unloadable config. */
export function configLoadFailureOf(err: unknown): ConfigLoadFailure | undefined {
  if (!(err instanceof Error)) return undefined;
  return (err as unknown as Record<symbol, ConfigLoadFailure | undefined>)[CONFIG_LOAD_FAILURE];
}

/**
 * The syntax errors a load failure is, located: esbuild's (tsx compiling a
 * TypeScript config) are parsed from its message; Node's own carry no
 * location in an ES module, so `node --check` finds it for a JavaScript
 * config. `undefined` for anything else, or a syntax error that cannot be
 * located (one in a module the config imports, which `--check` does not
 * follow).
 */
function syntaxErrorsOf(configPath: string, err: unknown): ConfigErrorLocation[] | undefined {
  const esbuild = parseEsbuildErrors(errorMessage(err));
  if (esbuild) return esbuild;
  if (!(err instanceof SyntaxError) || !firstStackFrameIsCompileStep(err)) return undefined;
  if (!/\.[cm]?js$/.test(configPath)) return undefined;
  const located = checkSyntaxLocation(configPath);
  return located ? [{ ...located, text: err.message }] : undefined;
}

/**
 * esbuild's "Transform failed with N error(s):" message, one
 * `<file>:<line>:<col>: ERROR: <text>` line per error.
 * @internal — exported for unit testing.
 */
export function parseEsbuildErrors(message: string): ConfigErrorLocation[] | undefined {
  const [first, ...rest] = message.split('\n');
  if (!/^(?:Transform|Build) failed with \d+ errors?:$/.test(first)) return undefined;
  const errors = rest.flatMap((line) => {
    const m = /^(.+?):(\d+):(\d+): (?:ERROR|error): (.*)$/.exec(line);
    return m ? [{ file: m[1], line: Number(m[2]), column: Number(m[3]) + 1, text: m[4] }] : [];
  });
  return errors.length > 0 ? errors : undefined;
}

function syntaxErrorDetail(configPath: string, errors: ConfigErrorLocation[]): string {
  return errors.map((e, i) => {
    const where = `${e.line}${e.column !== undefined ? `:${e.column}` : ''}: ${e.text}`;
    // The headline continues "Failed to load config file <configPath>:".
    if (i === 0 && sameFile(e.file, configPath)) return where;
    return `${e.file}:${where}`;
  }).join('\n');
}

function sameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The line and column of a JavaScript file's syntax error, from
 * `node --check`, which prints `<file>:<line>`, the line, and a caret under
 * the offending token. Only run once the import has already failed.
 */
function checkSyntaxLocation(file: string): { file: string; line: number; column?: number } | undefined {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8', timeout: 10_000 });
  const lines = (result.stderr ?? '').split('\n');
  const header = lines.findIndex((l) => l.startsWith(`${file}:`));
  if (header === -1) return undefined;
  const line = Number(lines[header].slice(file.length + 1));
  if (!Number.isInteger(line) || line < 1) return undefined;
  const caret = lines[header + 2]?.indexOf('^') ?? -1;
  return { file, line, ...(caret >= 0 ? { column: caret + 1 } : {}) };
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
    return loadConfigFile(configPath, root);
  }

  const configPath = findConfigFile(root);
  if (configPath) {
    // The first candidate that exists is the config, loadable or not. A
    // broken one is a hard error, never a reason to try the next candidate
    // or fall back to the defaults: either would run the session under a
    // config the user is not editing (PILOT-262).
    return loadConfigFile(configPath, root);
  }

  const defaults: TapsmithConfig = { ...DEFAULT_CONFIG, rootDir: root };
  withExplicitRootDir(defaults, false);
  withConfigPath(defaults, undefined);
  return withExplicitWorkers(defaults, false);
}

async function loadConfigFile(configPath: string, root: string): Promise<TapsmithConfig> {
  const mod = await importConfigModule(configPath);
  // Keep the original for rawHasExplicitWorkers — omitUndefined produces a
  // fresh object, dropping the non-enumerable EXPLICIT_WORKERS symbol that
  // defineConfig-produced configs carry.
  const original = configFromModule(mod, configPath);
  const raw = omitUndefined(original);
  let merged: TapsmithConfig;
  try {
    merged = applyConfigDefaults(
      { ...DEFAULT_CONFIG, ...raw, rootDir: resolveRootDir(original, root) },
      raw,
    );
  } catch (err) {
    throw withConfigFile(err, configPath);
  }
  withExplicitRootDir(merged, rawHasExplicitRootDir(original));
  withConfigPath(merged, configPath);
  return withExplicitWorkers(merged, rawHasExplicitWorkers(original));
}
