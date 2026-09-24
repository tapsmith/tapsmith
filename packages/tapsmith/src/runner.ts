/**
 * Minimal test runner for Tapsmith.
 *
 * Supports:
 *   - test(name, fn) / test.only / test.skip
 *   - describe(name, fn) / describe.only / describe.skip
 *   - beforeAll, afterAll, beforeEach, afterEach hooks
 *   - Sequential execution with proper error reporting
 *   - Screenshot capture on failure
 *   - Timing information
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { NetworkSnapshots } from './trace/network-snapshots.js';
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);
import type { TapsmithConfig, Platform, UseOptions } from './config.js';
import type { Device } from './device.js';
import type { TapsmithReporter } from './reporter.js';
import { APIRequestContext } from './api-request.js';
import { flushSoftErrors } from './expect.js';
import { FixtureRegistry, resolveFixtures, fixtureParameterNames, functionHasParameters, type FixtureDefinitions, type BuiltinFixtures } from './fixtures.js';
import { resolveTraceConfig } from './trace/types.js';
import { shouldRecord, shouldRetain } from './trace/trace-mode.js';
import { resolveVideoConfig } from './video/types.js';
import { appendEventsToTrace, packageTrace, readTraceActionCount } from './trace/trace-packager.js';
import { TraceCollector, screenshotFileName, setActiveTraceCollector, withActiveTraceCollector } from './trace/trace-collector.js';
import type { AnyTraceEvent } from './trace/types.js';
import { getSimulatorScreenScale } from './ios-simulator.js';
import type { NetworkCaptureRoute, NetworkEntry, TraceDeviceInfo } from './trace/types.js';
import { TestAbortedError, isAbortError } from './abort.js';
import {
  appResetAction,
  appResetPolicyEquals,
  describeAction,
  resolveAppResetPolicy,
  type AppResetPolicy,
  type AppResetReport,
  type PreparedState,
  type ResetCapabilities,
} from './app-reset.js';
import { executeAppReset, type ExecuteAppResetOptions, type SessionPreflightContext } from './session-preflight.js';
import { deviceGroupSize, resolveDeviceGroup, validateAppResetOptions, validateDevicesOption } from './config.js';
import { onActionProgress } from './action-progress.js';
import { runInAttemptContext, type AttemptToken } from './attempt-fence.js';
import { matchesTestFilter } from './test-filter.js';
import { startLiveNetwork } from './trace/live-network.js';
import { telemetry, runEventFromResults, type RunMode } from './telemetry.js';
import { isRecoverableInfrastructureError } from './worker-protocol.js';
import { filterEntriesByHosts } from './trace/filter-hosts.js';

// ─── Trace Device Info ───

async function buildTraceDeviceInfo(
  opts: RunOptions,
  rd: RunDevice,
  index: number,
  networkCapturing?: ReadonlySet<Device>,
): Promise<TraceDeviceInfo> {
  // The primary's serial historically came from `config.device`; group
  // members carry their own.
  const serial = rd.serial ?? (index === 0 ? opts.config.device : undefined) ?? 'unknown';
  const platform = opts.config.platform ?? 'android';
  const info: TraceDeviceInfo = {
    serial,
    name: rd.name,
    platform,
    isEmulator: serial.startsWith('emulator-'),
    devicePixelRatio: platform === 'ios' && serial !== 'unknown'
      ? getSimulatorScreenScale(serial)
      : undefined,
  };
  if (rd.device && networkCapturing?.has(rd.device) && rd.device._networkCaptureRoute) {
    info.networkCaptureRoute = rd.device._networkCaptureRoute;
  }
  if (rd.device?._fetchDeviceInfo) {
    try {
      const cached = await rd.device._fetchDeviceInfo(serial);
      if (cached.model) info.model = cached.model;
      if (cached.osVersion) info.osVersion = cached.osVersion;
      if (cached.isEmulator != null) info.isEmulator = cached.isEmulator;
    } catch { /* best-effort enrichment */ }
  }
  return info;
}

/**
 * Trace metadata for every device of the run: `device` (the primary, kept for
 * readers of older traces) and `devices` (the whole group, primary first).
 * `networkCapturing` is the set of devices whose capture started for this
 * test; each of them records the route its traffic took.
 */
async function traceDeviceMetadata(
  opts: RunOptions,
  networkCapturing?: ReadonlySet<Device>,
): Promise<{ device: TraceDeviceInfo; devices: TraceDeviceInfo[] }> {
  const group = opts.devices.length > 0 ? opts.devices : [{ name: 'device-1', device: undefined as unknown as Device }];
  const devices = await Promise.all(group.map((rd, i) => buildTraceDeviceInfo(opts, rd, i, networkCapturing)));
  return { device: devices[0], devices };
}

/** The primary device of the run (`devices[0]`), if any. */
function primaryDevice(opts: RunOptions): Device | undefined {
  return opts.devices[0]?.device;
}

/** Every device of the run, primary first. */
function allDevices(opts: RunOptions): Device[] {
  return opts.devices.map((d) => d.device);
}

/** Run `fn` against every device concurrently, swallowing per-device errors. */
async function forEachDeviceBestEffort(opts: RunOptions, fn: (device: Device) => Promise<unknown> | unknown): Promise<void> {
  await Promise.allSettled(allDevices(opts).map(async (d) => { await fn(d); }));
}

/** Devices whose embedder supplied a session context — the ones the runner can reset. */
function resettableDevices(opts: RunOptions): Array<RunDevice & { sessionContext: SessionPreflightContext }> {
  return opts.devices.filter((d): d is RunDevice & { sessionContext: SessionPreflightContext } => !!d.sessionContext);
}

// ─── Result types ───

/**
 * Warnings emitted by the daemon's `start_network_capture` that the
 * runner has already printed once this process. Keeps repeating
 * "Network capture disabled: …" from polluting the per-test output in
 * a run where the underlying cause (e.g. SE not approved) is the same
 * for every test.
 */
const _printedCaptureWarnings = new Set<string>();

/** Strip HTTP/1.1 chunked transfer encoding framing from a body.
 * Returns the original buffer if parsing fails. */
function dechunkHttpBody(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < body.length) {
    const lineEnd = body.indexOf('\r\n', pos);
    if (lineEnd === -1) return body;
    const sizeHex = body.subarray(pos, lineEnd).toString('ascii').split(';')[0].trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) return body;
    pos = lineEnd + 2;
    if (size === 0) break;
    if (pos + size > body.length) return body;
    parts.push(body.subarray(pos, pos + size));
    pos += size;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
  }
  return Buffer.concat(parts);
}

/** Case-insensitive header lookup. HTTP header names are case-insensitive
 * per RFC 7230 §3.2, and the on-device collectors have historically mixed
 * casing (`Transfer-Encoding`, `transfer-encoding`, `Transfer-encoding`). */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return undefined;
}

/** Decode a captured HTTP body: strip chunked framing per Transfer-Encoding,
 * then decompress per Content-Encoding. Device-level network interception
 * captures raw wire bytes, so we have to reverse any hop-by-hop framing
 * before display. Falls back to the raw buffer on any parse/decode failure. */
async function decodeHttpBody(body: Buffer | undefined, headers: Record<string, string>): Promise<Buffer | undefined> {
  if (!body || body.length === 0) return body;
  let decoded = body;
  const te = (headerValue(headers, 'transfer-encoding') ?? '').toLowerCase();
  if (te.split(',').map((s) => s.trim()).includes('chunked')) {
    decoded = dechunkHttpBody(decoded);
  }
  const ce = (headerValue(headers, 'content-encoding') ?? '').toLowerCase().trim();
  if (!ce || ce === 'identity') return decoded;
  try {
    if (ce === 'gzip' || ce === 'x-gzip') return await gunzip(decoded);
    if (ce === 'deflate') return await inflate(decoded);
    if (ce === 'br') return await brotliDecompress(decoded);
  } catch {
    // Fall through on decompression failure
  }
  return decoded;
}

type RawNetworkEntries = Awaited<ReturnType<Device['_stopNetworkCapture']>>['entries'];
type DeviceNetworkEntries = Array<{ deviceId?: string; entries: RawNetworkEntries }>;

/** Keep row/body identities stable as streams finish or new devices report data. */
function createNetworkMapper(testStartTime: number): (
  rawNetworkByDevice: DeviceNetworkEntries, events: readonly AnyTraceEvent[], apiEntries: NetworkEntry[],
) => Promise<NetworkEntry[]> {
  const decodedBodies = new WeakMap<Buffer, Map<string, Promise<Buffer | undefined>>>();
  const decode = (body: Buffer | undefined, headers: Record<string, string>): Promise<Buffer | undefined> => {
    if (!body?.length) return Promise.resolve(body);
    const key = JSON.stringify([headerValue(headers, 'transfer-encoding'), headerValue(headers, 'content-encoding')]);
    let cached = decodedBodies.get(body);
    if (!cached) { cached = new Map(); decodedBodies.set(body, cached); }
    let decoded = cached.get(key);
    if (!decoded) { decoded = decodeHttpBody(body, headers); cached.set(key, decoded); }
    return decoded;
  };
  const indices = new Map<string, number>();
  const stableIndex = (key: string): number => {
    let index = indices.get(key);
    if (index === undefined) { index = indices.size; indices.set(key, index); }
    return index;
  };
  return async (rawNetworkByDevice, events, apiEntries) => {
    // Collect action start times and indices; completion order may differ.
    const actionTimestamps = events
      .filter((e): e is import('./trace/types.js').ActionTraceEvent | import('./trace/types.js').AssertionTraceEvent =>
        e.type === 'action' || e.type === 'assertion')
      // `timestamp` is the step's completion time; a request the step
      // itself triggers (tap → fetch) starts before that, so anchor on
      // when the step began. Falls back to completion for events that
      // carry no start time.
      .map((e) => ({ timestamp: e.startTime ?? e.timestamp, actionIndex: e.actionIndex, deviceId: e.deviceId }));

    // A request is anchored to the latest step that started before it
    // — on the device that made it. Group members interleave in the
    // shared index space, so a global walk would hang bob's request off
    // alice's step whenever hers was the more recent one. A device with
    // no steps of its own (or an unlabelled entry) falls back to the
    // whole list.
    const findActionIndex = (startTimeMs: number, deviceId: string | undefined): number => {
      const own = deviceId ? actionTimestamps.filter((a) => a.deviceId === deviceId) : [];
      const candidates = own.length > 0 ? own : actionTimestamps;
      let best = 0;
      let bestTimestamp = -Infinity;
      for (const a of candidates) {
        if (a.timestamp <= startTimeMs && a.timestamp >= bestTimestamp) {
          best = a.actionIndex;
          bestTimestamp = a.timestamp;
        }
      }
      return best;
    };

    const networkEntries = await Promise.all(rawNetworkByDevice.flatMap(({ deviceId, entries }) => entries.map((e) => ({ deviceId, e }))).map(async ({ deviceId, e }, i) => {
      const requestHeaders = e.requestHeadersJson ? JSON.parse(e.requestHeadersJson) : {};
      const responseHeaders = e.responseHeadersJson ? JSON.parse(e.responseHeadersJson) : {};
      return {
        index: stableIndex(JSON.stringify([deviceId ?? '', e.captureId || `legacy:${i}`])),
        ...(deviceId ? { deviceId } : {}),
        actionIndex: findActionIndex(e.startTimeMs, deviceId),
        startTime: e.startTimeMs,
        observedStartTime: e.startTimeMs < testStartTime ? testStartTime : undefined,
        endTime: e.startTimeMs + e.durationMs,
        method: e.method,
        url: e.url,
        status: e.statusCode,
        contentType: e.contentType,
        requestSize: e.requestSize,
        responseSize: e.responseSize,
        duration: e.durationMs,
        inFlight: e.inFlight || undefined,
        requestHeaders,
        responseHeaders,
        requestBody: await decode(e.requestBody, requestHeaders),
        responseBody: await decode(e.responseBody, responseHeaders),
        routeAction: e.routeAction
          ? e.routeAction as import('./trace/types.js').NetworkEntry['routeAction']
          : undefined,
      };
    }));

    return [...networkEntries, ...apiEntries.map((entry, i) => ({
      ...entry, index: stableIndex(`api:${i}`),
    }))];
  };
}

function _warnCaptureOnce(prefix: string, msg: string): void {
  const key = `${prefix}:${msg}`;
  if (_printedCaptureWarnings.has(key)) return;
  _printedCaptureWarnings.add(key);
  console.warn(`[tapsmith] ${prefix}: ${msg}`);
}

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  name: string;
  fullName: string;
  status: TestStatus;
  durationMs: number;
  error?: Error;
  screenshotPath?: string;
  /** Path to the trace archive, if recorded. */
  tracePath?: string;
  /** Path to the recorded MP4 video, if `video` was enabled and retained (PILOT-114). */
  videoPath?: string;
  /** Index of the worker that ran this test (only set in parallel mode). */
  workerIndex?: number;
  /** Project name this test belongs to (only set when projects are configured). */
  project?: string;
  /** Zero-based attempt number on which this result was recorded (omitted for first run). */
  retry?: number;
  /**
   * The first failed attempt's error, kept on a flaky (passed-on-retry)
   * result so reporters can show why the test flaked. The failed attempt's
   * trace/screenshot/video are linked via the regular path fields.
   */
  firstAttemptError?: Error;
  /**
   * For flaky (passed-on-retry) results: which of the linked artifacts came
   * from the first failed attempt rather than the passing retry, so
   * reporters can label them (a failure screenshot under a green ✓ is
   * confusing otherwise). Artifacts can mix: e.g. trace from the failed
   * attempt (retain-on-failure) alongside a video from the retry
   * (on-first-retry).
   */
  failedAttemptArtifacts?: { screenshot?: boolean; trace?: boolean; video?: boolean };
  /** @internal True when this result represents a failed attempt that will be retried. */
  _willRetry?: boolean;
  /** Path to the test file this result belongs to. */
  filePath?: string;
  /**
   * Scope setup time (declared app reset + beforeAll hooks) attributed to
   * this test because it was the first to run in its scope. Already included
   * in `durationMs`, mirroring how Playwright counts fixture setup.
   */
  setupMs?: number;
}

export interface SuiteResult {
  name: string;
  tests: TestResult[];
  suites: SuiteResult[];
  durationMs: number;
}

// ─── Fixtures ───

export interface TestFixtures {
  /** The primary device — an alias for `devices[0]`. */
  device: Device;
  /**
   * Every device this test drives, in the order declared by the project's
   * `use.devices`. One entry without `devices` configured. Destructure by
   * position (`{ devices: [alice, bob] }`) to drive two app sessions from one
   * test — the mobile analogue of Playwright's multi-context tests.
   */
  devices: Device[];
  /** API request context for making HTTP calls during tests. */
  request: APIRequestContext;
  /** Name of the project running this test, if projects are configured. */
  projectName?: string;
  /**
   * Platform the device under test is running on (`'android'` or `'ios'`).
   * Sourced from the resolved config so tests can branch on platform without
   * relying on project-name conventions, which differ between the multi-device
   * config and the single-platform configs. Always set — defaults to
   * `'android'` when `config.platform` is unset (mirrors the
   * `TapsmithConfig.platform` doc default), so test branches like
   * `if (platform === 'android') ...` cannot silently skip both arms when a
   * caller forgets to declare the platform.
   */
  platform: Platform;
}

// ─── Per-scope option overrides ───

// UseOptions is defined in config.ts (where TapsmithConfig lives) to avoid circular deps.
// Re-exported here for backward compatibility.
export type { UseOptions } from './config.js';

// ─── Internal registration types ───

type HookFn = ((fixtures: TestFixtures) => void | Promise<void>) | (() => void | Promise<void>);

/** Test functions can either take fixtures or no arguments. */
type TestCallback = ((fixtures: TestFixtures) => void | Promise<void>) | (() => void | Promise<void>);

interface TestEntry {
  name: string;
  fn: TestCallback;
  only: boolean;
  skip: boolean;
  registry?: FixtureRegistry;
}

interface HookEntry {
  fn: HookFn
  registry?: FixtureRegistry
}

interface SuiteEntry {
  name: string;
  fn: () => void;
  only: boolean;
  skip: boolean;
  ctx?: SuiteContext;
}

// ─── Global registration state ───

interface SuiteContext {
  tests: TestEntry[];
  suites: SuiteEntry[];
  beforeAll: HookEntry[];
  afterAll: HookEntry[];
  beforeEach: HookEntry[];
  afterEach: HookEntry[];
  useOptions?: UseOptions;
}

// Store registration state on globalThis so ESM and CJS module instances
// share the same context stack. Without this, CJS projects (no "type":
// "module") get a separate module instance when tsx loads the test file,
// and describe()/test() calls write to an empty stack.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G = globalThis as any;
const STACK_KEY = Symbol.for('tapsmith.contextStack');
const REGISTRY_KEY = Symbol.for('tapsmith.fixtureRegistry');
if (!G[STACK_KEY]) G[STACK_KEY] = [] as SuiteContext[];
if (!G[REGISTRY_KEY]) G[REGISTRY_KEY] = new FixtureRegistry();

function getContextStack(): SuiteContext[] { return G[STACK_KEY] as SuiteContext[]; }
function setContextStack(v: SuiteContext[]): void { G[STACK_KEY] = v; }
function getActiveFixtureRegistry(): FixtureRegistry { return G[REGISTRY_KEY] as FixtureRegistry; }
function setActiveFixtureRegistry(v: FixtureRegistry): void { G[REGISTRY_KEY] = v; }

/** Get the current fixture registry (used by the runner). */
export function getFixtureRegistry(): FixtureRegistry {
  return getActiveFixtureRegistry();
}

function currentContext(): SuiteContext {
  const stack = getContextStack();
  return stack[stack.length - 1];
}

function pushContext(): SuiteContext {
  const ctx: SuiteContext = {
    tests: [],
    suites: [],
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
  };
  getContextStack().push(ctx);
  return ctx;
}

function popContext(): SuiteContext {
  return getContextStack().pop()!;
}

function materializeSuiteEntry(entry: SuiteEntry): SuiteContext {
  if (entry.ctx) return entry.ctx;
  pushContext();
  try {
    entry.fn();
    entry.ctx = popContext();
    return entry.ctx;
  } catch (err) {
    popContext();
    throw err;
  }
}

function collectFixtureRegistries(ctx: SuiteContext, registries: Set<FixtureRegistry>): void {
  for (const t of ctx.tests) {
    if (t.registry) registries.add(t.registry);
  }
  for (const h of [...ctx.beforeAll, ...ctx.afterAll, ...ctx.beforeEach, ...ctx.afterEach]) {
    if (h.registry) registries.add(h.registry);
  }
  for (const suite of ctx.suites) {
    collectFixtureRegistries(materializeSuiteEntry(suite), registries);
  }
}

// ─── Public registration API ───

export interface TestFn<Fixtures extends object = TestFixtures> {
  (name: string, fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)): void;
  only: (name: string, fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)) => void;
  skip: (name: string, fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)) => void;
  /**
   * Override configuration options for all tests in the current describe scope.
   * Overrides cascade — inner describe blocks inherit and can further override.
   *
   * ```ts
   * describe("slow screen", () => {
   *   test.use({ timeout: 60000 })
   *   test("animation completes", async ({ device }) => { ... })
   * })
   * ```
   */
  use: (options: UseOptions) => void;
  /**
   * Create a new test function with additional fixtures.
   *
   * ```ts
   * const test = base.extend<{ auth: Device }>({
   *   auth: [async ({ device }, use) => {
   *     await loginHelper(device)
   *     await use(device)
   *   }, { scope: 'worker' }],
   * })
   * ```
   */
  extend: <T extends Record<string, unknown>>(
    definitions: FixtureDefinitions<T, Fixtures & T>,
  ) => TestFn<Fixtures & T>;
  beforeAll: (fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)) => void;
  afterAll: (fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)) => void;
  beforeEach: (fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)) => void;
  afterEach: (fn: ((fixtures: Fixtures) => void | Promise<void>) | (() => void | Promise<void>)) => void;
}

export interface DescribeFn {
  (name: string, fn: () => void): void;
  only: (name: string, fn: () => void) => void;
  skip: (name: string, fn: () => void) => void;
}

function createTestFn<F extends object = TestFixtures>(registry: FixtureRegistry): TestFn<F> {
  const syncRegistry = () => { setActiveFixtureRegistry(registry); };
  const fn = Object.assign(
    (name: string, testFn: TestCallback) => {
      syncRegistry();
      currentContext().tests.push({ name, fn: testFn, only: false, skip: false, registry });
    },
    {
      only: (name: string, testFn: TestCallback) => {
        syncRegistry();
        currentContext().tests.push({ name, fn: testFn, only: true, skip: false, registry });
      },
      skip: (name: string, testFn: TestCallback) => {
        syncRegistry();
        currentContext().tests.push({ name, fn: testFn, only: false, skip: true, registry });
      },
      use: (options: UseOptions) => {
        syncRegistry();
        if (options.timeout !== undefined && options.timeout <= 0) {
          throw new Error('test.use() timeout must be a positive number');
        }
        if (options.retries !== undefined && options.retries < 0) {
          throw new Error('test.use() retries must be a non-negative number');
        }
        validateAppResetOptions(options, 'test.use()');
        if (options.devices !== undefined) {
          // Every other device-shaping key is silently ignored here (the worker
          // is bound before the file is imported); a group declared this way
          // would leave the test destructuring devices that never exist, so
          // fail with the fix instead.
          throw new Error(
            'test.use({ devices }) is not supported: the device group is bound to the worker before any test runs. '
            + 'Declare it on a project instead: projects: [{ name, testMatch, use: { devices: 2 } }].',
          );
        }
        validateDevicesOption(options, 'test.use()');
        const ctx = currentContext();
        ctx.useOptions = { ...ctx.useOptions, ...options };
      },
      extend: <T extends Record<string, unknown>>(
        definitions: FixtureDefinitions<T, F & T>,
      ): TestFn<F & T> => {
        const childRegistry = new FixtureRegistry();
        // Cast needed: register() is typed for BuiltinFixtures but F may be a wider fixture set
        childRegistry.register(definitions as FixtureDefinitions<T, BuiltinFixtures & T>);
        const merged = registry.merge(childRegistry);
        setActiveFixtureRegistry(merged);
        return createTestFn<F & T>(merged);
      },
      beforeAll: (hookFn: HookFn) => { syncRegistry(); currentContext().beforeAll.push({ fn: hookFn, registry }); },
      afterAll: (hookFn: HookFn) => { syncRegistry(); currentContext().afterAll.push({ fn: hookFn, registry }); },
      beforeEach: (hookFn: HookFn) => { syncRegistry(); currentContext().beforeEach.push({ fn: hookFn, registry }); },
      afterEach: (hookFn: HookFn) => { syncRegistry(); currentContext().afterEach.push({ fn: hookFn, registry }); },
    },
  // Object.assign can't infer the generic F — cast through unknown is safe
  // because each property is typed correctly in the object literal above.
  ) as unknown as TestFn<F>;
  return fn;
}

export const test: TestFn = createTestFn(getActiveFixtureRegistry());

export const describe: DescribeFn = Object.assign(
  (name: string, fn: () => void) => {
    currentContext().suites.push({ name, fn, only: false, skip: false });
  },
  {
    only: (name: string, fn: () => void) => {
      currentContext().suites.push({ name, fn, only: true, skip: false });
    },
    skip: (name: string, fn: () => void) => {
      currentContext().suites.push({ name, fn, only: false, skip: true });
    },
  },
);

export function beforeAll(fn: HookFn): void {
  currentContext().beforeAll.push({ fn });
}

export function afterAll(fn: HookFn): void {
  currentContext().afterAll.push({ fn });
}

export function beforeEach(fn: HookFn): void {
  currentContext().beforeEach.push({ fn });
}

export function afterEach(fn: HookFn): void {
  currentContext().afterEach.push({ fn });
}

// ─── Helpers ───

function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolve the `platform` fixture value from the effective config and
 * validate against silent misconfiguration.
 *
 * Defaulting an unset `platform` to `'android'` matches the documented
 * `TapsmithConfig.platform` default and keeps the fixture non-optional so
 * platform-conditional tests can't silently skip both branches. But
 * blindly defaulting hides a sharp class of misconfig: the user
 * supplies an iOS app bundle, simulator, or xctestrun (clear iOS
 * intent) yet forgets `platform: 'ios'`, and every iOS-conditional
 * test runs against an Android target — usually failing in confusing
 * ways further down the stack. Catching it at fixture-injection time
 * means the failure surfaces immediately with a message that names
 * the missing field, instead of cascading through device setup and
 * snapshot finder errors.
 */
function resolvePlatformFixture(config: TapsmithConfig): Platform {
  if (config.platform != null) {
    return config.platform;
  }
  const iosIndicators: Array<[keyof TapsmithConfig, string]> = [
    ['app', 'app'],
    ['simulator', 'simulator'],
    ['iosXctestrun', 'iosXctestrun'],
  ];
  const present = iosIndicators
    .filter(([key]) => config[key] != null)
    .map(([, label]) => label);
  if (present.length > 0) {
    throw new Error(
      `Tapsmith config has iOS-only field(s) [${present.join(', ')}] but ` +
        `\`platform\` is not set. Add \`platform: 'ios'\` to the config (or to the ` +
        `relevant project's \`use\`) so iOS-conditional tests target the right device.`,
    );
  }
  return 'android';
}

// ─── Runner engine ───

/** Details announced with a test's start (UI mode). */
export interface TestStartOptions {
  /** Re-tag of trace attribution to a finished test (afterAll hooks). */
  attributionOnly?: boolean;
  /**
   * The isolation policy this execution runs under — `auto` resolved, and the
   * test's own scope (a describe's `test.use({ appResetScope: 'test' })`),
   * even when an enclosing scope announces the test ahead of its beforeAll.
   */
  policy?: AppResetPolicy;
}

/**
 * One device of a run, as the embedder hands it to the runner. `devices[0]`
 * is the primary: it records the trace, hosts video recording, and is what
 * the `device` fixture resolves to.
 */
export interface RunDevice {
  /** Group entry name (`alice`, `device-1`) — the trace's `deviceId` for this device. */
  name: string;
  device: Device;
  /** Serial / UDID, for trace metadata. Falls back to `config.device` for the primary. */
  serial?: string;
  /**
   * Session context used to execute the declared app reset policy
   * (`appReset` / `appResetScope` / `appState`) on this device as traced
   * fixture setup. Without it the runner performs no reset on the device
   * (unit tests, embedders that manage isolation themselves).
   */
  sessionContext?: SessionPreflightContext;
  /**
   * A reset that already happened on this device before the file started
   * (the startup launch of a fresh install, a background preparation).
   * Consumed once: the first reset the file would perform is skipped when
   * this satisfies it.
   */
  prepared?: PreparedState;
}

export interface RunOptions {
  config: TapsmithConfig;
  /**
   * The devices this file's tests drive, primary first — deliberately
   * REQUIRED, like `resetCapabilities`. Every embedder (sequential CLI,
   * worker-runner, ui-worker, watch-run — which also serves the MCP
   * dispatcher) must thread its whole device group here: a group project
   * whose embedder passed only the primary would hand tests a `devices`
   * fixture missing the members they destructure. Pass `[]` only for runs
   * with no device at all (unit tests of the runner itself).
   */
  devices: RunDevice[];
  screenshotDir?: string;
  reporter?: TapsmithReporter;
  /**
   * Notification fired before tracing/group starts so UI mode can tag
   * subsequent trace events to this test. Must be lightweight (no device
   * actions) — it runs outside the beforeEach trace group.
   *
   * `attributionOnly` marks re-tags for a test that already finished (the
   * afterAll hook path re-targets trace events at the last test that ran).
   * Consumers must not treat these as a new test execution — the UI would
   * otherwise flip a finished test back to 'running' and clear its trace.
   */
  onTestStart?: (fullName: string, options?: TestStartOptions) => Promise<void>;
  /**
   * Setup work that runs inside the beforeEach trace group. Use this for
   * any device actions (e.g. session readiness checks) so they appear
   * grouped in the trace viewer instead of as ungrouped top-level events.
   */
  beforeEachTest?: (fullName: string) => Promise<void>;
  abortFileOnError?: (error: Error) => boolean;
  /** @internal — controller whose signal is wired to abortSignal; aborted by abortFileOnError. */
  _abortFileController?: AbortController;
  /** Pre-resolved worker-scoped fixture values (set by worker-runner). */
  workerFixtures?: Record<string, unknown>;
  /** Test file path — used by trace packager for testFile metadata and source inclusion. */
  testFilePath?: string;
  /** Project-level use options applied as a base layer under file-level test.use(). */
  projectUseOptions?: UseOptions;
  /** Project name — stamped on test results for reporter grouping. */
  projectName?: string;
  /**
   * Runtime capabilities used to resolve `appReset: 'auto'` — deliberately
   * REQUIRED, not optional. Every embedder (sequential CLI, worker-runner,
   * ui-worker, watch-run — which also serves the MCP dispatcher) must thread
   * its sticky per-device capabilities here, or `auto` silently resolves to
   * clear · file and warm resets never engage; two embedders shipped exactly
   * that bug because this field was optional. Pass an explicit `{}` only for
   * contexts with no device capability probing (unit tests).
   */
  resetCapabilities: ResetCapabilities;
  /**
   * Which run path this file executes under — deliberately REQUIRED, like
   * `resetCapabilities`. The runner reports one anonymous telemetry event per
   * file tagged with this mode (PILOT-330); were it optional, an embedder
   * that forgot it would silently under-report its whole path. Every embedder
   * (sequential CLI, worker-runner, ui-worker, watch-run — which also serves
   * the MCP dispatcher and so takes the mode from its parent's message) must
   * name itself here.
   */
  runMode: RunMode;
  /**
   * @internal — per-device prepared state, keyed by device name, shared down
   * the describe tree so each device's preparation is consumed exactly once
   * per file (by whichever scope resets that device first).
   */
  _prepared?: Map<string, PreparedState>;
  /**
   * @internal — the policy most recently applied to the device within this
   * file (by any scope's entry reset or a per-test reset). Scope-entry
   * resets compare against it, not the lexical parent: after a sibling
   * describe restored its own appState, the device holds that state, and a
   * scope inheriting the parent's policy must reset back to it.
   */
  _applied?: { current?: AppResetPolicy };
  /**
   * Run only tests whose fullName contains this value (case-insensitive
   * substring match). All other tests are skipped. May match several tests.
   */
  testFilter?: string;
  /**
   * Regular expressions matched against each test's fullName. When set, only
   * tests with a fullName matching at least one pattern are run; the rest are
   * marked skipped. Mirrors Playwright's `--grep` / `config.grep`.
   */
  grep?: RegExp[];
  /**
   * Per-project grep filter, intersected with `grep`. A test must match at
   * least one pattern in this set AND at least one pattern in `grep` (when
   * either is set). Mirrors Playwright's per-project `grep`, which AND-s
   * with the root `grep`.
   */
  projectGrep?: RegExp[];
  /**
   * Regular expressions matched against each test's fullName. When set, tests
   * whose fullName matches any of these patterns are skipped. Mirrors
   * Playwright's `--grep-invert` / `config.grepInvert`.
   */
  grepInvert?: RegExp[];
  /**
   * Per-project grep-invert filter, unioned with `grepInvert`. A test that
   * matches any pattern in either set is skipped.
   */
  projectGrepInvert?: RegExp[];
  /**
   * Full snapshots during a test and after its final drain. Enables live
   * polling in UI mode. `networkCaptureRoute` is how this attempt's capture
   * reached the proxy — `ios-system-proxy` (host-wide, may include other apps'
   * traffic) whenever any device used it (PILOT-319).
   */
  onNetworkEntries?: (entries: NetworkEntry[], networkCaptureEnabled?: boolean, networkCaptureRoute?: NetworkCaptureRoute) => void;
  /**
   * Append a unique query parameter to the dynamic import URL so Node.js
   * treats it as a new module. Required by persistent processes (UI workers)
   * that re-run the same file — without this, the ESM cache returns the
   * stale first import and no tests are registered.
   */
  bustImportCache?: boolean;
  /** When aborted, skip remaining tests but still run afterEach/afterAll hooks. */
  abortSignal?: AbortSignal;
}

/**
 * Capture a screenshot from every device of the run. The primary's path is
 * returned (and linked on the result); the other devices' files carry their
 * group name as a suffix so a two-user failure shows both screens.
 */
async function captureFailureScreenshots(
  opts: RunOptions,
  screenshotDir: string | undefined,
  testName: string,
): Promise<string | undefined> {
  if (opts.devices.length === 0 || !screenshotDir) return undefined;
  const paths = await Promise.all(opts.devices.map((rd, i) => captureFailureScreenshot(
    rd.device,
    screenshotDir,
    opts.devices.length > 1 && i > 0 ? `${testName}-${rd.name}` : testName,
  )));
  return paths[0];
}

async function captureFailureScreenshot(
  device: Device | undefined,
  screenshotDir: string | undefined,
  testName: string,
): Promise<string | undefined> {
  if (!device || !screenshotDir) return undefined;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(screenshotDir, { recursive: true });
    let screenshotTimer: ReturnType<typeof setTimeout>;
    const res = await Promise.race([
      device.takeScreenshot().finally(() => clearTimeout(screenshotTimer)),
      new Promise<never>((_, reject) => {
        screenshotTimer = setTimeout(() => reject(new Error('Screenshot timed out')), 10_000);
      }),
    ]);
    if (res.success && res.data) {
      const safeName = testName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(screenshotDir, `${safeName}-${Date.now()}.png`);
      fs.writeFileSync(filePath, res.data);
      return filePath;
    }
  } catch {
    // screenshot capture is best-effort
  }
  return undefined;
}

/**
 * Whether a test's fullName passes all configured selection filters
 * (`testFilter`, `grep`, `grepInvert`). A test that doesn't pass is skipped.
 *
 * - `testFilter`: case-insensitive substring match against the fullName
 *   (subsumes exact-name and describe-prefix matches; may match several tests).
 * - `grep` / `projectGrep`: each set must have at least one matching regex
 *   (intersected: root AND project).
 * - `grepInvert` / `projectGrepInvert`: no regex in the union may match.
 */
// Reset lastIndex before each test() — RegExp with the `g` flag is stateful.
function passesTestFilter(fullName: string, opts: RunOptions): boolean {
  if (opts.testFilter && !matchesTestFilter(fullName, opts.testFilter)) {
    return false;
  }
  if (opts.grep && opts.grep.length > 0
    && !opts.grep.some((re) => (re.lastIndex = 0, re.test(fullName)))) {
    return false;
  }
  if (opts.projectGrep && opts.projectGrep.length > 0
    && !opts.projectGrep.some((re) => (re.lastIndex = 0, re.test(fullName)))) {
    return false;
  }
  if (opts.grepInvert && opts.grepInvert.length > 0
    && opts.grepInvert.some((re) => (re.lastIndex = 0, re.test(fullName)))) {
    return false;
  }
  if (opts.projectGrepInvert && opts.projectGrepInvert.length > 0
    && opts.projectGrepInvert.some((re) => (re.lastIndex = 0, re.test(fullName)))) {
    return false;
  }
  return true;
}

// Dispatch based on Function.length (parameter count). Note: fn.length does
// not count parameters with default values or rest parameters, so hooks like
// `async ({ device } = {}) => …` would be mis-classified as zero-arg. In
// practice this is fine because hooks are simple `async ({ device }) => …`.
async function invokeHook(
  entry: HookEntry,
  fixtures: Record<string, unknown>,
): Promise<void> {
  if (entry.fn.length > 0) {
    await (entry.fn as (fixtures: Record<string, unknown>) => void | Promise<void>)(fixtures);
  } else {
    await (entry.fn as () => void | Promise<void>)();
  }
}

/**
 * Invoke a suite-level hook (beforeAll/afterAll) with its own short-lived
 * test-fixture scope, then tear that scope down — even if the hook throws.
 *
 * Mirrors Playwright's `_runAllHooksForSuite`: each beforeAll/afterAll gets a
 * fresh test-fixture scope on top of the suite/worker fixtures. This lets these
 * hooks destructure test-scoped fixtures (e.g. page objects) without forcing
 * them to worker scope, where a single instance would be shared across every
 * test in the worker.
 */
async function invokeHookWithTestScope(
  hook: HookEntry,
  suiteFixtures: Record<string, unknown>,
  suiteRegistry: FixtureRegistry,
): Promise<void> {
  // A hook that takes no fixtures parameter needs no test-scoped setup.
  if (!functionHasParameters(hook.fn)) {
    await invokeHook(hook, suiteFixtures);
    return;
  }
  const registry = hook.registry ?? suiteRegistry;
  // Lazily resolve only the fixtures the hook destructures. If it takes a
  // non-destructured fixtures parameter we can't tell what it needs, so fall
  // back to resolving every test-scoped fixture (matches the test-body path).
  const names = fixtureParameterNames(hook.fn);
  const resolved = await resolveFixtures(
    registry, 'test', suiteFixtures, names.length > 0 ? names : undefined,
  );
  try {
    await invokeHook(hook, resolved.fixtures);
  } finally {
    await resolved.teardown();
  }
}

const builtinFixtureNames = new Set(['device', 'devices', 'request', 'projectName', 'platform']);

function validateHookFixtures(
  hook: HookEntry,
  testRegistry: FixtureRegistry,
  hookType: string,
): void {
  if (!hook.registry || hook.registry === testRegistry) return;
  for (const name of fixtureParameterNames(hook.fn)) {
    if (!testRegistry.has(name) && !builtinFixtureNames.has(name)) {
      process.stderr.write(
        `[tapsmith] ${hookType} hook expects fixture "${name}" which is not available in this test's fixture registry. ` +
        `The hook was registered with a different test.extend() than the test it is running against.\n`,
      );
    }
  }
}

/**
 * Replay saved beforeAll trace events into a test's trace.
 *
 * Events are recorded into the test's collector so they land in the packaged
 * trace archive (headless runs included), and — when `stream` is set — also
 * forwarded through the collector's event callback so UI mode shows them
 * live. Screenshots are read from the beforeAll collector's temp dir, which
 * outlives per-test packaging (it is cleaned up after the suite finishes).
 */
/**
 * Full name of the first test that will actually run in this scope, searching
 * nested describes depth-first with the same skip / `.only` / filter
 * predicates the run loops use. `undefined` means nothing in the scope runs —
 * in which case the scope's hooks and app reset must not run either (they
 * would cost seconds and have no test to be attributed to).
 */
/**
 * Apply a scope's `test.use()` overrides. `timeout` is handled separately via
 * the device (it only affects assertion/action auto-wait, not the test-level
 * safety timeout); `appState` is folded into the reset policy and cascades
 * through it (Playwright `test.use` semantics), so a nested describe that
 * declares nothing keeps its parent's restored state instead of resetting to
 * clear on entry — an explicit `appState: ''` still overrides.
 */
function resolveScope(
  useOptions: SuiteContext['useOptions'],
  parentOpts: RunOptions,
  parentPolicy: AppResetPolicy | undefined,
): { opts: RunOptions; policy: AppResetPolicy; scopeTimeout: number | undefined } {
  const { timeout: scopeTimeout, appState: scopeAppState, ...configOverrides } = useOptions ?? {};
  const opts: RunOptions = Object.keys(configOverrides).length > 0
    ? { ...parentOpts, config: { ...parentOpts.config, ...configOverrides } }
    : parentOpts;
  const policy = resolveAppResetPolicy(
    { appState: scopeAppState ?? parentPolicy?.appState },
    opts.config,
    opts.resetCapabilities,
  );
  return { opts, policy, scopeTimeout };
}

/**
 * The first test that will run in this scope (possibly inside a nested
 * describe), with the policy it runs under — the enclosing scope announces
 * that test ahead of its beforeAll, and the announcement must describe the
 * test's own isolation, not the announcing scope's.
 */
function firstRunnableTest(
  ctx: SuiteContext,
  prefix: string,
  opts: RunOptions,
  policy: AppResetPolicy,
): { fullName: string; policy: AppResetPolicy } | undefined {
  const hasOnlyTests = ctx.tests.some((t) => t.only);
  const hasOnly = hasOnlyTests || ctx.suites.some((s) => s.only);
  for (const t of ctx.tests) {
    if (t.skip || (hasOnly && !t.only)) continue;
    const fullName = prefix ? `${prefix} > ${t.name}` : t.name;
    if (passesTestFilter(fullName, opts)) return { fullName, policy };
  }
  for (const s of ctx.suites) {
    if (s.skip || (hasOnly && !s.only && !hasOnlyTests)) continue;
    const childPrefix = prefix ? `${prefix} > ${s.name}` : s.name;
    const child = materializeSuiteEntry(s);
    const scoped = resolveScope(child.useOptions, opts, policy);
    const found = firstRunnableTest(child, childPrefix, scoped.opts, scoped.policy);
    if (found) return found;
  }
  return undefined;
}

/** Recorded scope setup (app reset + beforeAll) replayed into every test's trace. */
interface ScopeSetupRecording {
  events: readonly AnyTraceEvent[];
  collector: TraceCollector | null;
  hierarchies: Map<number, { before?: string; after?: string }>;
  actionCount: number;
}

/**
 * Setup inherited from enclosing scopes: the recordings to replay into each
 * test (outermost first) and the test whose live stream already carried the
 * setup events, so it is not streamed twice — nor announced twice.
 */
interface InheritedScopeSetup {
  announced?: string;
  recordings: ScopeSetupRecording[];
  /**
   * Scope setup time (app reset + beforeAll) not yet attributed to a test.
   * Shared down the tree so the first test to run anywhere below consumes
   * it — a file whose tests all live inside describes still counts the root
   * reset in its first test's duration, the way Playwright counts fixtures.
   */
  setup?: { pendingMs: number };
}

function replayBeforeAllEvents(
  testCollector: TraceCollector,
  events: readonly AnyTraceEvent[],
  beforeAllCollector: TraceCollector | null,
  hierarchies: Map<number, { before?: string; after?: string }>,
  stream: boolean,
): void {
  const cb = stream ? testCollector.getEventCallback() : undefined;
  const screenshotDir = beforeAllCollector
    ? path.join(beforeAllCollector.tempDir, 'screenshots')
    : null;

  for (const event of events) {
    if ((event.type === 'action' || event.type === 'assertion') && screenshotDir) {
      const beforePath = path.join(screenshotDir, screenshotFileName(event.actionIndex, 'before'));
      const afterPath = path.join(screenshotDir, screenshotFileName(event.actionIndex, 'after'));
      const hier = hierarchies.get(event.actionIndex);
      let hasBefore = false;
      let hasAfter = false;
      try { hasBefore = fs.existsSync(beforePath); } catch { /* best-effort */ }
      try { hasAfter = fs.existsSync(afterPath); } catch { /* best-effort */ }
      testCollector.ingestReplayedEvent(event, {
        screenshotBefore: hasBefore ? beforePath : undefined,
        screenshotAfter: hasAfter ? afterPath : undefined,
        hierarchyBefore: hier?.before,
        hierarchyAfter: hier?.after,
      });
      if (cb) {
        const captures: {
          before?: Buffer; after?: Buffer;
          hierarchyBefore?: string; hierarchyAfter?: string;
        } = {};
        try { if (hasBefore) captures.before = fs.readFileSync(beforePath); } catch { /* best-effort */ }
        try { if (hasAfter) captures.after = fs.readFileSync(afterPath); } catch { /* best-effort */ }
        if (hier?.before) captures.hierarchyBefore = hier.before;
        if (hier?.after) captures.hierarchyAfter = hier.after;
        cb(event, captures);
      }
    } else {
      testCollector.ingestReplayedEvent(event);
      cb?.(event);
    }
  }
}

/** Trace group that holds the declared app reset (rendered as APP RESET). */
const APP_RESET_GROUP = 'App reset';

/**
 * Execute the declared app reset as a traced fixture step, in its own
 * top-level "App reset" group that precedes the hooks group (BEFORE ALL /
 * BEFORE EACH). The hooks groups then contain only the user's own hook code,
 * and the isolation cost stays visible per test. Inline device work
 * (resetApp, clearAppData, restartApp, …) records its own action rows; when
 * the reset was satisfied by a prepared device, skipped by policy, or fell
 * back to another mode, a summary `appReset` row carries the explanation so
 * the trace stays honest. Callers must invoke this before opening the hooks
 * group — the actions panel renders groups as flat sections, so nesting would
 * swallow the hook actions that follow.
 */
async function runTracedAppReset(
  collector: TraceCollector | null,
  opts: RunOptions,
  policy: AppResetPolicy,
  options: Omit<ExecuteAppResetOptions, 'prepared'>,
): Promise<Map<string, AppResetReport>> {
  collector?.startGroup(APP_RESET_GROUP);
  const started = Date.now();
  const reports = new Map<string, AppResetReport>();
  try {
    // Every device of the group resets concurrently — the devices are
    // independent and a serial reset would double the isolation cost of every
    // two-user test. Each device consumes its own prepared state. A failure on
    // any device fails the reset (the group is atomic: a test cannot start
    // with one user ready and the other not).
    const resets = resettableDevices(opts).map(async (rd) => {
      const prepared = opts._prepared?.get(rd.name);
      const report = await executeAppReset(
        { ...rd.sessionContext, config: { ...opts.config, device: rd.serial ?? opts.config.device } },
        policy,
        { ...options, prepared },
      );
      reports.set(rd.name, report);
      // `appReset: 'none'` does nothing worth a row (the policy is in the trace
      // metadata); prepared / fallback outcomes get a summary row per device.
      const isNone = appResetAction(policy).kind === 'none';
      if (collector && !isNone && (report.origin !== 'inline' || report.fellBack)) {
        collector.addActionEvent({
          category: 'device',
          action: 'appReset',
          duration: report.durationMs,
          startTime: started,
          endTime: started + report.durationMs,
          success: true,
          detail: report.reason ?? describeAction(policy),
          origin: report.origin,
          log: report.steps.map((s) => `${s.name}: ${s.durationMs}ms${s.ok ? '' : ` — failed: ${s.detail ?? 'unknown error'}`}`),
          hasScreenshotBefore: false,
          hasScreenshotAfter: false,
          hasHierarchyBefore: false,
          hasHierarchyAfter: false,
          ...(rd.device._traceDeviceId ? { deviceId: rd.device._traceDeviceId } : {}),
        });
      }
    });
    // Settle every device before propagating a failure: with `Promise.all`
    // the other devices' terminate/clear/relaunch RPCs would still be in
    // flight while the caller moved on to screenshots, teardown or the
    // file-abort recovery, and could land after them.
    const settled = await Promise.allSettled(resets);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return reports;
  } finally {
    collector?.endGroup();
  }
}


/**
 * After a scope-entry reset: every device now holds exactly this policy's
 * state, and nothing has touched the app since — so the reset doubles as
 * preparation for the next reset in the file. A reset that was itself
 * satisfied by a prepared device carries the original preparation forward, so
 * the trace keeps naming its source.
 */
function recordPreparedAfterReset(
  opts: RunOptions,
  policy: AppResetPolicy,
  reports: Map<string, AppResetReport>,
  source: string,
): void {
  if (!opts._prepared) return;
  for (const [name, report] of reports) {
    if (appResetAction(policy).kind === 'none') {
      opts._prepared.delete(name);
      continue;
    }
    opts._prepared.set(name, report.satisfiedBy ?? {
      policy,
      preparedAt: Date.now(),
      durationMs: report.durationMs,
      source,
    });
  }
}

async function runSuiteContext(
  ctx: SuiteContext,
  parentPrefix: string,
  parentBeforeEach: HookEntry[],
  parentAfterEach: HookEntry[],
  parentOpts: RunOptions,
  parentPolicy?: AppResetPolicy,
  inherited: InheritedScopeSetup = { recordings: [] },
): Promise<SuiteResult> {
  // Apply test.use() overrides for this scope (cascading from parent) and
  // resolve the isolation policy it declares — see resolveScope.
  const { opts, policy, scopeTimeout } = resolveScope(ctx.useOptions, parentOpts, parentPolicy);
  const isRoot = parentPrefix === '';
  // Compare against what the device actually holds (the last policy applied
  // in this file), falling back to the lexical parent before anything ran.
  const appliedPolicy = opts._applied?.current ?? parentPolicy;
  const policyChanged = !isRoot && !appResetPolicyEquals(policy, appliedPolicy);
  const canReset = !!opts.config.package && resettableDevices(opts).length > 0;
  // File-scope policies reset on entering the file and whenever a nested
  // describe declares a different policy (e.g. test.use({ appState })).
  // Test-scope policies reset before every test instead, so a scope only
  // needs an entry reset when it has beforeAll hooks that expect the state.
  // Nothing runnable in this scope (all skipped / filtered / not `.only`) →
  // no setup at all: Playwright semantics, and it keeps a filtered-out
  // describe's beforeAll from streaming trace events onto whichever test
  // happened to run last.
  const firstRunnable = firstRunnableTest(ctx, parentPrefix, opts, policy);
  const scopeHasRunnable = firstRunnable !== undefined;
  // A test-scoped policy resets before every test, so its scope only needs an
  // entry reset when beforeAll hooks expect the declared state first; a mere
  // policy change is covered by the first per-test reset.
  const needsScopeReset = scopeHasRunnable && canReset && (
    policy.scope === 'file'
      ? (isRoot || policyChanged)
      : ctx.beforeAll.length > 0
  );
  const inheritedActionCount = inherited.recordings.reduce((n, r) => n + r.actionCount, 0);
  const devices = allDevices(opts);
  const primary = primaryDevice(opts);

  // Propagate timeout override to every device so assertion auto-wait uses it
  const prevDeviceTimeouts = scopeTimeout
    ? devices.map((d) => d._getDefaultTimeout())
    : undefined;
  if (scopeTimeout) {
    for (const d of devices) d._setDefaultTimeout(scopeTimeout);
  }
  // Likewise `appResetColdEvery`: the runner's own resets read it from
  // `opts.config`, but a mid-test `device.resetApp()` reads the device's copy,
  // which was set once at construction — without this a scope's override
  // would reach the policy path and silently miss explicit resets.
  const scopeColdEvery = ctx.useOptions?.appResetColdEvery;
  const prevDeviceColdEvery = scopeColdEvery !== undefined
    ? devices.map((d) => d._getAppResetColdEvery())
    : undefined;
  if (scopeColdEvery !== undefined) {
    for (const d of devices) d._setAppResetColdEvery(scopeColdEvery);
  }

  const result: SuiteResult = { name: parentPrefix, tests: [], suites: [], durationMs: 0 };
  const suiteStart = Date.now();

  // try/finally ensures device timeout is restored even if a hook
  // throws. Body intentionally not re-indented.
  try {

  // Determine if any test/suite in this context uses `.only`
  const hasOnlyTests = ctx.tests.some((t) => t.only);
  const hasOnlySuites = ctx.suites.some((s) => s.only);
  const hasOnly = hasOnlyTests || hasOnlySuites;

  // Run beforeAll hooks with tracing. We create a standalone collector
  // (via setActiveTraceCollector) that Device._traceCollector falls back to.
  // This is simpler than managing the Tracing-managed collector lifecycle.
  //
  // After beforeAll completes, we save the recorded events so they can be
  // replayed into each test's trace. This ensures beforeAll actions are
  // visible for every test in the suite (UI mode + trace viewer).
  let beforeAllCollector: TraceCollector | null = null;
  let beforeAllFirstFullName: string | undefined;
  if (scopeHasRunnable && (ctx.beforeAll.length > 0 || needsScopeReset) && primary) {
    const traceConfig = resolveTraceConfig(opts.config.trace);
    if (shouldRecord(traceConfig.mode, 0)) {
      // Tag beforeAll trace events with the first test that will run in
      // this scope — possibly inside a nested describe. An enclosing scope
      // may already have announced that same test; announcing it again
      // would make the UI reset the test's trace.
      beforeAllFirstFullName = firstRunnable.fullName;
      if (beforeAllFirstFullName !== inherited.announced) {
        // Both listeners: the per-test loop skips its own announcement for
        // this test (it would reset the UI trace), so the reporter must hear
        // about it here or never.
        if (opts.onTestStart) await opts.onTestStart(beforeAllFirstFullName, { policy: firstRunnable.policy });
        opts.reporter?.onTestStart?.(beforeAllFirstFullName, opts.testFilePath, { project: opts.projectName });
      }
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-ba-'));
      // Trigger _startManaged to fire the monkey-patch (ui-run.ts sets up
      // the event callback), then transfer the callback to a standalone
      // collector and clear the managed one.
      const managedCollector = primary.tracing._startManaged(traceConfig, tempDir);
      beforeAllCollector = new TraceCollector(traceConfig, tempDir);
      beforeAllCollector.setTimelineOrigin(suiteStart);
      // Continue numbering after any enclosing scope's setup actions.
      if (inheritedActionCount > 0) beforeAllCollector.setActionIndexOffset(inheritedActionCount);
      const cb = managedCollector.getEventCallback();
      if (cb) beforeAllCollector.setEventCallback(cb);
      primary.tracing._stopManaged();

      // Fold the enclosing scopes' setup into this collector first, so this
      // scope's recording is chronological (root reset → root hooks → this
      // scope's reset → its hooks) and the UI sees it in that order as well.
      // Streamed unless the announced test already received it live.
      for (const rec of inherited.recordings) {
        replayBeforeAllEvents(
          beforeAllCollector, rec.events, rec.collector, rec.hierarchies,
          beforeAllFirstFullName !== inherited.announced,
        );
      }
    }
  }
  const suiteFixtures: Record<string, unknown> = {
    ...(primary ? { device: primary, devices } : {}),
    ...(opts.projectName != null ? { projectName: opts.projectName } : {}),
    platform: resolvePlatformFixture(opts.config),
    ...(opts.workerFixtures ?? {}),
  };

  const suiteRegistry = getFixtureRegistry();

  // Set when the file-entry reset itself (not a user hook) threw. A
  // recoverable infrastructure error there is the embedder's to handle —
  // see the catch below.
  let fileEntryResetError: Error | undefined;

  try {
    const runScopeSetup = async (): Promise<void> => {
      if (needsScopeReset) {
        // The declared app reset is fixture setup: it runs first, in its own
        // APP RESET group ahead of BEFORE ALL, so the trace shows exactly
        // what the scope paid for isolation. A prepared device (startup
        // launch, background preparation) that already satisfies the policy
        // is consumed here — by whichever scope resets first. The prepared
        // state is cleared by the first reset of the file (any scope), so a
        // nested describe reached before anything touched the app can use it
        // just as the root scope would; later scopes find it already spent.
        let reports: Map<string, AppResetReport>;
        try {
          reports = await runTracedAppReset(beforeAllCollector, opts, policy, {
            phase: isRoot
              ? `file reset for ${path.basename(opts.testFilePath ?? '')}`
              : `reset for ${parentPrefix}`,
            // Cold vs warm delivery of the hook is the daemon's policy
            // (appResetColdEvery); only retries force it from here.
            forceCold: false,
          });
        } catch (err) {
          if (isRoot) fileEntryResetError = err instanceof Error ? err : new Error(String(err));
          throw err;
        }
        if (opts._applied) opts._applied.current = policy;
        // Without this, `test.use({ appResetScope: 'test' })` inside a
        // describe pays twice at file entry: the root's file-scoped reset,
        // then the first per-test reset a moment later. `satisfies()` turns
        // that second reset into a summary row instead.
        recordPreparedAfterReset(
          opts, policy, reports,
          isRoot ? 'the file-entry reset' : `the entry reset for ${parentPrefix}`,
        );
      }
      // User hooks may touch the app: whatever state the entry reset left is
      // no longer known-good for a later reset to reuse.
      if (ctx.beforeAll.length > 0) opts._prepared?.clear();
      // The hooks group holds only the user's beforeAll code.
      beforeAllCollector?.startGroup('beforeAll Hooks');
      for (const hook of ctx.beforeAll) {
        await invokeHookWithTestScope(hook, suiteFixtures, suiteRegistry);
      }
    };
    if (beforeAllCollector) {
      await withActiveTraceCollector(beforeAllCollector, runScopeSetup);
      beforeAllCollector.endGroup();
    } else if (scopeHasRunnable) {
      await runScopeSetup();
    }
  } catch (err) {
    // A user stop that lands during scope setup (app reset, beforeAll) is not
    // a failure: leave the untouched tests with whatever status they had,
    // mirroring the test loop's abort semantics (PILOT-222).
    if (isAbortError(err) || opts.abortSignal?.aborted) {
      beforeAllCollector?.cleanup();
      result.durationMs = Date.now() - suiteStart;
      return result;
    }

    // The file-entry reset hit a recoverable infrastructure error (agent
    // socket drop, ADB hiccup) before any test ran. Embedders that opt into
    // recovery (`abortFileOnError`) recover the session and re-run the file;
    // surfacing it as failed results here would record a failed attempt and
    // then flag every test in the file as flaky — main's between-file reset
    // recovered transparently, and so does this.
    if (fileEntryResetError && opts.abortFileOnError?.(fileEntryResetError)) {
      beforeAllCollector?.cleanup();
      throw fileEntryResetError;
    }

    // beforeAll failed — mark all tests in this context as failed and bail out.
    // This prevents a single beforeAll error from crashing the entire runner.
    const beforeAllError = err instanceof Error ? err : new Error(String(err));

    // Capture a screenshot so the user can see the device state at the time
    // of failure — otherwise beforeAll errors are text-only with no visual
    // context for debugging.
    let beforeAllScreenshot: string | undefined;
    if (opts.config.screenshot !== 'never') {
      const label = parentPrefix ? `beforeAll_${parentPrefix}` : 'beforeAll';
      beforeAllScreenshot = await captureFailureScreenshots(opts, opts.screenshotDir, label);
    }

    // Package whatever the beforeAll collector recorded into a trace ZIP.
    // The trace captures every action that ran before the failure — invaluable
    // for debugging why beforeAll couldn't find an element or timed out.
    let beforeAllTrace: string | undefined;
    if (beforeAllCollector) {
      try {
        beforeAllCollector.endGroup();
        const outputDir = path.resolve(opts.config.rootDir, opts.config.outputDir, 'traces');
        const label = parentPrefix || 'beforeAll';
        beforeAllTrace = packageTrace(beforeAllCollector, {
          testFile: opts.testFilePath ?? '',
          testName: label,
          testStatus: 'failed',
          testDuration: Date.now() - suiteStart,
          startTime: suiteStart,
          endTime: Date.now(),
          ...(await traceDeviceMetadata(opts)),
          tapsmithVersion: getPackageVersion(),
          error: beforeAllError.message,
          outputDir,
          project: opts.projectName,
          appState: policy.appState || undefined,
          appReset: policy.mode,
          appResetScope: policy.scope,
        });
      } catch {
        // Trace packaging is best-effort
      }
      beforeAllCollector.cleanup();
    }

    const failed = failAll(ctx, parentPrefix, beforeAllError, opts.projectName, beforeAllScreenshot, beforeAllTrace);
    for (const tr of collectResults(failed)) {
      result.tests.push(tr);
      opts.reporter?.onTestEnd?.(tr);
    }
    result.durationMs = Date.now() - suiteStart;
    return result;
  }

  // Scope setup time (app reset + beforeAll) is attributed to the first test
  // that runs in this scope, the way Playwright counts fixture setup.
  const setupHolder = inherited.setup ?? { pendingMs: 0 };
  setupHolder.pendingMs += Date.now() - suiteStart;

  // Save beforeAll events for replay into each test's trace.
  const savedBeforeAllEvents = beforeAllCollector ? beforeAllCollector.events.slice() : [];
  // With a collector, its recording already contains the inherited setup
  // (folded in above); without one, the inherited recordings are replayed
  // into each test directly.
  const setupActionCount = beforeAllCollector ? beforeAllCollector.currentActionIndex : inheritedActionCount;
  // Build hierarchy lookup for replay (hierarchies are in-memory, not on disk)
  const beforeAllHierarchies = new Map<number, { before?: string; after?: string }>();
  if (beforeAllCollector) {
    for (const h of beforeAllCollector.hierarchies) {
      const match = h.archivePath.match(/action-(\d+)-(before|after)\.xml/);
      if (match) {
        const idx = parseInt(match[1]);
        const position = match[2];
        const entry = beforeAllHierarchies.get(idx) ?? {};
        if (position === 'before') entry.before = h.xml;
        else entry.after = h.xml;
        beforeAllHierarchies.set(idx, entry);
      }
    }
  }

  // All beforeEach hooks (inherited + local)
  const allBeforeEach = [...parentBeforeEach, ...ctx.beforeEach];
  const allAfterEach = [...ctx.afterEach, ...parentAfterEach];

  // Run tests
  for (const entry of ctx.tests) {
    // Abort: stop running remaining tests but don't record them as
    // 'skipped' — a user-initiated stop should leave untouched tests with
    // whatever prior status they had, not overwrite them with a synthetic
    // skipped result.
    if (opts.abortSignal?.aborted) break;

    const fullName = parentPrefix ? `${parentPrefix} > ${entry.name}` : entry.name;

    // Determine if this test should be skipped.
    // testFilter is a case-insensitive substring match against the fullName.
    // grep / grepInvert match against the fullName as regular expressions.
    const filteredOut = !passesTestFilter(fullName, opts);
    const shouldSkip = entry.skip || (hasOnly && !entry.only) || filteredOut;

    if (shouldSkip) {
      const skippedResult: TestResult = {
        name: entry.name,
        fullName,
        status: 'skipped',
        durationMs: 0,
        project: opts.projectName,
        filePath: opts.testFilePath,
      };
      result.tests.push(skippedResult);
      opts.reporter?.onTestEnd?.(skippedResult);
      continue;
    }

    const testStart = Date.now();
    let status: TestStatus = 'passed';
    let error: Error | undefined;
    let screenshotPath: string | undefined;
    let tracePath: string | undefined;
    let videoPath: string | undefined;
    // Safety timeout for the test body (hooks run outside this).
    // Use the scope-level timeout override (from test.use({ timeout })) when
    // it exceeds the default, so tests that need more time actually get it.
    const defaultTestTimeoutMs = opts.config.timeout * 3;
    const testTimeoutMs = scopeTimeout ? Math.max(defaultTestTimeoutMs, scopeTimeout) : defaultTestTimeoutMs;
    const maxRetries = opts.config.retries;
    let lastAttempt = 0;
    let attemptStart = testStart;
    // First failed attempt's error + artifacts. When the test ultimately
    // passes on retry (flaky), the FAILURE is what needs debugging — its
    // trace/screenshot/video are linked on the final result (shipping
    // pipelines like the blob reporter only pack linked files) and its
    // error is surfaced via `firstAttemptError`.
    let firstFailure: {
      error: Error;
      tracePath?: string;
      screenshotPath?: string;
      videoPath?: string;
    } | undefined;
    const traceConfig = resolveTraceConfig(opts.config.trace);
    const videoConfig = resolveVideoConfig(opts.config.video);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0 && opts.abortSignal?.aborted) break;
      attemptStart = Date.now();
      // Retry attempts force every deep link cold. The first attempt failed
      // for an unknown reason — a cold terminate + relaunch is the recovery
      // path for simulator states that warm in-process delivery would carry
      // straight into the retry (e.g. a display that stopped updating while
      // the a11y tree stayed healthy, observed on CI July 2026). Attempt 0
      // resets the flag so a previous test's retry doesn't leak into it.
      for (const d of devices) d._setForceColdDeepLinks?.(attempt > 0);
      // Reset per-attempt state. Only the final attempt's artifacts are
      // reported — prior attempt traces/videos are retained on disk via
      // shouldRetain() but not linked from the TestResult.
      status = 'passed';
      error = undefined;
      screenshotPath = undefined;
      tracePath = undefined;
      videoPath = undefined;
      lastAttempt = attempt;

      // Trace recording — start if configured
      const recording = shouldRecord(traceConfig.mode, attempt);
      let traceCollector: TraceCollector | null = null;
      // Devices whose network capture the daemon confirmed this attempt.
      // Draining covers these plus any device whose proxy is still up from
      // an earlier test (`keepRunning: true`) even though this attempt's
      // start failed — otherwise its entries sit in the daemon until the
      // next start discards them, and this test's trace shows no network.
      // A device whose proxy never came up is skipped: stopping a capture
      // that never started prints a "not running" warning on every test.
      const networkCapturingDevices = new Set<Device>();
      const networkDrainDevices = (): Device[] =>
        devices.filter((d) => networkCapturingDevices.has(d) || d._networkProxyRunning);
      // UI mode's live view builds its own metadata, so it is told this
      // attempt's route directly (the trace records it per device in
      // metadata.json): the host-wide one if any device used it, since that
      // is what the Network tab must warn about, else the primary's.
      // Same device set as the packaged metadata (`routedDevices`), so the
      // live view and the saved trace always agree.
      const routedDevices = (): Set<Device> =>
        (traceConfig.network ? new Set(networkDrainDevices()) : new Set<Device>());
      const captureRoute = (): NetworkCaptureRoute | undefined => {
        const routed = routedDevices();
        if ([...routed].some((d) => d._networkCaptureRoute === 'ios-system-proxy')) return 'ios-system-proxy';
        return primary && routed.has(primary) ? primary._networkCaptureRoute : undefined;
      };

      if (recording && primary) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-'));
        // One collector per test, owned by the primary's Tracing; the other
        // devices of the group record into it through the process-wide active
        // collector (their own Tracing holds none), tagging events by device.
        traceCollector = primary.tracing._startManaged(traceConfig, tempDir);
        traceCollector.setTimelineOrigin(attemptStart);
        setActiveTraceCollector(traceCollector);

        // Offset action index so per-test actions don't collide with beforeAll
        if (setupActionCount > 0) {
          traceCollector.setActionIndexOffset(setupActionCount);
        }

        // Start network capture if configured. PILOT-182: iOS traffic
        // routing is now fully owned by tapsmith-core via the macOS Network
        // Extension redirector, so there's no CLI-side proxy setup.
        //
        // The daemon may surface a non-fatal warning (e.g. "SE not approved
        // — run tapsmith setup-ios") via the `errorMessage` field even when
        // `success` is true and the proxy port was allocated. We log it
        // loudly (once per run — same failure applies to every test) so
        // users whose trace has no network entries know exactly why and
        // exactly what to do.
        // Every device of the group captures on its own daemon's proxy.
        //
        // Started one device at a time, deliberately. On iOS simulators each
        // daemon launches the mitmproxy redirector, and the stock launcher
        // reuses any "mitmproxy" Network Extension manager that is not yet
        // `connected` — two launchers inside that ~150ms window overwrite each
        // other's socket path and the second start is skipped. The daemons now
        // serialise launches themselves with a host-wide lock (ios_redirect.rs);
        // waiting for each start to return here keeps a group's own launches
        // apart as well. Each start returns as soon as the extension has
        // connected back; the daemon holds the lock a moment longer in the
        // background, so a following member's start may wait briefly for it.
        //
        // A group also requires per-device isolation: entries are stamped with
        // the capturing device's name, and the system-proxy fallback records
        // the whole Mac, so the daemon refuses it instead of mislabelling.
        if (traceConfig.network) {
          const multiDevice = devices.length > 1;
          const forDevice = (d: Device, msg: string): string =>
            multiDevice && d._traceDeviceId ? `[${d._traceDeviceId}] ${msg}` : msg;
          for (const d of devices) {
            try {
              const res = await d._startNetworkCapture({ requireIsolation: multiDevice, httpPorts: traceConfig.networkHttpPorts });
              if (res.success) networkCapturingDevices.add(d);
              if (!res.success && res.errorMessage) {
                _warnCaptureOnce('Network capture disabled', forDevice(d, res.errorMessage));
              } else if (res.errorMessage) {
                // The daemon joins independent warnings with newlines, and
                // which ones appear varies between the first start and the
                // per-test reuse of a running proxy; dedupe each on its own
                // so a persistent one prints once per run.
                for (const line of res.errorMessage.split('\n')) {
                  if (line.trim()) _warnCaptureOnce('Network capture warning', forDevice(d, line));
                }
              }
            } catch (err) {
              _warnCaptureOnce(
                'Network capture failed to start',
                forDevice(d, err instanceof Error ? err.message : String(err)),
              );
            }
          }
        }

        // Start device log streaming if configured
        if (traceConfig.deviceLogs && traceCollector) {
          for (const d of devices) {
            try {
              d._startDeviceLogStream(traceCollector);
            } catch (err) {
              _warnCaptureOnce(
                'Device log streaming failed to start',
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }

        // Start daemon log streaming if configured
        if (traceConfig.daemonLogs && traceCollector) {
          for (const d of devices) {
            try {
              d._startDaemonLogStream(traceCollector);
            } catch (err) {
              _warnCaptureOnce(
                'Daemon log streaming failed to start',
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
      }

      // Video recording — bracket the test the same way `trace` does (PILOT-114).
      // Recording happens regardless of whether trace is enabled. Failures
      // here are surfaced via _warnCaptureOnce and never abort the run; the
      // daemon already returns structured errors in `errorMessage` rather
      // than throwing for missing-ffmpeg / unmatched-AVF-device cases.
      // Video is recorded on the primary device only: a multi-device test
      // would need per-device files and a shared timeline anchor to be useful.
      const videoRecording = shouldRecord(videoConfig.mode, attempt);
      if (videoRecording && primary) {
        try {
          const res = await primary._startVideoRecording(
            videoConfig.size ? { size: videoConfig.size } : undefined,
          );
          if (!res.success) {
            _warnCaptureOnce(
              'Video recording failed to start',
              res.errorMessage || 'unknown error',
            );
          }
        } catch (err) {
          _warnCaptureOnce(
            'Video recording failed to start',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Create request fixture outside try so it's accessible in trace finalization
      const requestContext = new APIRequestContext({
        baseURL: opts.config.baseURL,
        extraHTTPHeaders: opts.config.extraHTTPHeaders,
      });

      // Declare fixture state outside try so afterEach hooks and teardown
      // are accessible in the finally block.
      // Prefer the per-test registry (set by test.extend()) over the global one.
      const registry = entry.registry ?? getFixtureRegistry();
      const baseFixtures: Record<string, unknown> = {
        ...suiteFixtures,
        request: requestContext,
      };
      const mapNetworkEntries = createNetworkMapper(attemptStart);
      const latestByDevice = new Map<Device, NetworkSnapshots>();
      const snapshotsFor = (d: Device): NetworkSnapshots => {
        let snapshots = latestByDevice.get(d);
        if (!snapshots) { snapshots = new NetworkSnapshots(); latestByDevice.set(d, snapshots); }
        return snapshots;
      };
      const networkSnapshotEntries = (): DeviceNetworkEntries => [...latestByDevice].map(([d, snapshots]) => ({
        deviceId: d._traceDeviceId,
        entries: filterEntriesByHosts(snapshots.entries, { allow: traceConfig.networkHosts, deny: traceConfig.networkIgnoreHosts }),
      }));
      let stopLiveNetwork = async (): Promise<void> => {};
      let testFixtureTeardown: (() => Promise<void>) | undefined;
      let allFixtures: Record<string, unknown> = baseFixtures;

      try {
        // ── Setup phase (not subject to test timeout) ──
          // Hooks and fixture resolution run outside the test timeout so that
          // slow operations like restartApp() under heavy load don't eat into
          // the budget for the actual test assertions.

          // Notify UI mode on first attempt only — retries re-use the same
          // test slot in the UI rather than creating duplicate entries.
          const announced = beforeAllFirstFullName ?? inherited.announced;
          if (attempt === 0 && fullName !== announced) {
            if (opts.onTestStart) await opts.onTestStart(fullName, { policy });
            opts.reporter?.onTestStart?.(fullName, opts.testFilePath, { project: opts.projectName });
          }

          opts.onNetworkEntries?.([], traceConfig.network, captureRoute());
          if (traceCollector && opts.onNetworkEntries) {
            const liveCollector = traceCollector;
            const unsupported = new Set<Device>();
            stopLiveNetwork = startLiveNetwork(async () => {
              if (traceConfig.network) {
                await Promise.all(networkDrainDevices().map(async (d) => {
                  if (unsupported.has(d)) return;
                  try {
                    const snapshots = snapshotsFor(d);
                    const res = await d._snapshotNetworkCapture(snapshots.knownBodies());
                    if (!res.success) throw new Error(res.errorMessage);
                    snapshots.update(res.entries);
                  } catch (err) {
                    if (isAbortError(err) || opts.abortSignal?.aborted) return;
                    if ((err as { code?: number }).code === 12) unsupported.add(d);
                    _warnCaptureOnce('Live network snapshot unavailable', err instanceof Error ? err.message : String(err));
                  }
                }));
              }
              return mapNetworkEntries(
                networkSnapshotEntries(),
                liveCollector.events, requestContext.getNetworkEntries(),
              );
            }, (entries) => opts.onNetworkEntries?.(entries, traceConfig.network, captureRoute()), opts.abortSignal);
          }

          // Replay beforeAll events into this test's trace so they appear in
          // the packaged archive for every test. UI streaming is skipped for
          // the first test, which already received beforeAll's live-streamed
          // events (recording them here is still needed — during beforeAll
          // the active collector was the standalone beforeAll collector, so
          // no test's own collector has these events).
          if (traceCollector) {
            if (!beforeAllCollector) {
              for (const rec of inherited.recordings) {
                replayBeforeAllEvents(
                  traceCollector, rec.events, rec.collector, rec.hierarchies,
                  fullName !== inherited.announced,
                );
              }
            }
            if (savedBeforeAllEvents.length > 0) {
              replayBeforeAllEvents(
                traceCollector, savedBeforeAllEvents, beforeAllCollector, beforeAllHierarchies,
                fullName !== beforeAllFirstFullName,
              );
            }
          }

          // Open the beforeEach group before running setup work and hooks.
          // Heavy setup (session readiness, idle waits, user beforeEach hooks)
          // is captured inside this group so device actions don't appear as
          // ungrouped top-level events in the trace viewer.
          const hasTestScopedFixtures = registry.byScope('test').size > 0;
          const hasBeforeEachWork =
            !!opts.beforeEachTest || !!primary || allBeforeEach.length > 0 || hasTestScopedFixtures;
          // Per-test app reset (appResetScope: 'test'). Runs on every attempt
          // so a retry genuinely starts from the declared state; retries
          // deliver the warm hook cold (see _setForceColdDeepLinks above).
          // It records into its own APP RESET group, ahead of BEFORE EACH,
          // so the hooks group holds only the user's code. The reset itself
          // ends with a session readiness check, so it needs no prior
          // beforeEachTest recovery — a dead app just takes the ladder's
          // restart rung, and the trace says so.
          if (policy.scope === 'test' && canReset) {
            await runTracedAppReset(traceCollector, opts, policy, {
              phase: `before test ${fullName}`,
              forceCold: attempt > 0,
            });
            opts._prepared?.clear();
            if (opts._applied) opts._applied.current = policy;
          }
          // The test (and its beforeEach hooks) is about to touch the app, so
          // an entry reset's state is no longer reusable by a later reset.
          opts._prepared?.clear();

          if (hasBeforeEachWork) {
            traceCollector?.startGroup('beforeEach Hooks');
          }

          // Setup work that may issue device actions (e.g. ensureSessionReady
          // in UI worker mode). Runs inside the beforeEach group.
          if (opts.beforeEachTest) {
            await opts.beforeEachTest(fullName);
          }

          // Wait for the device to be idle before each test. This ensures
          // previous test actions (toasts, animations, async operations) have
          // settled before hooks and assertions start, preventing flakiness
          // under load (e.g. parallel workers sharing host CPU).
          // Best effort — don't fail the test if an idle wait times out.
          await forEachDeviceBestEffort(opts, (d) => d.waitForIdle());

          if (hasTestScopedFixtures) {
            // Collect the fixture names destructured by the test and its hooks.
            // If any function takes a fixtures parameter without destructuring
            // (e.g. `(fixtures) => fixtures.foo`), we can't determine which
            // fixtures it needs, so we fall back to resolving all of them.
            const requestedNames = new Set<string>();
            let canBeLazy = true;
            const fns = [entry.fn, ...allBeforeEach.map(h => h.fn), ...allAfterEach.map(h => h.fn)];
            for (const fn of fns) {
              const names = fixtureParameterNames(fn);
              if (names.length > 0) {
                for (const name of names)
                  requestedNames.add(name);
              } else if (functionHasParameters(fn)) {
                // Function takes parameters but doesn't destructure — resolve all
                canBeLazy = false;
                break;
              }
            }

            const resolved = await resolveFixtures(
              registry, 'test', baseFixtures,
              canBeLazy ? [...requestedNames] : undefined,
            );
            allFixtures = resolved.fixtures;
            testFixtureTeardown = resolved.teardown;
          }

          for (const hook of allBeforeEach) {
            validateHookFixtures(hook, registry, 'beforeEach');
            await invokeHook(hook, allFixtures);
          }
          if (hasBeforeEachWork) {
            traceCollector?.endGroup();
          }

          // ── Test body (subject to test timeout) ──
          const testFn = async () => {
            traceCollector?.startGroup('Test');
            try {
              // Call with fixtures if the test function expects arguments
              if (entry.fn.length > 0) {
                await (entry.fn as (fixtures: Record<string, unknown>) => void | Promise<void>)(allFixtures);
              } else {
                await (entry.fn as () => void | Promise<void>)();
              }
            } finally {
              traceCollector?.endGroup();
            }
          };

          // Wrap only the test body with a timeout — hooks run outside this
          // so slow setup (restartApp, navigation) under load doesn't cause
          // spurious timeouts. Also raced against the run's abort signal so a
          // user stop interrupts even pure-JS waits that never touch the
          // device (in-flight device calls are cancelled via the gRPC client).
          //
          // The body runs inside an attempt-fence context: a timed-out body
          // cannot be cancelled (Promise.race only abandons it), so once the
          // race settles the token is closed and any device RPC the zombie
          // body still issues rejects immediately instead of racing the
          // retry on the shared device.
          let testTimer: ReturnType<typeof setTimeout> | undefined;
          let onTestAbort: (() => void) | undefined;
          const abortSignal = opts.abortSignal;
          const attemptToken: AttemptToken = { closed: false };
          // Time spent inside progress-tracked device actions does not count
          // toward the test timeout: those actions carry their own bounded
          // deadlines (agent budgets, gRPC deadlines, daemon-side recovery
          // caps up to ~7 minutes for a deep link that rides out a simulator
          // reboot), so a CoreSimulator stall that stretches one of them must
          // not consume the whole test budget and kill the test while the
          // framework is actively — and successfully — recovering. The wall
          // clock still caps the attempt (WALL_CAP × the timeout) so a test
          // looping bounded actions forever cannot run unbounded.
          //
          // Subscribe BEFORE creating the body promise: the body executes
          // synchronously up to its first await, so a device action as the
          // first statement emits its start event during creation.
          const WALL_CAP_MULTIPLIER = 5;
          const excluded = { totalMs: 0, depth: 0, inFlightSince: 0 };
          const unsubscribeProgress = onActionProgress((ev) => {
            if (ev.kind === 'start') {
              if (excluded.depth++ === 0) excluded.inFlightSince = Date.now();
            } else if (ev.kind === 'end' && excluded.depth > 0) {
              if (--excluded.depth === 0) excluded.totalMs += Date.now() - excluded.inFlightSince;
            }
          });
          const bodyStart = Date.now();
          const bodyPromise = runInAttemptContext(attemptToken, testFn);
          // The race may abandon the body; its eventual rejection (fenced
          // device calls) must not surface as an unhandled rejection.
          bodyPromise.catch(() => {});
          try {
            await Promise.race([
              bodyPromise,
              new Promise<never>((_, reject) => {
                // A timeout Error's own stack is just this timer callback plus
                // node timer internals — useless to the user. Re-point it at
                // the operation that was in flight when time ran out (its
                // user-code frames were registered via setPendingOperation),
                // so reporters render a snippet of the test line that was
                // executing, not framework code. Read here, before the catch
                // block's failPendingOperation clears the registration.
                const timeoutError = (message: string): Error => {
                  const err = new Error(message);
                  const frames = traceCollector?.pendingOperationStack;
                  if (frames && frames.length > 0) {
                    err.stack = `Error: ${message}\n`
                      + frames.map((f) => `    at ${f.file}:${f.line}:${f.column ?? 1}`).join('\n');
                  }
                  return err;
                };
                const check = (): void => {
                  const wallMs = Date.now() - bodyStart;
                  const inFlightMs = excluded.depth > 0 ? Date.now() - excluded.inFlightSince : 0;
                  const countedMs = wallMs - excluded.totalMs - inFlightMs;
                  if (countedMs >= testTimeoutMs) {
                    reject(timeoutError(
                      `Test timed out after ${testTimeoutMs}ms`
                      + (wallMs - countedMs > 1_000
                        ? ` (${Math.round(wallMs / 1000)}s wall clock; ${Math.round((wallMs - countedMs) / 1000)}s inside device actions excluded)`
                        : ''),
                    ));
                    return;
                  }
                  if (wallMs >= testTimeoutMs * WALL_CAP_MULTIPLIER) {
                    reject(timeoutError(
                      `Test timed out after ${Math.round(wallMs / 1000)}s wall clock `
                      + `(cap: ${WALL_CAP_MULTIPLIER}× the ${testTimeoutMs}ms test timeout; `
                      + `${Math.round((wallMs - countedMs) / 1000)}s inside device actions)`,
                    ));
                    return;
                  }
                  testTimer = setTimeout(check, Math.min(1_000, testTimeoutMs));
                };
                testTimer = setTimeout(check, Math.min(1_000, testTimeoutMs));
              }),
              ...(abortSignal ? [new Promise<never>((_, reject) => {
                // An already-aborted signal never fires 'abort' for new
                // listeners — reject straight away in that case.
                if (abortSignal.aborted) {
                  reject(new TestAbortedError());
                  return;
                }
                onTestAbort = () => reject(new TestAbortedError());
                abortSignal.addEventListener('abort', onTestAbort, { once: true });
              })] : []),
            ]);
          } finally {
            attemptToken.closed = true;
            // Clear the timeout here (not via testFn().finally) so an abort
            // settling the race doesn't leave a long-lived timer behind.
            if (testTimer) clearTimeout(testTimer);
            unsubscribeProgress();
            if (onTestAbort) abortSignal?.removeEventListener('abort', onTestAbort);
          }
        } catch (err) {
          status = 'failed';
          error = err instanceof Error ? err : new Error(String(err));
          if (isAbortError(error) || opts.abortSignal?.aborted) {
            error = new TestAbortedError();
          }

          // Fail any in-flight traced action/assertion so it appears in the trace
          traceCollector?.failPendingOperation(error.message);

          // If a WebView/CDP operation is the thing that hit the runner timeout,
          // close it before screenshot/network teardown so stale async work does
          // not bleed into the next test.
          if (error.message.startsWith('Test timed out after ')) {
            await forEachDeviceBestEffort(opts, (d) => d._disposeWebViewManager?.());
          }

          // Screenshot on failure — skipped on user stop: the capture RPC
          // would be cancelled anyway, and a stop isn't a failure worth
          // documenting.
          if (opts.config.screenshot !== 'never' && !isAbortError(error)) {
            screenshotPath = await captureFailureScreenshots(
              opts,
              opts.screenshotDir,
              fullName,
            );
          }
        } finally {
          try {
            // Run afterEach hooks (always, with full fixtures available)
            if (allAfterEach.length > 0) {
              traceCollector?.startGroup('afterEach Hooks');
              for (const hook of allAfterEach) {
                try {
                  validateHookFixtures(hook, registry, 'afterEach');
                  await invokeHook(hook, allFixtures);
                } catch (err) {
                  process.stderr.write(`[tapsmith] afterEach hook error: ${err instanceof Error ? err.message : String(err)}\n`);
                }
              }
              traceCollector?.endGroup();
            }

            // Tear down test-scoped fixtures after afterEach hooks have run
            if (testFixtureTeardown) {
              await testFixtureTeardown();
            }
          } finally {
            // Finish any read before draining capture or changing test attribution.
            await stopLiveNetwork();
            requestContext.dispose();
          }
        }

      // Clean up route interception between tests so routes don't leak
      // across tests within the same describe block.
      await forEachDeviceBestEffort(opts, async (d) => {
        if (d._routeManager?.hasRoutes) await d._routeManager.removeAllRoutes();
      });

      // Collect soft assertion failures (PILOT-43)
      const softErrors = flushSoftErrors();
      if (softErrors.length > 0) {
        const messages = softErrors.map((e) => e.message).join('\n');
        const softErrorSummary = `${softErrors.length} soft assertion(s) failed:\n${messages}`;

        if (status !== 'failed') {
          status = 'failed';
          error = new Error(softErrorSummary);
        } else if (error) {
          error.message += `\n\n--- Additionally ---\n${softErrorSummary}`;
        }

        if (!screenshotPath && opts.config.screenshot !== 'never' && !opts.abortSignal?.aborted) {
          screenshotPath = await captureFailureScreenshots(
            opts,
            opts.screenshotDir,
            fullName,
          );
        }
      }

      // Screenshot on success if mode is "always"
      if (status === 'passed' && opts.config.screenshot === 'always') {
        screenshotPath = await captureFailureScreenshots(
          opts,
          opts.screenshotDir,
          fullName,
        );
      }

      // Finalize trace recording
      if (traceCollector && primary) {
        // Stop device + daemon log streaming first — no async cleanup needed.
        // Stopping per-test (not just on Device.close) keeps the streams from
        // outliving the test they belong to: on a shared Device, a later test
        // with logs disabled would otherwise keep streaming into this finalized
        // collector (leak + cross-test pollution).
        for (const d of devices) {
          d._stopDeviceLogStream();
          d._stopDaemonLogStream();
        }

        // Drain per-test network entries BEFORE disposing the route manager —
        // the proxy may still have in-flight requests that need the gRPC
        // stream alive to receive route decisions. The daemon keeps the
        // proxy/routing alive here; runTestFile performs the hard teardown
        // once after the file so soft-reset tests do not churn device routing.
        // Each device's daemon runs its own proxy with its own index space,
        // so entries are collected per device and re-indexed when merged.
        if (traceConfig.network) {
          for (const d of networkDrainDevices()) {
            try {
              const res = await d._stopNetworkCapture({ keepRunning: true });
              if (res.success) {
                // Apply user-supplied host filters, if any. On physical iOS
                // and Android emulators the proxy is system-wide and captures
                // every app's traffic — this is how users scrub system
                // services (captive portal, analytics, Google/iCloud sync)
                // out of their trace archives. iOS simulators filter per-PID
                // via the macOS Network Extension redirector, so filters are
                // usually redundant for sim runs but still honoured.
                const filtered = filterEntriesByHosts(res.entries, {
                  allow: traceConfig.networkHosts,
                  deny: traceConfig.networkIgnoreHosts,
                });
                if (
                  traceConfig.networkHosts &&
                  traceConfig.networkHosts.length > 0 &&
                  res.entries.length > 0 &&
                  filtered.length === 0
                ) {
                  console.warn(
                    `[tapsmith] trace.networkHosts allowlist matched 0 of ${res.entries.length} captured entries — trace will have no network data.`,
                  );
                }
                snapshotsFor(d).update(res.entries);
              } else {
                console.warn(`[tapsmith] Network capture stopped with error: ${res.errorMessage}`);
              }
            } catch (err) {
              console.warn(`[tapsmith] Failed to stop network capture: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        for (const d of devices) {
          // Keep the route stream installed while network capture is being
          // reused across tests. Registered routes were removed above, and the
          // file-level hard teardown disposes the stream after stopping capture.
          if (!traceConfig.network && d._disposeRouteManager) {
            await d._disposeRouteManager();
          }
          // Return to the native context but keep the WebView connection cached
          // across tests — reconnecting per test churns webinspectord on iOS and
          // triggers wedged/stale page sessions (PILOT-288). A dead connection
          // is detected and re-established on next use; the file-level hard
          // teardown closes it for real.
          if (d._resetWebViewContext) {
            d._resetWebViewContext();
          }
        }

        // Capture a final screenshot so the last action has an "after" view.
        // The trace viewer uses the next action's before-screenshot as "after",
        // so this provides the terminal state. One per device (primary first);
        // each capture reserves its own index, so the frames never collide.
        if (traceCollector.config.screenshots) {
          for (const d of devices) {
            try {
              const tracing = d.tracing;
              const { actionIndex: finalIdx } = await traceCollector.captureBeforeAction(
                tracing['_getScreenshot'],
                tracing['_getHierarchy'],
              );
              // Flush to UI mode live stream — emit a lightweight event so the
              // screenshot buffer reaches the frontend.
              traceCollector.emitPendingCaptures(finalIdx);
            } catch {
              // Best-effort: on a stopped run this screenshot RPC rejects with
              // TestAbortedError — letting it escape would skip the rest of
              // the finalization, including the video-recording stop below,
              // leaking the recorder on the daemon (PILOT-235).
            }
          }
        }

        const collector = primary.tracing._stopManaged();
        setActiveTraceCollector(null);

        const networkEntries = await mapNetworkEntries(
          networkSnapshotEntries(), collector?.events ?? [], requestContext.getNetworkEntries(),
        );

        // Notify UI mode with the full set of network entries (device + API)
        if (networkEntries && opts.onNetworkEntries) {
          opts.onNetworkEntries(networkEntries, traceConfig.network, captureRoute());
        }
        if (collector) {
          const retain = shouldRetain(traceConfig.mode, status === 'passed', attempt);
          if (retain) {
            // Flush any pending after-action captures before packaging
            await collector.flushPendingCaptures();
            try {
              const outputDir = path.resolve(
                opts.config.rootDir,
                opts.config.outputDir,
                'traces',
              );
              const version = getPackageVersion();
              const sourceFiles = opts.testFilePath && traceConfig.sources
                ? [opts.testFilePath]
                : undefined;
              tracePath = packageTrace(collector, {
                testFile: opts.testFilePath ?? '',
                testName: fullName,
                testStatus: status,
                testDuration: Date.now() - attemptStart,
                startTime: attemptStart,
                endTime: Date.now(),
                // Every device whose entries were drained into this trace —
                // including one whose start failed this attempt while its
                // proxy kept running — records the route those entries took.
                ...(await traceDeviceMetadata(opts, routedDevices())),
                tapsmithVersion: version,
                error: error?.message,
                outputDir,
                sourceFiles,
                networkEntries,
                project: opts.projectName,
                appState: policy.appState || undefined,
                appReset: policy.mode,
                appResetScope: policy.scope,
                retry: attempt > 0 ? attempt : undefined,
              });
            } catch {
              // Trace packaging is best-effort
            }
          }
          collector.cleanup();
        }
      } else {
        // No tracing — still need to clean up routes and reset the WebView
        // context (the connection itself stays cached across tests, see the
        // traced path above / PILOT-288).
        for (const d of devices) {
          if (!d._disposeRouteManager) continue;
          await d._disposeRouteManager();
          if (d._resetWebViewContext) {
            d._resetWebViewContext();
          }
        }
      }

      // Stop video recording and decide whether to keep the MP4 (PILOT-114).
      // Always stop if we started — even when retain decides to discard, the
      // child process must be cleaned up so the next test can start fresh.
      if (videoRecording && primary) {
        try {
          const res = await primary._stopVideoRecording();
          const retainVideo = shouldRetain(
            videoConfig.mode,
            status === 'passed',
            attempt,
          );
          if (res.success && res.videoPath && retainVideo) {
            try {
              const videoDir = path.resolve(
                opts.config.rootDir,
                opts.config.outputDir,
                'videos',
              );
              await fsPromises.mkdir(videoDir, { recursive: true });
              const safeName = fullName.replace(/[^a-zA-Z0-9_-]/g, '_');
              const filePath = path.join(
                videoDir,
                `${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`,
              );
              await fsPromises.copyFile(res.videoPath, filePath);
              await fsPromises.unlink(res.videoPath);
              videoPath = filePath;
            } catch (err) {
              _warnCaptureOnce(
                'Video recording failed to write',
                err instanceof Error ? err.message : String(err),
              );
            }
          } else if (res.success && res.videoPath) {
            // Not retaining — clean up the temp file.
            try {
              await fsPromises.unlink(res.videoPath);
            } catch (unlinkErr) {
              _warnCaptureOnce('Video temp file cleanup failed', unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
            }
          } else if (!res.success && res.errorMessage) {
            _warnCaptureOnce('Video recording stopped with error', res.errorMessage);
          }
        } catch (err) {
          _warnCaptureOnce(
            'Video recording failed to stop',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (status === 'passed' || attempt === maxRetries || opts.abortSignal?.aborted) break;

      // A file-abort-worthy failure (e.g. "session recovered during before
      // test" — the app was relaunched by infra, destroying beforeAll-
      // established state) must NOT be consumed by per-test retries: the
      // retries would run against the recovered app without the file's
      // beforeAll navigation/setup, fail with ordinary assertion errors, and
      // erase the infra signal that makes the worker retry the whole file
      // (which re-runs beforeAll). Break so this error stays the test's
      // final error and the abort check below fires.
      if (error && opts.abortFileOnError?.(error)) break;

      if (!firstFailure && error) {
        firstFailure = { error, tracePath, screenshotPath, videoPath };
      }

      // Report the intermediate failure so reporters can show each attempt
      opts.reporter?.onTestEnd?.({
        name: entry.name,
        fullName,
        status,
        durationMs: Date.now() - attemptStart,
        error,
        screenshotPath,
        tracePath,
        videoPath,
        project: opts.projectName,
        retry: attempt,
        _willRetry: true,
        filePath: opts.testFilePath,
      });
    }

    // Flaky pass: link the first FAILED attempt's artifacts in place of the
    // passing retry's — the failure is the thing worth opening. Falls back
    // to the retry's own artifacts when the failed attempt has none (e.g.
    // trace mode 'on-first-retry' records nothing on the first attempt).
    // Provenance is recorded per artifact so reporters can label which
    // paths belong to the failure vs the passing retry.
    let failedAttemptArtifacts: TestResult['failedAttemptArtifacts'];
    if (status === 'passed' && firstFailure) {
      failedAttemptArtifacts = {
        screenshot: !!firstFailure.screenshotPath || undefined,
        trace: !!firstFailure.tracePath || undefined,
        video: !!firstFailure.videoPath || undefined,
      };
      tracePath = firstFailure.tracePath ?? tracePath;
      screenshotPath = firstFailure.screenshotPath ?? screenshotPath;
      videoPath = firstFailure.videoPath ?? videoPath;
    }

    const setupMs = setupHolder.pendingMs;
    setupHolder.pendingMs = 0;
    const testResult: TestResult = {
      name: entry.name,
      fullName,
      status,
      durationMs: Date.now() - attemptStart + setupMs,
      error,
      screenshotPath,
      tracePath,
      videoPath,
      project: opts.projectName,
      retry: lastAttempt > 0 ? lastAttempt : undefined,
      firstAttemptError: status === 'passed' ? firstFailure?.error : undefined,
      failedAttemptArtifacts,
      filePath: opts.testFilePath,
      ...(setupMs > 0 ? { setupMs } : {}),
    };
    result.tests.push(testResult);
    opts.reporter?.onTestEnd?.(testResult);

    if (status === 'failed' && error && opts.abortFileOnError?.(error)) {
      opts._abortFileController?.abort();
      break;
    }
  }

  // Run child suites
  for (const suiteEntry of ctx.suites) {
    // Abort: same semantics as the test loop — stop here without recording
    // the remaining suites' tests as 'skipped'.
    if (opts.abortSignal?.aborted) break;

    const shouldSkip = suiteEntry.skip || (hasOnly && !suiteEntry.only && !hasOnlyTests);

    if (shouldSkip) {
      // Mark all tests in skipped suite as skipped (we still need to discover them)
      const childCtx = materializeSuiteEntry(suiteEntry);
      const prefix = parentPrefix ? `${parentPrefix} > ${suiteEntry.name}` : suiteEntry.name;
      const skippedResult = skipAll(childCtx, prefix);
      result.suites.push(skippedResult);
      continue;
    }

    const childCtx = materializeSuiteEntry(suiteEntry);
    const prefix = parentPrefix ? `${parentPrefix} > ${suiteEntry.name}` : suiteEntry.name;
    const childInherited: InheritedScopeSetup = {
      announced: beforeAllFirstFullName ?? inherited.announced,
      setup: setupHolder,
      // This scope's recording already contains the inherited setup, so it
      // replaces the inherited list rather than extending it.
      recordings: beforeAllCollector
        ? [{
            events: savedBeforeAllEvents,
            collector: beforeAllCollector,
            hierarchies: beforeAllHierarchies,
            actionCount: setupActionCount,
          }]
        : inherited.recordings,
    };
    const childResult = await runSuiteContext(
      childCtx, prefix, allBeforeEach, allAfterEach, opts, policy, childInherited,
    );
    result.suites.push(childResult);
  }

  // Run afterAll hooks with tracing (same pattern as beforeAll).
  // Events are streamed to the UI tagged with the last test that ran, and
  // appended to that test's already-packaged trace archive so teardown
  // actions are visible in headless runs too (the archive was written when
  // the test finished — beforeAll-style replay into a live collector is no
  // longer possible at this point).
  if (scopeHasRunnable && ctx.afterAll.length > 0 && primary) {
    const traceConfig = resolveTraceConfig(opts.config.trace);
    // Find the last test that actually ran, to tag events. Derived from the
    // recorded results (which include nested suites, already executed by
    // this point) rather than re-deriving skip/.only/filter predicates —
    // a suite whose direct tests were all filtered out can still have run
    // tests in nested describes, and those are the right attribution target.
    const lastRunTest = shouldRecord(traceConfig.mode, 0)
      ? [...collectResults(result)].reverse().find((r) => r.status !== 'skipped')
      : undefined;
    // When no test ran at all, skip traced streaming entirely: there is no
    // test to attach the events to, and streaming them anyway would pollute
    // whichever test the UI last tagged (potentially one from an earlier
    // suite) with this suite's hook events.
    if (lastRunTest) {
      if (opts.onTestStart) {
        // attributionOnly: this test already ended — we only re-tag the
        // afterAll trace events to it, we are not starting it again.
        await opts.onTestStart(lastRunTest.fullName, { attributionOnly: true });
      }

      // The archive to amend: the trace linked on the last run test's result
      // (absent when it wasn't retained, e.g. retain-on-failure with a pass).
      //
      // The collector records with UNSHIFTED indices — UI mode's live stream
      // applies its own shift to events arriving after an attribution-only
      // re-tag (main.tsx hookShiftRef) — so the offset is applied at append
      // time instead: past the archive's actionCount, plus one per device to
      // skip the terminal end-of-test screenshots registered from index
      // actionCount without an event. That mirrors the UI's shift (highest
      // seen index including markers, +1), keeping stream and archive
      // indices aligned.
      const targetTracePath = lastRunTest.tracePath;
      let actionIndexOffset = 0;
      if (targetTracePath) {
        try {
          actionIndexOffset = readTraceActionCount(targetTracePath) + Math.max(1, devices.length);
        } catch {
          // Unreadable archive — skip the amendment.
        }
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-aa-'));
      const managedCollector = primary.tracing._startManaged(traceConfig, tempDir);
      const afterAllCollector = new TraceCollector(traceConfig, tempDir);
      afterAllCollector.setTimelineOrigin(Date.now());
      const cb = managedCollector.getEventCallback();
      if (cb) afterAllCollector.setEventCallback(cb);
      primary.tracing._stopManaged();

      try {
        afterAllCollector.startGroup('afterAll Hooks');
        await withActiveTraceCollector(afterAllCollector, async () => {
          for (const hook of ctx.afterAll) {
            try {
              await invokeHookWithTestScope(hook, suiteFixtures, suiteRegistry);
            } catch (err) {
              process.stderr.write(`[tapsmith] afterAll hook error: ${err instanceof Error ? err.message : String(err)}\n`);
            }
          }
        });
        afterAllCollector.endGroup();
        await afterAllCollector.flushPendingCaptures();
        if (targetTracePath && actionIndexOffset > 0) {
          try {
            appendEventsToTrace(targetTracePath, afterAllCollector, Date.now(), actionIndexOffset);
          } catch {
            // Trace amendment is best-effort, like packaging.
          }
        }
      } finally {
        // The temp dir must go even if something above escapes the
        // per-hook catches — a leak here also leaves screenshots behind.
        afterAllCollector.cleanup();
      }
    } else {
      for (const hook of ctx.afterAll) {
        try {
          await invokeHookWithTestScope(hook, suiteFixtures, suiteRegistry);
        } catch (err) {
          process.stderr.write(`[tapsmith] afterAll hook error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  } else if (scopeHasRunnable) {
    // No test ran in this scope → no teardown either (beforeAll was skipped too).
    for (const hook of ctx.afterAll) {
      try {
        await invokeHookWithTestScope(hook, suiteFixtures, suiteRegistry);
      } catch (err) {
        process.stderr.write(`[tapsmith] afterAll hook error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  // Clean up beforeAll trace temp dir (screenshots are no longer needed)
  if (beforeAllCollector) {
    beforeAllCollector.cleanup();
  }

  } finally {
    // Restore previous device timeouts when leaving this scope
    if (prevDeviceTimeouts) {
      devices.forEach((d, i) => d._setDefaultTimeout(prevDeviceTimeouts[i]));
    }
    if (prevDeviceColdEvery) {
      devices.forEach((d, i) => d._setAppResetColdEvery(prevDeviceColdEvery[i]));
    }
  }

  result.durationMs = Date.now() - suiteStart;
  return result;
}

function skipAll(ctx: SuiteContext, prefix: string): SuiteResult {
  const result: SuiteResult = { name: prefix, tests: [], suites: [], durationMs: 0 };
  for (const t of ctx.tests) {
    const fullName = prefix ? `${prefix} > ${t.name}` : t.name;
    result.tests.push({ name: t.name, fullName, status: 'skipped', durationMs: 0 });
  }
  for (const s of ctx.suites) {
    const childCtx = materializeSuiteEntry(s);
    const childPrefix = prefix ? `${prefix} > ${s.name}` : s.name;
    result.suites.push(skipAll(childCtx, childPrefix));
  }
  return result;
}

/**
 * Mark all tests in a context as failed with the given error.
 * Used when beforeAll hooks throw — individual tests never got a chance to run.
 */
function failAll(ctx: SuiteContext, prefix: string, error: Error, project?: string, screenshotPath?: string, tracePath?: string): SuiteResult {
  const result: SuiteResult = { name: prefix, tests: [], suites: [], durationMs: 0 };
  for (const t of ctx.tests) {
    const fullName = prefix ? `${prefix} > ${t.name}` : t.name;
    result.tests.push({ name: t.name, fullName, status: 'failed', durationMs: 0, error, project, screenshotPath, tracePath });
  }
  for (const s of ctx.suites) {
    const childCtx = materializeSuiteEntry(s);
    const childPrefix = prefix ? `${prefix} > ${s.name}` : s.name;
    result.suites.push(failAll(childCtx, childPrefix, error, project, screenshotPath, tracePath));
  }
  return result;
}

/**
 * Collect all test results flattened from a suite tree.
 */
export function collectResults(suite: SuiteResult): TestResult[] {
  const results: TestResult[] = [...suite.tests];
  for (const child of suite.suites) {
    results.push(...collectResults(child));
  }
  return results;
}

/**
 * Mark tests that failed on a discarded file-level retry attempt as flaky in
 * the retried suite's results. File-level retries (infra recovery) re-run the
 * whole file and return only the second attempt — without this, a test that
 * failed and then passed on the file retry reports as a clean pass, hiding
 * the failure from the flaky count, annotations, and reports. Mirrors what
 * the per-test retry loop records via `retry` + `firstAttemptError`.
 */
export function markFileRetryFlakes(firstAttempt: SuiteResult, retried: SuiteResult): void {
  const firstErrors = new Map(
    collectResults(firstAttempt)
      .filter((t) => t.status === 'failed' && t.error)
      .map((t) => [t.fullName, t.error]),
  );
  if (firstErrors.size === 0) return;
  const annotate = (suite: SuiteResult): void => {
    for (const t of suite.tests) {
      const firstError = firstErrors.get(t.fullName);
      if (firstError && t.status === 'passed') {
        t.retry = t.retry ?? 1;
        t.firstAttemptError = t.firstAttemptError ?? firstError;
      }
    }
    suite.suites.forEach(annotate);
  };
  annotate(retried);
}

/**
 * Run a single test file. The file is imported (which registers tests via the
 * global `test` / `describe` functions), then executed sequentially.
 */
/**
 * The devices an embedder handed the runner must be exactly the project's
 * group: `use.devices` when the project declares one, else the run config's
 * `devices`, else a single device. Too few, and the tests destructure
 * `devices` members that do not exist and fail on the first `bob.tap()` with
 * an error that names nothing useful. Too many — a worker holding its
 * target's largest group handed all of it to a single-device project — and
 * the project silently drives a device it never declared, with a trace
 * labelled by another project's names. Every run path shares this check, so
 * an embedder that forgot to slice its sessions fails here, loudly.
 */
function assertDeviceGroupMatches(opts: RunOptions, declared: TapsmithConfig['devices']): void {
  if (opts.devices.length === 0) return;
  const effective = declared ?? opts.config.devices;
  const wanted = deviceGroupSize({ devices: effective });
  if (opts.devices.length === wanted) return;
  const subject = opts.projectName ? `Project "${opts.projectName}"` : 'The project';
  const declares = effective === undefined
    ? 'declares no device group (a single device)'
    : `declares a device group of ${wanted} (use.devices)`;
  throw new Error(
    `${subject} ${declares} but the run was given ${opts.devices.length} device(s) `
    + `(${opts.devices.map((d) => `${d.name}=${d.serial ?? '?'}`).join(', ')}). `
    + 'The embedder resolved the group from the wrong config — this is a Tapsmith bug, please report it.',
  );
}

/**
 * Name the run's devices after the project's group, position by position, for
 * the duration of the run. An embedder's sessions are named for its target's
 * largest group (`alice`, `bob`); a project on that target declaring no group
 * runs on `alice` — but its trace must not name a device it never declared,
 * so it runs as `device-1` there with events untagged, as in any
 * single-device run. Returns the restore for the embedder's own names.
 */
function applyRunDeviceNames(opts: RunOptions, declared: TapsmithConfig['devices']): () => void {
  const group = resolveDeviceGroup({ devices: declared ?? opts.config.devices, device: opts.config.device });
  const previous = opts.devices.map((rd) => ({ rd, name: rd.name, tag: rd.device._traceDeviceId }));
  opts.devices.forEach((rd, i) => {
    rd.name = group[i]?.name ?? rd.name;
    rd.device._traceDeviceId = opts.devices.length > 1 ? rd.name : undefined;
  });
  return () => {
    for (const p of previous) {
      p.rd.name = p.name;
      p.rd.device._traceDeviceId = p.tag;
    }
  };
}

export async function runTestFile(
  filePath: string,
  opts: RunOptions,
): Promise<SuiteResult> {
  // Reset context and fixture registry for the new file. Registration
  // calls (test(), test.beforeEach(), etc.) sync activeFixtureRegistry
  // back to the extended test's registry, so even cached ESM imports
  // that skip test.extend() re-execution will restore the correct registry.
  setContextStack([]);
  setActiveFixtureRegistry(new FixtureRegistry());
  pushContext();

  // Import the test file — this registers tests/suites via side effects
  // and may call test.extend() to register fixtures.
  // Node.js caches ESM imports by URL. Persistent processes (UI workers)
  // that re-run the same file must bust the cache with a unique query.
  const importUrl = opts.bustImportCache ? `${filePath}?t=${Date.now()}` : filePath;
  await import(importUrl);

  const rootCtx = popContext();

  // Apply project-level use options as a base layer under file-level test.use()
  if (opts.projectUseOptions) {
    rootCtx.useOptions = { ...opts.projectUseOptions, ...rootCtx.useOptions };
  }
  assertDeviceGroupMatches(opts, rootCtx.useOptions?.devices);
  const restoreDeviceNames = applyRunDeviceNames(opts, rootCtx.useOptions?.devices);

  // Build a merged registry from all per-test/hook registries in the file.
  // Using getFixtureRegistry() (the mutable global) would only reflect the
  // last syncRegistry() call, missing worker fixtures from earlier extends.
  const allEntryRegistries = new Set<FixtureRegistry>();
  collectFixtureRegistries(rootCtx, allEntryRegistries);
  let fileRegistry = new FixtureRegistry();
  for (const r of allEntryRegistries) {
    fileRegistry = fileRegistry.merge(r);
  }

  // Resolve worker-scoped fixtures once for the entire file
  const primary = primaryDevice(opts);
  const baseFixtures: Record<string, unknown> = {
    ...(primary ? { device: primary, devices: allDevices(opts) } : {}),
    ...(opts.projectName != null ? { projectName: opts.projectName } : {}),
    platform: resolvePlatformFixture(opts.config),
  };
  let workerFixtures: Record<string, unknown> = opts.workerFixtures ?? {};
  let workerTeardown: (() => Promise<void>) | undefined;

  if (!fileRegistry.isEmpty) {
    const resolved = await resolveFixtures(fileRegistry, 'worker', {
      ...baseFixtures,
      ...workerFixtures,
    });
    workerFixtures = resolved.fixtures;
    workerTeardown = resolved.teardown;
  }

  const abortFileController = opts.abortFileOnError ? new AbortController() : undefined;
  const fileOpts: RunOptions = {
    ...opts,
    workerFixtures,
    testFilePath: filePath,
    _prepared: new Map(opts.devices.flatMap((d) => (d.prepared ? [[d.name, d.prepared] as const] : []))),
    _applied: {},
    _abortFileController: abortFileController,
    abortSignal: abortFileController
      ? (opts.abortSignal
        ? AbortSignal.any([abortFileController.signal, opts.abortSignal])
        : abortFileController.signal)
      : opts.abortSignal,
  };

  // Arm in-flight RPC cancellation for the duration of the file: Device,
  // ElementHandle, and expect all share this client instance, so a user stop
  // (or abortFileOnError) cancels the current device call instead of riding
  // out its timeout (PILOT-222).
  for (const d of allDevices(fileOpts)) d._client._setAbortSignal(fileOpts.abortSignal);

  const fileStartedAt = Date.now();
  try {
    const suite = await runSuiteContext(rootCtx, '', [], [], fileOpts);
    reportRunTelemetry(fileOpts, suite, Date.now() - fileStartedAt);
    return suite;
  } finally {
    for (const d of allDevices(fileOpts)) d._client._setAbortSignal(undefined);
    restoreDeviceNames();
    try {
      if (workerTeardown) {
        await workerTeardown();
      }
    } finally {
      const traceConfig = resolveTraceConfig(fileOpts.config.trace);
      for (const d of allDevices(fileOpts)) {
      if (traceConfig.mode !== 'off' && traceConfig.network) {
        try {
          // Keep the proxy (and its port) alive across files, draining only.
          // A warm reset keeps the app process between files, so its HTTP
          // keep-alive pool holds sockets to this proxy port; tearing the
          // proxy down per file (churning to a new port on the next file)
          // stranded those sockets, and the app's first requests in the next
          // file stalled ~15-25s reusing dead connections before reconnecting
          // — long enough to blow route-mock assertions. The proxy is released
          // for real at Device.close() (session end); the daemon also cleans
          // up on shutdown. Mirrors the iOS macOS system-proxy session model.
          await d._stopNetworkCapture({ keepRunning: true });
        } catch {
          // Best-effort; the daemon cleans up the proxy on shutdown regardless.
        }
      }
      // Keep the route-decision stream open across files when the proxy is
      // kept alive above: closing it at the boundary releases any request the
      // proxy is holding for a decision, so the first request of the next file
      // falls through to the real server (a ~24s stall that blows the mock
      // assertion). Routes are already removed per-test, and Device.close()
      // disposes the manager for real. When network is off, dispose here as
      // before (nothing keeps it alive).
      if (d._disposeRouteManager
        && !(traceConfig.mode !== 'off' && traceConfig.network)) {
        await d._disposeRouteManager();
      }
      // Hard teardown of the cross-test cached WebView connection (kept
      // alive between tests, see per-test teardown / PILOT-288).
      if (d._disposeWebViewManager) {
        await d._disposeWebViewManager();
      }
      }
    }
  }
}

/**
 * One anonymous usage event per completed file: counts and mode only, never
 * names (PILOT-330). Fire-and-forget and fenced — telemetry can never fail a
 * run. Files with no devices (the runner's own unit tests) report nothing.
 */
function reportRunTelemetry(opts: RunOptions, suite: SuiteResult, durationMs: number): void {
  if (opts.devices.length === 0) return;
  try {
    const results = collectResults(suite);
    // Don't count an attempt that will be RETRIED because of a recoverable
    // infrastructure failure (agent disconnect, gRPC unavailable): reporting
    // the discarded attempt would emit a second event and inflate `failed` on
    // exactly the infra-flaky files (PILOT-330 review). Only the retry-capable
    // paths set `abortFileOnError` (the CLI, parallel workers, and UI workers,
    // which loop on `isRecoverableInfrastructureError`); watch and MCP run a
    // file exactly once with in-place recovery, so their single infra-degraded
    // run is the real outcome and must still be counted (PILOT-330 review 2).
    if (opts.abortFileOnError
      && results.some((r) => r.status === 'failed' && isRecoverableInfrastructureError(r.error))) {
      return;
    }
    telemetry.recordRun(opts.config, runEventFromResults(
      results,
      { mode: opts.runMode, platform: resolvePlatformFixture(opts.config), devices: opts.devices.length },
      durationMs,
    ));
  } catch {
    // Telemetry never surfaces.
  }
}

// ─── Test discovery (UI mode) ───

/** Isolation-relevant `test.use()` options, cascaded down the describe tree. */
export interface DiscoveredUseOptions {
  appReset?: UseOptions['appReset']
  appResetScope?: UseOptions['appResetScope']
  appState?: string
}

export interface DiscoveredTest {
  name: string
  fullName: string
  only: boolean
  skip: boolean
  /** Effective isolation options for this test (suite cascade applied). */
  use?: DiscoveredUseOptions
}

export interface DiscoveredSuite {
  name: string
  tests: DiscoveredTest[]
  suites: DiscoveredSuite[]
  /** Effective isolation options for this suite (parent cascade applied). */
  use?: DiscoveredUseOptions
}

function pickDiscoveredUse(
  parent: DiscoveredUseOptions | undefined,
  own: UseOptions | undefined,
): DiscoveredUseOptions | undefined {
  // `appState` is scope-local (a nested describe without it declares none);
  // `appReset` / `appResetScope` cascade like every other config key.
  const use: DiscoveredUseOptions = {};
  const appReset = own?.appReset ?? parent?.appReset;
  const appResetScope = own?.appResetScope ?? parent?.appResetScope;
  if (appReset !== undefined) use.appReset = appReset;
  if (appResetScope !== undefined) use.appResetScope = appResetScope;
  if (own?.appState !== undefined) use.appState = own.appState;
  return Object.keys(use).length > 0 ? use : undefined;
}

/**
 * Import a test file and collect its test/suite tree without executing
 * any test bodies. Used by UI mode for test discovery.
 */
export async function discoverTestFile(filePath: string): Promise<DiscoveredSuite> {
  setContextStack([]);
  setActiveFixtureRegistry(new FixtureRegistry());
  pushContext();

  // Bust ESM cache so re-discovery in persistent processes (UI workers)
  // picks up file changes instead of returning stale cached modules.
  const importUrl = `${filePath}?t=${Date.now()}`;
  await import(importUrl);

  const rootCtx = popContext();
  return discoverSuiteContext(rootCtx, '', undefined);
}

function discoverSuiteContext(
  ctx: SuiteContext,
  parentPrefix: string,
  parentUse: DiscoveredUseOptions | undefined,
): DiscoveredSuite {
  const use = pickDiscoveredUse(parentUse, ctx.useOptions);
  const tests: DiscoveredTest[] = ctx.tests.map((t) => ({
    name: t.name,
    fullName: parentPrefix ? `${parentPrefix} > ${t.name}` : t.name,
    only: t.only,
    skip: t.skip,
    ...(use ? { use } : {}),
  }));

  const suites: DiscoveredSuite[] = [];
  for (const entry of ctx.suites) {
    const suitePrefix = parentPrefix ? `${parentPrefix} > ${entry.name}` : entry.name;
    const childCtx = materializeSuiteEntry(entry);
    suites.push(discoverSuiteContext(childCtx, suitePrefix, use));
  }

  return { name: parentPrefix, tests, suites, ...(use ? { use } : {}) };
}

/** @internal — exposed for unit testing only. */
function resetFixtureRegistry(): void { setActiveFixtureRegistry(new FixtureRegistry()); }
export const _internal = { pushContext, popContext, runSuiteContext, resolvePlatformFixture, resetFixtureRegistry };
