/**
 * Anonymous, opt-out usage telemetry (PILOT-330).
 *
 * Without usage numbers there is no way to tell five users from five
 * thousand, so nothing to prioritise against. This module reports the
 * minimum needed for that: one event per test-file run (which run mode,
 * which platform, how many tests passed/failed, how long it took) plus a
 * one-off `install` event when a machine's anonymous id is first created,
 * each stamped with the SDK, Node and OS versions.
 *
 * What is deliberately NOT collected: test names, locators, app or package
 * identifiers, file paths, device serials, hostnames, usernames, IP-derived
 * location — anything that could identify a project or a person. The
 * payload is a closed set of fields (see {@link TelemetryPayload}), and the
 * unit tests assert exactly that key set so an accidental widening fails CI.
 *
 * Opt out with `telemetry: false` in `tapsmith.config.ts`, or with
 * `TAPSMITH_TELEMETRY=0` (also honoured: the `DO_NOT_TRACK` convention).
 * A one-time notice is printed on the first run so nobody learns about this
 * from a network log. See `docs/telemetry.md`.
 *
 * Every send is fire-and-forget, bounded by a short timeout, and swallows
 * every error: telemetry must never slow a run down, print a warning, or
 * change an exit code — offline CI machines included.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TapsmithConfig } from './config.js';

// ─── Types ───

/**
 * Which embedder ran the file. One value per run path (see CLAUDE.md, "The
 * five run paths"); UI mode's own watch and MCP re-runs all go through the
 * UI worker and so count as `ui`.
 */
export type RunMode = 'test' | 'test-parallel' | 'ui' | 'watch' | 'mcp';

/** What a completed test-file run reports. Counts only — never names. */
export interface TelemetryRunEvent {
  mode: RunMode;
  platform: 'android' | 'ios';
  /** Size of the device group the file ran on (1 for ordinary projects). */
  devices: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * The complete wire payload — nothing outside this set is ever sent. It is a
 * PostHog capture envelope (`POST /i/v0/e/`): the processor is PostHog's EU
 * cloud, and any PostHog-compatible endpoint (a self-hosted instance, a
 * proxy) can receive it via `TAPSMITH_TELEMETRY_ENDPOINT`.
 */
export interface TelemetryPayload {
  /** PostHog project token — public by design, like every PostHog client key. */
  api_key: string;
  event: 'tapsmith install' | 'tapsmith run';
  /** Random UUID stored in `~/.tapsmith/telemetry.json`; not derived from anything. */
  distinct_id: string;
  timestamp: string;
  properties: TelemetryProperties;
}

/** Event properties. Flat, so PostHog can break down and filter on each. */
export interface TelemetryProperties {
  /** Random per-process id so a run's files can be grouped; never persisted. */
  session_id: string;
  sdk_version: string;
  node_version: string;
  os: NodeJS.Platform;
  arch: string;
  ci: boolean;
  /** Which client sent it, PostHog's convention. */
  $lib: 'tapsmith';
  $lib_version: string;
  /** Never derive a location from the connection (belt; the project setting that discards IPs is braces). */
  $geoip_disable: true;
  /** Anonymous events: no person profile is ever built for the id. */
  $process_person_profile: false;
  // `tapsmith run` only:
  mode?: RunMode;
  platform?: 'android' | 'ios';
  devices?: number;
  tests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  duration_ms?: number;
}

interface TelemetryState {
  /**
   * Random per-machine id. Optional: it is minted only when something is
   * actually sent, so `tapsmith telemetry disable` on a fresh machine can
   * persist the switch below without creating an identifier (PILOT-330 review).
   */
  anonymousId?: string;
  createdAt: string;
  noticeShown: boolean;
  /** Machine-wide switch set by `tapsmith telemetry enable|disable`. Absent means on. */
  enabled?: boolean;
  /**
   * Set once the `install` event has been accepted (HTTP 2xx). Until then any
   * later process resends it, so a first run that exits before the install
   * lands is not lost forever.
   */
  installReported?: boolean;
}

export interface TelemetryOptions {
  /** Where the anonymous id and notice flag live. Default `~/.tapsmith/telemetry.json`. */
  stateFile?: string;
  /** Collector URL. Default: `TAPSMITH_TELEMETRY_ENDPOINT`, else the public collector. */
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  sdkVersion?: string;
  /** PostHog project token. Default: the Tapsmith project's. Empty disables sending (dry runs still print). */
  apiKey?: string;
  /**
   * Groups every event of one Tapsmith invocation. Default:
   * `TAPSMITH_TELEMETRY_SESSION` (set once by the CLI/MCP entry point and
   * inherited by every forked child), else a fresh id. See {@link ensureSessionEnv}.
   */
  sessionId?: string;
  /** Where the first-run notice is written. Default: stderr. */
  writeNotice?: (text: string) => void;
  /**
   * Whether the notice actually reaches a person: only then is it marked
   * shown. Default: stderr is a TTY, or this is CI (whose log is read). An
   * MCP server whose stderr is the host's log file leaves the flag unset so a
   * later interactive run still prints it. Test seam.
   */
  noticeVisible?: boolean;
  /** Where `TAPSMITH_TELEMETRY_DEBUG` dry-run payloads are written. Default: stderr. */
  writeDebug?: (text: string) => void;
}

/** Why telemetry is off, in precedence order: the first that applies wins. */
export type TelemetryOffReason = 'env' | 'config' | 'machine';

/** What `tapsmith telemetry status` reports. */
export interface TelemetryStatus {
  enabled: boolean;
  /** Set only when `enabled` is false. */
  reason?: TelemetryOffReason;
  /** True when `TAPSMITH_TELEMETRY_DEBUG` is set: payloads print to stderr and nothing is sent. */
  debug: boolean;
  stateFile: string;
  /** Present once the machine has an id (absent on a machine that has never run or has opted out first). */
  anonymousId?: string;
  endpoint: string;
}

// ─── Constants ───

export const TELEMETRY_DOCS_URL = 'https://tapsmith.dev/reference/telemetry/';
/** PostHog EU cloud single-event capture. */
const DEFAULT_ENDPOINT = 'https://eu.i.posthog.com/i/v0/e/';
/**
 * The Tapsmith PostHog project token. Public by design (every PostHog client
 * ships one); it can only write events, never read them. An empty string
 * turns every send into a silent no-op (tests use the `apiKey` option).
 */
const POSTHOG_PROJECT_KEY = 'phc_mgZ8EcfsLqrJKjRRJL2K99cfeDPUjVaqVY78MYNH329B';
const SEND_TIMEOUT_MS = 3_000;
/** Stop trying for the rest of the process after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 3;
const FALSEY = new Set(['0', 'false', 'no', 'off']);

// ─── Version ───

/** The SDK's own version, read from the package manifest next to `dist/` (or `src/`). */
export function readSdkVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Enablement ───

function envDisables(env: NodeJS.ProcessEnv): boolean {
  const flag = env.TAPSMITH_TELEMETRY?.trim().toLowerCase();
  if (flag !== undefined && FALSEY.has(flag)) return true;
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt !== undefined && dnt !== '' && !FALSEY.has(dnt)) return true;
  return false;
}

/**
 * Whether telemetry is on for this process and config. The env var wins
 * over the config key in both directions so a CI job can switch it off
 * without touching a shared config, and a machine-wide `DO_NOT_TRACK` is
 * respected as the wider tooling ecosystem does.
 */
export function isTelemetryEnabled(
  config: Pick<TapsmithConfig, 'telemetry'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envDisables(env)) return false;
  return config?.telemetry !== false;
}

function isCI(env: NodeJS.ProcessEnv): boolean {
  return !!(env.CI && env.CI !== 'false');
}

/** `TAPSMITH_TELEMETRY_DEBUG` set to anything but an explicit false. */
function isDebug(env: NodeJS.ProcessEnv): boolean {
  const flag = env.TAPSMITH_TELEMETRY_DEBUG?.trim().toLowerCase();
  return flag !== undefined && flag !== '' && !FALSEY.has(flag);
}

/**
 * A custom telemetry endpoint must not send anonymous data in cleartext.
 * `https` is always allowed; `http` only to a loopback host (a local proxy or
 * a self-hosted instance on the same machine). Anything else — cleartext to a
 * remote host, or an unparseable URL — is refused, and sending is disabled
 * rather than silently falling back to the public collector.
 */
export function isAllowedEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** Environment variable carrying the shared session id across forked children. */
export const SESSION_ENV = 'TAPSMITH_TELEMETRY_SESSION';

/**
 * Stamp a single session id into the environment, once, at the top-level
 * entry point (the CLI's `main`, the MCP server). Every child it forks — the
 * tsx re-exec, parallel workers, UI workers, watch/MCP run children —
 * inherits it through `process.env`, so all their per-file events share one
 * id and a "count distinct sessions" query means "count invocations". Idempotent.
 */
export function ensureSessionEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env[SESSION_ENV]) env[SESSION_ENV] = randomUUID();
}

// ─── Client ───

export class Telemetry {
  private readonly _stateFile: string;
  private readonly _endpoint: string;
  private readonly _env: NodeJS.ProcessEnv;
  private readonly _fetch: typeof fetch;
  private readonly _writeNotice: (text: string) => void;
  private readonly _writeDebug: (text: string) => void;
  private readonly _apiKey: string;
  private readonly _noticeVisible: boolean;
  private _sessionId: string | undefined;
  private _sdkVersion: string | undefined;
  private _state: TelemetryState | undefined;
  /** True once an id has been read from, or written to, disk this process. */
  private _idPersisted = false;
  /** True once this process has already sent (or skipped) its install event. */
  private _installAttempted = false;
  private readonly _pending = new Set<Promise<void>>();
  private _consecutiveFailures = 0;

  constructor(opts: TelemetryOptions = {}) {
    this._env = opts.env ?? process.env;
    this._stateFile = opts.stateFile ?? defaultStateFile();
    // An explicit `opts.endpoint` is an internal/test override and is trusted;
    // a user-provided `TAPSMITH_TELEMETRY_ENDPOINT` must be HTTPS (or loopback
    // HTTP), or sending is disabled — never downgraded to cleartext, never
    // silently redirected to the public collector (CWE-319, CodeRabbit).
    const envEndpoint = this._env.TAPSMITH_TELEMETRY_ENDPOINT;
    if (opts.endpoint !== undefined) {
      this._endpoint = opts.endpoint;
    } else if (envEndpoint !== undefined && envEndpoint !== '') {
      this._endpoint = isAllowedEndpoint(envEndpoint) ? envEndpoint : '';
    } else {
      this._endpoint = DEFAULT_ENDPOINT;
    }
    this._fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this._sdkVersion = opts.sdkVersion;
    this._apiKey = opts.apiKey ?? POSTHOG_PROJECT_KEY;
    this._sessionId = opts.sessionId;
    this._noticeVisible = opts.noticeVisible ?? (!!process.stderr.isTTY || isCI(this._env));
    this._writeNotice = opts.writeNotice ?? ((text) => process.stderr.write(text));
    this._writeDebug = opts.writeDebug ?? ((text) => process.stderr.write(text));
  }

  /**
   * The session id, resolved lazily so a `TAPSMITH_TELEMETRY_SESSION` the
   * entry point sets after this singleton is constructed is still honoured.
   */
  private sessionId(): string {
    return this._sessionId ?? (this._sessionId = this._env[SESSION_ENV] || randomUUID());
  }

  /**
   * Whether this process will report. Env and config (see
   * {@link isTelemetryEnabled}) are checked first, then the machine-wide
   * switch `tapsmith telemetry disable` writes into the state file. Reading
   * the switch never creates the file: a machine that opted out before its
   * first run gets no id and sends no `install`.
   */
  isEnabled(config: Pick<TapsmithConfig, 'telemetry'> | undefined): boolean {
    return this.status(config).enabled;
  }

  /** The effective state and, when off, the single reason that decided it. */
  status(config: Pick<TapsmithConfig, 'telemetry'> | undefined): TelemetryStatus {
    const state = this._peekState();
    const base = {
      debug: isDebug(this._env),
      stateFile: this._stateFile,
      anonymousId: state?.anonymousId,
      endpoint: this._endpoint,
    };
    if (envDisables(this._env)) return { ...base, enabled: false, reason: 'env' };
    if (config?.telemetry === false) return { ...base, enabled: false, reason: 'config' };
    if (state?.enabled === false) return { ...base, enabled: false, reason: 'machine' };
    return { ...base, enabled: true };
  }

  /**
   * Flip the machine-wide switch (`tapsmith telemetry enable|disable`).
   * Returns false when the state file cannot be written, in which case the
   * caller should point at the environment variable instead. Never sends:
   * a machine that opts out before its first run is not an install, and one
   * that opts back in has already been counted or never will be.
   */
  setMachineEnabled(enabled: boolean): boolean {
    // No `anonymousId` here: disabling before the first run must not mint an
    // identifier (PILOT-330 review). One is created only when something sends.
    const current = this._peekState()
      ?? { createdAt: new Date().toISOString(), noticeShown: false };
    // Someone who ran `enable` by hand has read the docs; the notice would
    // only repeat them.
    return this._saveState({ ...current, enabled, noticeShown: current.noticeShown || enabled });
  }

  /**
   * Print the one-time notice if this machine has never seen it, and record
   * that it was shown. Call from the user-facing parent process (the CLI,
   * the MCP server) before the first run — never from a forked child, whose
   * stderr may be captured or interleaved. Returns true when it printed.
   */
  printNoticeIfFirstRun(config: Pick<TapsmithConfig, 'telemetry'> | undefined): boolean {
    try {
      if (!this.isEnabled(config)) return false;
      const state = this._peekState() ?? { createdAt: new Date().toISOString(), noticeShown: false };
      if (state.noticeShown) return false;
      this._writeNotice(telemetryNoticeText());
      // Only burn the once-per-machine flag when the notice actually reached a
      // person. An MCP server whose stderr is the host's log leaves it unset,
      // so a later interactive run still gets its turn (PILOT-330 review).
      if (this._noticeVisible) this._saveState({ ...state, noticeShown: true });
      return true;
    } catch {
      // A closed/broken stderr must not turn the notice into an uncaught
      // exception on the CLI or MCP critical path. Telemetry never surfaces.
      return false;
    }
  }

  /**
   * Report one completed test-file run. Fire-and-forget: returns
   * immediately, never throws, never logs.
   */
  recordRun(config: Pick<TapsmithConfig, 'telemetry'> | undefined, run: TelemetryRunEvent): void {
    if (!this.isEnabled(config)) return;
    try {
      this._maybeSendInstall();
      this._send(this._payload('run', run));
    } catch {
      // Telemetry never surfaces.
    }
  }

  /**
   * Wait (briefly) for in-flight sends so a process that is about to
   * `process.exit()` does not systematically drop its last event. Bounded:
   * an unreachable collector costs at most `maxWaitMs`.
   */
  async flush(maxWaitMs = 750): Promise<void> {
    if (this._pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
      timer.unref();
    });
    try {
      await Promise.race([Promise.allSettled([...this._pending]), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @internal — for tests. */
  get pendingCount(): number {
    return this._pending.size;
  }

  // ─── Internals ───

  private _payload(event: 'install' | 'run', run?: TelemetryRunEvent): TelemetryPayload {
    const sdkVersion = this._sdkVersion ?? (this._sdkVersion = readSdkVersion());
    const properties: TelemetryProperties = {
      session_id: this.sessionId(),
      sdk_version: sdkVersion,
      node_version: process.version,
      os: process.platform,
      arch: process.arch,
      ci: isCI(this._env),
      $lib: 'tapsmith',
      $lib_version: sdkVersion,
      $geoip_disable: true,
      $process_person_profile: false,
    };
    if (run) {
      properties.mode = run.mode;
      properties.platform = run.platform;
      properties.devices = run.devices;
      properties.tests = run.tests;
      properties.passed = run.passed;
      properties.failed = run.failed;
      properties.skipped = run.skipped;
      properties.duration_ms = run.durationMs;
    }
    return {
      api_key: this._apiKey,
      event: event === 'run' ? 'tapsmith run' : 'tapsmith install',
      distinct_id: this._ensureId(),
      timestamp: new Date().toISOString(),
      properties,
    };
  }

  private _send(payload: TelemetryPayload, onOk?: () => void): void {
    if (isDebug(this._env)) {
      // Dry run: show exactly what would have gone over the wire, send nothing.
      this._writeDebug(`[telemetry] ${JSON.stringify(payload)}\n`);
      return;
    }
    // No project token compiled in (a source build before the project
    // existed), or no usable endpoint (a rejected cleartext custom endpoint):
    // there is nowhere to send to.
    if (!this._apiKey || !this._endpoint) return;
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    const attempt = (async () => {
      try {
        const res = await this._fetch(this._endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          // Never follow a redirect: it could downgrade to cleartext or point
          // the anonymous payload at an unintended host (CWE-319, CodeRabbit).
          redirect: 'error',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.ok) {
          this._consecutiveFailures = 0;
          try { onOk?.(); } catch { /* never surface */ }
        } else {
          this._consecutiveFailures++;
        }
        // Drain so the connection can be reused/closed promptly.
        await res.arrayBuffer().catch(() => undefined);
      } catch {
        this._consecutiveFailures++;
      }
    })();
    this._pending.add(attempt);
    void attempt.finally(() => this._pending.delete(attempt));
  }

  /**
   * Send the one-off `install` event unless it has already been acknowledged.
   * The `installReported` flag is persisted only on a 2xx, so a first run that
   * exits before the install lands leaves it unset and the next process
   * resends — installs are not lost to an early exit (PILOT-330 review).
   */
  private _maybeSendInstall(): void {
    if (this._installAttempted) return;
    const state = this._ensureIdState();
    if (state.installReported) {
      this._installAttempted = true;
      return;
    }
    // If the id could not be persisted (read-only home), `installReported`
    // can never stick, so sending would re-fire the install on every future
    // process. Skip it and let a writable machine be the one that counts. In
    // a dry run the id is intentionally unpersisted but we still want the
    // install printed, so debug bypasses this gate.
    if (!this._idPersisted && !isDebug(this._env)) return;
    this._installAttempted = true;
    this._send(this._payload('install'), () => {
      const current = this._peekState() ?? state;
      this._saveState({ ...current, installReported: true });
    });
  }

  /**
   * The persisted state, guaranteeing an `anonymousId`. Minting one is the
   * first thing that ever writes an identifier to disk, so nothing that only
   * reads (status, the notice) creates it.
   */
  private _ensureIdState(): TelemetryState {
    const existing = this._peekState();
    if (existing?.anonymousId) return existing;
    const next: TelemetryState = {
      createdAt: new Date().toISOString(),
      noticeShown: false,
      ...existing,
      anonymousId: randomUUID(),
    };
    if (isDebug(this._env)) {
      // A dry run must not touch the disk: keep the id in memory for this
      // process only, so `TAPSMITH_TELEMETRY_DEBUG=1` leaves no identifier
      // behind (PILOT-330 review).
      this._state = next;
      this._idPersisted = false;
      return next;
    }
    // Best effort: `_saveState` caches `next` in memory even if the write
    // fails, so this process keeps one stable id either way. Whether it
    // reached disk decides if an `install` can be reliably marked reported.
    this._idPersisted = this._saveState(next);
    return next;
  }

  /**
   * Mint and persist the anonymous id in the top-level process before it
   * forks per-file workers, so every worker of a first-ever run reads one
   * shared id from disk instead of each minting its own (PILOT-330 review).
   * No-op when telemetry is off, so it never creates an id for an opted-out
   * machine. Never throws.
   */
  ensureIdentity(config: Pick<TapsmithConfig, 'telemetry'> | undefined): void {
    if (!this.isEnabled(config)) return;
    try { this._ensureIdState(); } catch { /* Telemetry never surfaces. */ }
  }

  private _ensureId(): string {
    return this._ensureIdState().anonymousId!;
  }

  /** The persisted state if there is one — no file is created, nothing is sent. */
  private _peekState(): TelemetryState | undefined {
    if (this._state) return this._state;
    const existing = readState(this._stateFile);
    if (existing) {
      this._state = existing;
      // A state read from disk carrying an id is, by definition, persisted.
      if (existing.anonymousId) this._idPersisted = true;
    }
    return existing;
  }

  private _saveState(state: TelemetryState): boolean {
    this._state = state;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      // Write-then-rename so a concurrent worker never reads a torn file.
      const tmp = `${this._stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this._stateFile);
      return true;
    } catch {
      return false;
    }
  }
}

function readState(file: string): TelemetryState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TelemetryState> | null;
    if (raw === null || typeof raw !== 'object') return undefined;
    const hasId = typeof raw.anonymousId === 'string' && raw.anonymousId.length > 0;
    // A file carrying no usable signal at all — no id, no machine switch, no
    // notice flag — is torn or empty; treat it as absent so a fresh id is
    // minted. A file with only the switch (a `disable` before any run) or only
    // the notice flag is legitimate and kept.
    if (!hasId && typeof raw.enabled !== 'boolean' && raw.noticeShown !== true) return undefined;
    return {
      ...(hasId ? { anonymousId: raw.anonymousId } : {}),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      noticeShown: raw.noticeShown === true,
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      ...(raw.installReported === true ? { installReported: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function defaultStateFile(): string {
  const home = os.homedir();
  if (home) return path.join(home, '.tapsmith', 'telemetry.json');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `tapsmith-${uid}`, 'telemetry.json');
}

/** The first-run notice, verbatim. */
export function telemetryNoticeText(): string {
  return [
    '',
    'Tapsmith collects anonymous usage data to guide development: SDK, Node and OS',
    'versions, platform (Android/iOS), run mode, and pass/fail counts per run.',
    'It never sends test names, locators, app identifiers, or file paths.',
    'Opt out with `tapsmith telemetry disable`, TAPSMITH_TELEMETRY=0, or',
    '`telemetry: false` in tapsmith.config.ts. `tapsmith telemetry status` shows the',
    `current setting. Details: ${TELEMETRY_DOCS_URL}`,
    '',
  ].join('\n') + '\n';
}

/** Build the run event for a finished file from its results. */
export function runEventFromResults(
  results: ReadonlyArray<{ status: 'passed' | 'failed' | 'skipped'; durationMs: number }>,
  base: Pick<TelemetryRunEvent, 'mode' | 'platform' | 'devices'>,
  durationMs: number,
): TelemetryRunEvent {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === 'passed') passed++;
    else if (r.status === 'failed') failed++;
    else skipped++;
  }
  return { ...base, tests: results.length, passed, failed, skipped, durationMs: Math.round(durationMs) };
}

// ─── Process-wide client ───

/**
 * The one client every run path shares. Tests construct their own
 * {@link Telemetry} with a temp state file and a fake `fetchFn`; the runner's
 * tests spy on this instance's `recordRun`.
 */
export const telemetry = new Telemetry();
