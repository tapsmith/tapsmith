import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Telemetry,
  isTelemetryEnabled,
  runEventFromResults,
  telemetryNoticeText,
  readSdkVersion,
  ensureSessionEnv,
  isAllowedEndpoint,
  TELEMETRY_DOCS_URL,
  type TelemetryPayload,
  type TelemetryRunEvent,
} from '../telemetry.js';

const RUN: TelemetryRunEvent = {
  mode: 'test', platform: 'android', devices: 1, tests: 3, passed: 2, failed: 1, skipped: 0, durationMs: 1234,
};

/**
 * The complete, closed set of wire keys — a PostHog capture envelope and its
 * properties. Widening either list is a deliberate act that must also update
 * docs/telemetry.md.
 */
const PAYLOAD_KEYS = ['api_key', 'event', 'distinct_id', 'timestamp', 'properties'].sort();
const COMMON_PROPERTY_KEYS = [
  'session_id', 'sdk_version', 'node_version', 'os', 'arch', 'ci',
  '$lib', '$lib_version', '$geoip_disable', '$process_person_profile',
];
const INSTALL_PROPERTY_KEYS = [...COMMON_PROPERTY_KEYS].sort();
const RUN_PROPERTY_KEYS = [
  ...COMMON_PROPERTY_KEYS,
  'mode', 'platform', 'devices', 'tests', 'passed', 'failed', 'skipped', 'duration_ms',
].sort();

let tempDir: string;
let stateFile: string;

function fakeFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: TelemetryPayload }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) as TelemetryPayload });
    return new Response('', { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function make(opts: {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  notices?: string[];
  endpoint?: string;
  noticeVisible?: boolean;
} = {}): Telemetry {
  return new Telemetry({
    stateFile,
    endpoint: opts.endpoint ?? 'https://collector.test/v1/events',
    env: opts.env ?? {},
    fetchFn: opts.fetchFn ?? fakeFetch().fn,
    sdkVersion: '9.9.9',
    apiKey: 'phc_test',
    // Default the notice to "reaches a person" so tests exercise the common
    // interactive/CI path; the not-visible case is covered explicitly.
    noticeVisible: opts.noticeVisible ?? true,
    writeNotice: (text) => opts.notices?.push(text),
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-telemetry-'));
  stateFile = path.join(tempDir, 'nested', 'telemetry.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isTelemetryEnabled()', () => {
  it('is on by default, including when there is no config at all', () => {
    expect(isTelemetryEnabled(undefined, {})).toBe(true);
    expect(isTelemetryEnabled({}, {})).toBe(true);
    expect(isTelemetryEnabled({ telemetry: true }, {})).toBe(true);
  });

  it('honours the config opt-out', () => {
    expect(isTelemetryEnabled({ telemetry: false }, {})).toBe(false);
  });

  it.each(['0', 'false', 'FALSE', 'no', 'off', ' 0 '])('honours TAPSMITH_TELEMETRY=%j', (value) => {
    expect(isTelemetryEnabled({}, { TAPSMITH_TELEMETRY: value })).toBe(false);
  });

  it.each(['1', 'true', 'yes', ''])('treats TAPSMITH_TELEMETRY=%j as opted in', (value) => {
    expect(isTelemetryEnabled({}, { TAPSMITH_TELEMETRY: value })).toBe(true);
  });

  it('honours the DO_NOT_TRACK convention (any value but an explicit false)', () => {
    expect(isTelemetryEnabled({}, { DO_NOT_TRACK: '1' })).toBe(false);
    expect(isTelemetryEnabled({}, { DO_NOT_TRACK: 'true' })).toBe(false);
    expect(isTelemetryEnabled({}, { DO_NOT_TRACK: '0' })).toBe(true);
    expect(isTelemetryEnabled({}, { DO_NOT_TRACK: '' })).toBe(true);
  });

  it('lets the env var win over the config key in both directions', () => {
    // A CI job can switch it off without touching a shared config…
    expect(isTelemetryEnabled({ telemetry: true }, { TAPSMITH_TELEMETRY: '0' })).toBe(false);
    // …but an env var cannot override an explicit config opt-out.
    expect(isTelemetryEnabled({ telemetry: false }, { TAPSMITH_TELEMETRY: '1' })).toBe(false);
  });
});

describe('Telemetry state file', () => {
  it('creates a random anonymous id on first use and reuses it afterwards', async () => {
    const first = fakeFetch();
    const a = make({ fetchFn: first.fn });
    a.recordRun({}, RUN);
    await a.flush();

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.noticeShown).toBe(false);
    // Owner-only: the id is the one thing that could correlate a machine's runs.
    if (process.platform !== 'win32') {
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    }

    const second = fakeFetch();
    const b = make({ fetchFn: second.fn });
    b.recordRun({}, RUN);
    await b.flush();
    expect(second.calls[0].body.distinct_id).toBe(state.anonymousId);
    // A second process on the same machine is not a second install.
    expect(second.calls.map((c) => c.body.event)).toEqual(['tapsmith run']);
  });

  it('sends an install event exactly when the id is first persisted', async () => {
    const { fn, calls } = fakeFetch();
    const t = make({ fetchFn: fn });
    t.recordRun({}, RUN);
    await t.flush();
    expect(calls.map((c) => c.body.event)).toEqual(['tapsmith install', 'tapsmith run']);
    expect(Object.keys(calls[0].body.properties).sort()).toEqual(INSTALL_PROPERTY_KEYS);
    expect(calls[0].body.distinct_id).toBe(calls[1].body.distinct_id);
    expect(calls[0].body.properties.session_id).toBe(calls[1].body.properties.session_id);
  });

  it('regenerates a corrupt or empty state file', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{not json');
    const { fn, calls } = fakeFetch();
    make({ fetchFn: fn }).recordRun({}, RUN);
    await Promise.resolve();
    expect(calls[0].body.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).anonymousId).toBe(calls[0].body.distinct_id);

    fs.writeFileSync(stateFile, JSON.stringify({ anonymousId: '' }));
    const again = fakeFetch();
    make({ fetchFn: again.fn }).recordRun({}, RUN);
    await Promise.resolve();
    expect(again.calls[0].body.distinct_id).not.toBe('');
  });

  it('falls back to an ephemeral id (and sends no install) when the state cannot be written', async () => {
    // A regular file where the directory should be: mkdir -p fails.
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'nested'), 'in the way');
    const { fn, calls } = fakeFetch();
    const t = make({ fetchFn: fn });
    t.recordRun({}, RUN);
    await t.flush();
    expect(calls.map((c) => c.body.event)).toEqual(['tapsmith run']);
    expect(calls[0].body.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes nothing at all when disabled', async () => {
    const { fn } = fakeFetch();
    const t = make({ fetchFn: fn, env: { TAPSMITH_TELEMETRY: '0' } });
    t.recordRun({}, RUN);
    expect(t.printNoticeIfFirstRun({})).toBe(false);
    await t.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

describe('Telemetry.recordRun()', () => {
  it('POSTs JSON to the endpoint with exactly the documented fields', async () => {
    const { fn, calls } = fakeFetch();
    const t = make({ fetchFn: fn, env: { CI: 'true' } });
    t.recordRun({ telemetry: true }, RUN);
    await t.flush();

    const run = calls.find((c) => c.body.event === 'tapsmith run')!;
    expect(run.url).toBe('https://collector.test/v1/events');
    expect(run.init.method).toBe('POST');
    expect((run.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(run.init.signal).toBeInstanceOf(AbortSignal);

    expect(Object.keys(run.body).sort()).toEqual(PAYLOAD_KEYS);
    expect(Object.keys(run.body.properties).sort()).toEqual(RUN_PROPERTY_KEYS);
    expect(run.body).toMatchObject({
      api_key: 'phc_test',
      event: 'tapsmith run',
      properties: {
        sdk_version: '9.9.9',
        node_version: process.version,
        os: process.platform,
        arch: process.arch,
        ci: true,
        $lib: 'tapsmith',
        $lib_version: '9.9.9',
        $geoip_disable: true,
        $process_person_profile: false,
        mode: 'test',
        platform: 'android',
        devices: 1,
        tests: 3,
        passed: 2,
        failed: 1,
        skipped: 0,
        duration_ms: 1234,
      },
    });
    expect(Date.parse(run.body.timestamp)).not.toBeNaN();
    expect(run.body.properties.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.body.properties.session_id).not.toBe(run.body.distinct_id);
  });

  it('sends nothing when no project token is compiled in (a source build before the project existed)', async () => {
    const { fn } = fakeFetch();
    const t = new Telemetry({
      stateFile,
      env: {},
      fetchFn: fn,
      sdkVersion: '9.9.9',
      apiKey: '',
      writeNotice: () => undefined,
    });
    t.recordRun({}, RUN);
    await t.flush();
    expect(fn).not.toHaveBeenCalled();
    // Still enabled from the user's point of view; the id is created as usual.
    expect(t.status({}).enabled).toBe(true);
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it('defaults to the PostHog EU capture endpoint', () => {
    const t = new Telemetry({ stateFile, env: {}, fetchFn: fakeFetch().fn, writeNotice: () => undefined });
    expect(t.status({}).endpoint).toBe('https://eu.i.posthog.com/i/v0/e/');
  });

  it('ships with the Tapsmith project token compiled in', async () => {
    // Without a token every send is a silent no-op, so a release built with
    // the placeholder would report nothing and nobody would notice.
    const debug: string[] = [];
    const t = new Telemetry({
      stateFile,
      env: { TAPSMITH_TELEMETRY_DEBUG: '1' },
      fetchFn: fakeFetch().fn,
      writeNotice: () => undefined,
      writeDebug: (text) => debug.push(text),
    });
    t.recordRun({}, RUN);
    await t.flush();
    const payload = JSON.parse(debug.at(-1)!.slice('[telemetry] '.length)) as TelemetryPayload;
    expect(payload.api_key).toMatch(/^phc_[A-Za-z0-9]{20,}$/);
  });

  it('reads the endpoint from TAPSMITH_TELEMETRY_ENDPOINT when not given explicitly', async () => {
    const { fn, calls } = fakeFetch();
    const t = new Telemetry({
      stateFile,
      env: { TAPSMITH_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/x' },
      fetchFn: fn,
      sdkVersion: '1.0.0',
      apiKey: 'phc_test',
      writeNotice: () => undefined,
    });
    t.recordRun({}, RUN);
    await t.flush();
    expect(calls[0].url).toBe('http://127.0.0.1:1/x');
  });

  it('refuses a cleartext remote custom endpoint and disables sending (CWE-319)', async () => {
    const { fn } = fakeFetch();
    const t = new Telemetry({
      stateFile,
      env: { TAPSMITH_TELEMETRY_ENDPOINT: 'http://collector.example.com/i/v0/e/' },
      fetchFn: fn,
      apiKey: 'phc_test',
      writeNotice: () => undefined,
    });
    // Endpoint is blanked, not downgraded and not silently pointed at PostHog.
    expect(t.status({}).endpoint).toBe('');
    t.recordRun({}, RUN);
    await t.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('never follows a redirect on send', async () => {
    const seen: RequestInit[] = [];
    const fn = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const t = new Telemetry({ stateFile, endpoint: 'https://c.test/e', env: {}, fetchFn: fn, apiKey: 'phc_test', writeNotice: () => undefined });
    t.recordRun({}, RUN);
    await t.flush();
    expect(seen.every((i) => i.redirect === 'error')).toBe(true);
  });

  it('isAllowedEndpoint requires HTTPS or loopback HTTP', () => {
    expect(isAllowedEndpoint('https://eu.i.posthog.com/i/v0/e/')).toBe(true);
    expect(isAllowedEndpoint('http://localhost:8000/e')).toBe(true);
    expect(isAllowedEndpoint('http://127.0.0.1/e')).toBe(true);
    expect(isAllowedEndpoint('http://[::1]:9000/e')).toBe(true);
    expect(isAllowedEndpoint('http://collector.example.com/e')).toBe(false);
    expect(isAllowedEndpoint('http://10.0.0.5/e')).toBe(false);
    expect(isAllowedEndpoint('ftp://host/e')).toBe(false);
    expect(isAllowedEndpoint('not a url')).toBe(false);
  });

  it('reports ci=false when CI is unset or "false"', async () => {
    for (const env of [{}, { CI: 'false' }]) {
      const { fn, calls } = fakeFetch();
      const t = make({ fetchFn: fn, env });
      t.recordRun({}, RUN);
      await t.flush();
      expect(calls.at(-1)!.body.properties.ci).toBe(false);
    }
  });

  it('does nothing when the config opts out', async () => {
    const { fn } = fakeFetch();
    const t = make({ fetchFn: fn });
    t.recordRun({ telemetry: false }, RUN);
    await t.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('never throws or rejects when the collector is unreachable', async () => {
    const fn = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const t = make({ fetchFn: fn });
    expect(() => t.recordRun({}, RUN)).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalled();
  });

  it('never throws when fetch itself throws synchronously', async () => {
    const fn = vi.fn(() => { throw new Error('boom'); }) as unknown as typeof fetch;
    const t = make({ fetchFn: fn });
    expect(() => t.recordRun({}, RUN)).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
  });

  it('stops trying for the rest of the process after three consecutive failures', async () => {
    const fn = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const t = make({ fetchFn: fn });
    for (let i = 0; i < 6; i++) {
      t.recordRun({}, RUN);
      await t.flush();
    }
    // install + 2 runs = 3 failures, then silence.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('resets the failure count on a success', async () => {
    let status = 500;
    const fn = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
    const t = make({ fetchFn: fn });
    t.recordRun({}, RUN); // install (500) + run (500)
    await t.flush();
    status = 200;
    t.recordRun({}, RUN); // ok → counter back to 0
    await t.flush();
    status = 500;
    for (let i = 0; i < 4; i++) {
      t.recordRun({}, RUN);
      await t.flush();
    }
    // 2 failures, 1 success, then 3 more failures allowed = 6 calls.
    expect(fn).toHaveBeenCalledTimes(6);
  });
});

describe('Telemetry.flush()', () => {
  it('waits for in-flight sends', async () => {
    let resolveSend!: () => void;
    const gate = new Promise<void>((r) => { resolveSend = r; });
    const fn = vi.fn(async () => { await gate; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    const t = make({ fetchFn: fn });
    t.recordRun({}, RUN);
    expect(t.pendingCount).toBeGreaterThan(0);
    let flushed = false;
    const flushing = t.flush(10_000).then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    resolveSend();
    await flushing;
    expect(flushed).toBe(true);
    expect(t.pendingCount).toBe(0);
  });

  it('gives up after the bound so a hung collector cannot hold the process', async () => {
    const fn = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const t = make({ fetchFn: fn });
    t.recordRun({}, RUN);
    const started = Date.now();
    await t.flush(50);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('resolves immediately when nothing is pending', async () => {
    await expect(make().flush()).resolves.toBeUndefined();
  });
});

describe('Telemetry.printNoticeIfFirstRun()', () => {
  it('prints once per machine and records that it did', () => {
    const notices: string[] = [];
    const a = make({ notices });
    expect(a.printNoticeIfFirstRun({})).toBe(true);
    expect(a.printNoticeIfFirstRun({})).toBe(false);
    expect(notices).toEqual([telemetryNoticeText()]);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).noticeShown).toBe(true);

    // A later process (a child, the next day's run) stays quiet.
    const later: string[] = [];
    expect(make({ notices: later }).printNoticeIfFirstRun({})).toBe(false);
    expect(later).toEqual([]);
  });

  it('prints nothing when opted out, and does not mark the notice as shown', () => {
    const notices: string[] = [];
    expect(make({ notices, env: { TAPSMITH_TELEMETRY: '0' } }).printNoticeIfFirstRun({})).toBe(false);
    expect(make({ notices }).printNoticeIfFirstRun({ telemetry: false })).toBe(false);
    expect(notices).toEqual([]);
    // Opting back in later still gets the notice.
    expect(make({ notices }).printNoticeIfFirstRun({})).toBe(true);
  });

  it('says how to opt out and where the details are', () => {
    const text = telemetryNoticeText();
    expect(text).toContain('tapsmith telemetry disable');
    expect(text).toContain('telemetry: false');
    expect(text).toContain('TAPSMITH_TELEMETRY=0');
    expect(text).toContain(TELEMETRY_DOCS_URL);
    expect(text).toMatch(/never sends test names, locators, app identifiers, or file paths/);
  });
});

describe('machine-wide switch (tapsmith telemetry enable|disable)', () => {
  it('disable before any run creates no id for sending and sends nothing, ever', async () => {
    const { fn } = fakeFetch();
    const t = make({ fetchFn: fn });
    expect(t.setMachineEnabled(false)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(persisted).toMatchObject({ enabled: false, noticeShown: false });
    // Opting out before the first run must NOT mint an identifier (PILOT-330 review).
    expect(persisted.anonymousId).toBeUndefined();
    expect(t.status({}).anonymousId).toBeUndefined();

    // A fresh process on this machine, as every later run is.
    const notices: string[] = [];
    const later = make({ fetchFn: fn, notices });
    expect(later.isEnabled({})).toBe(false);
    expect(later.status({})).toMatchObject({ enabled: false, reason: 'machine' });
    later.recordRun({}, RUN);
    expect(later.printNoticeIfFirstRun({})).toBe(false);
    await later.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('enable flips it back, keeps the id, and skips the notice', async () => {
    const first = fakeFetch();
    const a = make({ fetchFn: first.fn });
    a.recordRun({}, RUN);
    await a.flush();
    const id = first.calls[0].body.distinct_id;

    expect(make().setMachineEnabled(false)).toBe(true);
    expect(make().isEnabled({})).toBe(false);
    expect(make().setMachineEnabled(true)).toBe(true);

    const notices: string[] = [];
    const again = fakeFetch();
    const b = make({ fetchFn: again.fn, notices });
    expect(b.isEnabled({})).toBe(true);
    expect(b.printNoticeIfFirstRun({})).toBe(false);
    b.recordRun({}, RUN);
    await b.flush();
    expect(again.calls.map((c) => c.body.event)).toEqual(['tapsmith run']);
    expect(again.calls[0].body.distinct_id).toBe(id);
    expect(notices).toEqual([]);
  });

  it('cannot override the env var or the config opt-out', () => {
    expect(make().setMachineEnabled(true)).toBe(true);
    expect(make({ env: { TAPSMITH_TELEMETRY: '0' } }).status({})).toMatchObject({ enabled: false, reason: 'env' });
    expect(make().status({ telemetry: false })).toMatchObject({ enabled: false, reason: 'config' });
  });

  it('reports false when the state cannot be written', () => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'nested'), 'in the way');
    expect(make().setMachineEnabled(false)).toBe(false);
  });
});

describe('Telemetry.status()', () => {
  it('names the single deciding reason in precedence order: env, config, machine', () => {
    make().setMachineEnabled(false);
    const t = make({ env: { DO_NOT_TRACK: '1' } });
    expect(t.status({ telemetry: false })).toMatchObject({ enabled: false, reason: 'env' });
    expect(make().status({ telemetry: false })).toMatchObject({ enabled: false, reason: 'config' });
    expect(make().status({})).toMatchObject({ enabled: false, reason: 'machine' });
    make().setMachineEnabled(true);
    const on = make().status({});
    expect(on.enabled).toBe(true);
    expect(on.reason).toBeUndefined();
  });

  it('exposes the id, state file, endpoint and debug flag without creating anything', () => {
    const t = make({ env: { TAPSMITH_TELEMETRY_DEBUG: '1' } });
    const s = t.status({});
    expect(s).toMatchObject({ enabled: true, debug: true, stateFile, anonymousId: undefined, endpoint: 'https://collector.test/v1/events' });
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

describe('TAPSMITH_TELEMETRY_DEBUG dry run', () => {
  it('prints every payload to the debug sink and sends nothing', async () => {
    const { fn } = fakeFetch();
    const debug: string[] = [];
    const t = new Telemetry({
      stateFile,
      endpoint: 'https://collector.test/v1/events',
      env: { TAPSMITH_TELEMETRY_DEBUG: '1' },
      fetchFn: fn,
      sdkVersion: '9.9.9',
      apiKey: 'phc_test',
      writeNotice: () => undefined,
      writeDebug: (text) => debug.push(text),
    });
    t.recordRun({}, RUN);
    await t.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(t.pendingCount).toBe(0);
    const payloads = debug.map((line) => {
      expect(line).toMatch(/^\[telemetry\] \{.*\}\n$/);
      return JSON.parse(line.slice('[telemetry] '.length)) as TelemetryPayload;
    });
    expect(payloads.map((p) => p.event)).toEqual(['tapsmith install', 'tapsmith run']);
    expect(Object.keys(payloads[1]).sort()).toEqual(PAYLOAD_KEYS);
    expect(Object.keys(payloads[1].properties).sort()).toEqual(RUN_PROPERTY_KEYS);
    expect(payloads[1].properties).toMatchObject({ mode: 'test', platform: 'android', tests: 3, duration_ms: 1234 });
    // Still counts as enabled — it is a dry run, not an opt-out.
    expect(t.status({})).toMatchObject({ enabled: true, debug: true });
    // A dry run leaves no identifier on disk (PILOT-330 review).
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('treats an explicit false as off', () => {
    expect(make({ env: { TAPSMITH_TELEMETRY_DEBUG: '0' } }).status({}).debug).toBe(false);
    expect(make({ env: { TAPSMITH_TELEMETRY_DEBUG: '' } }).status({}).debug).toBe(false);
  });
});

describe('runEventFromResults()', () => {
  it('tallies statuses and rounds the duration', () => {
    const event = runEventFromResults(
      [
        { status: 'passed', durationMs: 1 },
        { status: 'passed', durationMs: 1 },
        { status: 'failed', durationMs: 1 },
        { status: 'skipped', durationMs: 1 },
      ],
      { mode: 'ui', platform: 'ios', devices: 2 },
      1234.6,
    );
    expect(event).toEqual({ mode: 'ui', platform: 'ios', devices: 2, tests: 4, passed: 2, failed: 1, skipped: 1, durationMs: 1235 });
  });
});

describe('readSdkVersion()', () => {
  it('reads the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
    expect(readSdkVersion()).toBe(pkg.version);
  });
});

describe('install delivery is not lost to an early exit (PILOT-330 review)', () => {
  it('resends the install from a later process until one is acknowledged', async () => {
    // First process: the install POST never lands (process died / network gone).
    const fail = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const a = make({ fetchFn: fail });
    a.recordRun({}, RUN);
    await a.flush();
    // The id is on disk but installReported is not set.
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(persisted.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(persisted.installReported).toBeUndefined();

    // A later process resends the install, and on 2xx marks it reported.
    const ok = fakeFetch();
    const b = make({ fetchFn: ok.fn });
    b.recordRun({}, RUN);
    await b.flush();
    expect(ok.calls.map((c) => c.body.event)).toEqual(['tapsmith install', 'tapsmith run']);
    expect(ok.calls[0].body.distinct_id).toBe(persisted.anonymousId);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).installReported).toBe(true);

    // Once acknowledged, no further process resends it.
    const third = fakeFetch();
    const c = make({ fetchFn: third.fn });
    c.recordRun({}, RUN);
    await c.flush();
    expect(third.calls.map((x) => x.body.event)).toEqual(['tapsmith run']);
  });

  it('sends at most one install per process even across many files', async () => {
    const { fn, calls } = fakeFetch();
    const t = make({ fetchFn: fn });
    t.recordRun({}, RUN);
    t.recordRun({}, RUN);
    t.recordRun({}, RUN);
    await t.flush();
    expect(calls.filter((c) => c.body.event === 'tapsmith install')).toHaveLength(1);
    expect(calls.filter((c) => c.body.event === 'tapsmith run')).toHaveLength(3);
  });
});

describe('session id groups an invocation across processes (PILOT-330 review)', () => {
  it('is read from TAPSMITH_TELEMETRY_SESSION so forked children share it', async () => {
    const parent = fakeFetch();
    const child = fakeFetch();
    const env = { TAPSMITH_TELEMETRY_SESSION: 'shared-session-id' };
    const a = new Telemetry({ stateFile, env, fetchFn: parent.fn, apiKey: 'phc_test', writeNotice: () => undefined });
    const b = new Telemetry({ stateFile, env, fetchFn: child.fn, apiKey: 'phc_test', writeNotice: () => undefined });
    a.recordRun({}, RUN);
    b.recordRun({}, RUN);
    await Promise.all([a.flush(), b.flush()]);
    expect(parent.calls.at(-1)!.body.properties.session_id).toBe('shared-session-id');
    expect(child.calls.at(-1)!.body.properties.session_id).toBe('shared-session-id');
  });

  it('ensureSessionEnv sets the var once and is idempotent', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureSessionEnv(env);
    const first = env.TAPSMITH_TELEMETRY_SESSION;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    ensureSessionEnv(env);
    expect(env.TAPSMITH_TELEMETRY_SESSION).toBe(first);
  });
});

describe('ensureIdentity shares one id across a first-ever parallel run (PILOT-330 review)', () => {
  it('the parent persists an id that forked workers then read, instead of each minting its own', async () => {
    // Parent (CLI/MCP) pre-creates the id before forking.
    make().ensureIdentity({});
    const id = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).anonymousId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // Two "workers" (separate instances) both read that one id.
    const w1 = fakeFetch();
    const w2 = fakeFetch();
    const a = make({ fetchFn: w1.fn });
    const b = make({ fetchFn: w2.fn });
    a.recordRun({}, RUN);
    b.recordRun({}, RUN);
    await Promise.all([a.flush(), b.flush()]);
    expect(w1.calls.every((c) => c.body.distinct_id === id)).toBe(true);
    expect(w2.calls.every((c) => c.body.distinct_id === id)).toBe(true);
  });

  it('mints nothing when telemetry is disabled', () => {
    make({ env: { TAPSMITH_TELEMETRY: '0' } }).ensureIdentity({});
    expect(fs.existsSync(stateFile)).toBe(false);
    make().ensureIdentity({ telemetry: false });
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

describe('first-run notice visibility (PILOT-330 review)', () => {
  it('prints but does not persist "shown" when the notice cannot reach a person', () => {
    const notices: string[] = [];
    // e.g. an MCP server whose stderr is the host's log file.
    const hidden = make({ notices, noticeVisible: false });
    expect(hidden.printNoticeIfFirstRun({})).toBe(true);
    expect(notices).toEqual([telemetryNoticeText()]);
    // Not burned: a later interactive run still gets to print it.
    expect(fs.existsSync(stateFile)).toBe(false);
    const visible = make({ notices, noticeVisible: true });
    expect(visible.printNoticeIfFirstRun({})).toBe(true);
    expect(notices).toHaveLength(2);
  });

  it('never throws when the notice sink is broken', () => {
    const t = new Telemetry({
      stateFile,
      env: {},
      fetchFn: fakeFetch().fn,
      apiKey: 'phc_test',
      noticeVisible: true,
      writeNotice: () => { throw new Error('EBADF'); },
    });
    expect(() => t.printNoticeIfFirstRun({})).not.toThrow();
    expect(t.printNoticeIfFirstRun({})).toBe(false);
  });
});
