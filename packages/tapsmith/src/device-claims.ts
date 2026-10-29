/**
 * Machine-wide device claims.
 *
 * Every Tapsmith session records the devices it drives in a registry under
 * `~/.tapsmith/claims/`, one file per device. A session never selects a device
 * another *live* session holds: a pinned one is refused with a message naming
 * the holder, and auto-pick skips it. Two sessions driving one simulator or
 * emulator otherwise break each other in ways that read as product bugs
 * ("hierarchy contains no elements", "Failed to connect to agent socket").
 *
 * **Session, not process.** A session is one top-level invocation —
 * `tapsmith test` (with or without `--workers`, `--watch` or `--ui`) or
 * `tapsmith mcp-server`. Its identity is stamped into the environment once
 * (`ensureClaimSession`, from the CLI entry point), so every process it forks —
 * parallel workers, watch re-run children, UI workers, an MCP server's
 * `run_tests` CLI — claims as the same session, and re-claiming a device the
 * session already holds always succeeds. Claims are made per device as it is
 * selected; each is held by the session's processes that claimed it, and all
 * are released together when the session's root process exits.
 *
 * **Liveness.** A claim is live while a process holding it runs: its pid
 * still runs and, where recorded, the process start time under that pid is
 * unchanged (a recycled pid is not the holder). A crashed or `kill -9`ed
 * session therefore leaves a claim the next session simply takes over — no
 * manual cleanup — and so does a finished child (a `run_tests` CLI) once no
 * other process of its session holds what it claimed.
 *
 * **Advisory and best-effort.** The registry is a coordination aid, not a
 * security boundary. A registry that cannot be read or written never fails a
 * run: the claim is then not enforced, which is what every session did before.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLockSync } from './file-lock.js';

// ─── Types ───

/** The session a claim belongs to: one top-level Tapsmith invocation. */
export interface SessionIdentity {
  /** Random id shared by every process of the session. */
  id: string
  /** The session's root process — the one whose exit ends the session. */
  pid: number
  /**
   * The root process's start time as `ps -o lstart=` prints it, so a claim
   * whose pid has been recycled by an unrelated process is recognised as stale.
   * Absent where `ps` is unavailable.
   */
  startToken?: string
  /** What started the session, for people: `tapsmith test --ui`. */
  command: string
  /** The directory the session was started in. */
  project: string
  /** ISO time the session started. */
  startedAt: string
}

/** One device held by one session. */
export interface DeviceClaim {
  /** The device's serial (Android) or UDID (iOS). */
  device: string
  session: SessionIdentity
  /** The process that made the claim first (a worker, a watch child, the root). */
  claimantPid: number
  /**
   * The session's processes that hold the claim now: each process that claims
   * the device joins, and each that gives it back ({@link releaseDeviceClaim})
   * leaves; the claim ends when none is left. So one process of a session
   * failing on a device never takes it from another still driving it (an MCP
   * server and its `run_tests` child, the CLI and a worker). Absent on a claim
   * the root alone made.
   */
  holders?: ProcessRef[]
  /** The daemon the session drives this device through most recently, when known. */
  daemonAddress?: string
  /**
   * Every daemon the session has driven this device through (a sequential
   * run's primary daemon and a worker's, say) — each is that session's while
   * pointed at this device.
   */
  daemonAddresses?: string[]
  /** ISO time the claim was made. */
  claimedAt: string
}

/** A process, with its start time so a recycled pid is not taken for it. */
export interface ProcessRef {
  pid: number
  /** {@link SessionIdentity.startToken} for this process. */
  startToken?: string
}

/** A claim as listed, with whether its session is still running. */
export interface ListedDeviceClaim extends DeviceClaim {
  live: boolean
}

/**
 * `fresh` is true when this call made the claim (the session did not already
 * hold the device), so a caller whose setup then fails knows to give it back
 * ({@link releaseDeviceClaim}) — and to leave alone a claim it found.
 */
export type ClaimResult = { ok: true; fresh: boolean } | { ok: false; holder: DeviceClaim };

/** Test seam: where the registry lives, and the environment the session is read from. */
interface ClaimOptions {
  env?: NodeJS.ProcessEnv
}

// ─── Locations ───

/** Overrides the registry directory (tests, isolated QA runs). */
export const CLAIMS_DIR_ENV = 'TAPSMITH_CLAIMS_DIR';
/** Carries the session identity from the root process to everything it forks. */
export const SESSION_ENV = 'TAPSMITH_DEVICE_SESSION';

function claimsDir(env: NodeJS.ProcessEnv): string {
  const override = env[CLAIMS_DIR_ENV];
  if (override) return path.resolve(override);
  // Under the home directory, not `os.tmpdir()`: an MCP client may spawn its
  // server with `TMPDIR` dropped, and two sessions would then disagree about
  // where the registry is (the same reason the MCP daemon registry lives there).
  const home = os.homedir();
  if (home) return path.join(home, '.tapsmith', 'claims');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `tapsmith-${uid}`, 'claims');
}

/** One file per device. `encodeURIComponent` keeps any serial a single, unique file name. */
function claimFile(dir: string, device: string): string {
  const name = encodeURIComponent(device).replace(/^\.+/, (dots) => '%2E'.repeat(dots.length));
  return path.join(dir, `${name}.json`);
}

function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ─── Session identity ───

function isSessionIdentity(value: unknown): value is SessionIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && v.id.length > 0
    && typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0
    && typeof v.command === 'string'
    && typeof v.project === 'string'
    && typeof v.startedAt === 'string'
    && (v.startToken === undefined || typeof v.startToken === 'string');
}

function readSessionEnv(env: NodeJS.ProcessEnv): SessionIdentity | undefined {
  const raw = env[SESSION_ENV];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSessionIdentity(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `ps -o lstart=` for `pid`, or undefined when it cannot be read.
 *
 * Read in the C locale and UTC: the token is compared across sessions, and an
 * MCP server spawned with a pared-down environment would otherwise print the
 * same start time in another language or time zone than the shell that
 * recorded it — and take a live session's device as stale.
 */
const START_TOKEN_TTL_MS = 5_000;
const startTokenCache = new Map<number, { token: string | undefined; at: number }>();

/**
 * {@link readProcessStartToken}, remembered for a few seconds: a registry query
 * judges every holder, and on macOS each judgement spawns `ps` synchronously,
 * which on a loaded host blocks the event loop for long enough to stall MCP
 * tool calls. A pid recycled within the window is the only thing it can miss.
 */
function processStartToken(pid: number): string | undefined {
  const cached = startTokenCache.get(pid);
  if (cached && Date.now() - cached.at < START_TOKEN_TTL_MS) return cached.token;
  const token = readProcessStartToken(pid);
  startTokenCache.set(pid, { token, at: Date.now() });
  return token;
}

function readProcessStartToken(pid: number): string | undefined {
  // Linux: the start time in clock ticks since boot, straight from the
  // kernel. `ps lstart` there is derived from a boot time that procps
  // recomputes on every read, and can come out a second off — a live
  // session would then look like a recycled pid.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Fields after the command name, which is in parentheses and may contain
    // spaces: state is field 3, starttime field 22.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = fields[19];
    if (ticks && /^\d+$/.test(ticks)) return `ticks:${ticks}`;
  } catch {
    // No procfs (macOS): fall through to ps.
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session this process belongs to, creating (and stamping) one with this
 * process as its root if none was inherited.
 *
 * Called once by the CLI entry point before anything is forked, so every child
 * inherits the identity through `process.env`. A root registers an exit hook
 * that drops the session's claims (`exitHook: false` for tests). Idempotent.
 */
export function ensureClaimSession(
  command: string,
  opts: { env?: NodeJS.ProcessEnv; project?: string; exitHook?: boolean } = {},
): SessionIdentity {
  const env = opts.env ?? process.env;
  const inherited = readSessionEnv(env);
  if (inherited) return inherited;
  const identity: SessionIdentity = {
    id: randomUUID(),
    pid: process.pid,
    command,
    project: opts.project ?? process.cwd(),
    startedAt: new Date().toISOString(),
  };
  const token = processStartToken(process.pid);
  if (token) identity.startToken = token;
  env[SESSION_ENV] = JSON.stringify(identity);
  if (opts.exitHook ?? true) {
    // Synchronous file removal is all an 'exit' listener can do, and all this
    // needs. A process that never gets here (SIGKILL, a crash in native code)
    // leaves claims whose pid is dead, which the next session takes over.
    process.once('exit', () => releaseSessionClaims(identity.id, { env }));
  }
  return identity;
}

/**
 * The session this process belongs to: the one inherited from the root, or —
 * for an embedder that never stamped one (the SDK used as a library) — a new
 * session rooted here.
 */
export function currentSession(env: NodeJS.ProcessEnv = process.env): SessionIdentity {
  return readSessionEnv(env) ?? ensureClaimSession('tapsmith', { env });
}

// ─── Liveness ───

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether `ref` is still the process it was when recorded. */
function processIsLive(ref: ProcessRef): boolean {
  if (!pidAlive(ref.pid)) return false;
  if (ref.startToken === undefined) return true;
  const now = processStartToken(ref.pid);
  // Unreadable now (ps failed): trust the live pid rather than steal a device.
  return now === undefined || now === ref.startToken;
}

/**
 * Whether a claim still stands: a process of the session that claimed it is
 * still running. Not the session's root as such — an MCP server whose
 * `run_tests` child claimed devices for its run must not hold them once the
 * run is over, and a CLI whose outer process was killed must keep the claims
 * its tsx child still drives. A claim without holders (none is written so
 * today) falls back to the root.
 */
function claimIsLive(claim: DeviceClaim): boolean {
  return claim.holders && claim.holders.length > 0
    ? claim.holders.some(processIsLive)
    : processIsLive(claim.session);
}

let ownRef: ProcessRef | undefined;
/** This process, as a claim holder. Its start token never changes, so it is read once. */
function thisProcess(): ProcessRef {
  if (!ownRef) {
    const token = processStartToken(process.pid);
    ownRef = token ? { pid: process.pid, startToken: token } : { pid: process.pid };
  }
  return ownRef;
}

// ─── Registry ───

function isDeviceClaim(value: unknown): value is DeviceClaim {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.device === 'string'
    && isSessionIdentity(v.session)
    && typeof v.claimantPid === 'number'
    && typeof v.claimedAt === 'string'
    && (v.daemonAddress === undefined || typeof v.daemonAddress === 'string')
    && (v.daemonAddresses === undefined
      || (Array.isArray(v.daemonAddresses) && v.daemonAddresses.every((a) => typeof a === 'string')))
    && (v.holders === undefined || (Array.isArray(v.holders) && v.holders.every(isProcessRef)));
}

function isProcessRef(value: unknown): value is ProcessRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0
    && (v.startToken === undefined || typeof v.startToken === 'string');
}

function readClaim(file: string): DeviceClaim | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isDeviceClaim(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeClaim(file: string, claim: DeviceClaim): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

/**
 * Run `fn` holding the registry lock. The lock serialises check-then-write
 * across processes; when it cannot be had (contended past the budget, an
 * unwritable directory), `fn` runs anyway — a claim that is occasionally not
 * exclusive is better than a run that fails over coordination.
 */
function withRegistryLock<T>(dir: string, fn: () => T): T {
  if (!ensureDir(dir)) return fn();
  let result: { value: T } | undefined;
  const outcome = withFileLockSync(dir, () => {
    result = { value: fn() as T };
    return true;
  }, { attempts: 80, waitMs: 25 });
  if (outcome.locked && result) return result.value;
  return fn();
}

/** Every daemon address a claim names (older claims carry only `daemonAddress`). */
function addressesOf(claim: DeviceClaim | undefined): string[] {
  if (!claim) return [];
  return [...new Set([...(claim.daemonAddresses ?? []), ...(claim.daemonAddress ? [claim.daemonAddress] : [])])];
}

/**
 * Claim `device` for `session`.
 *
 * Succeeds when the device is free, already this session's, or held by a
 * session that is no longer running (the stale claim is taken over). Fails,
 * returning the holder, when another live session holds it.
 */
export function claimDevice(
  device: string,
  session: SessionIdentity,
  opts: ClaimOptions & { daemonAddress?: string } = {},
): ClaimResult {
  const dir = claimsDir(opts.env ?? process.env);
  return withRegistryLock(dir, (): ClaimResult => {
    const file = claimFile(dir, device);
    const existing = readClaim(file);
    if (existing && existing.session.id !== session.id && claimIsLive(existing)) {
      return { ok: false, holder: existing };
    }
    const sameSession = existing?.session.id === session.id;
    const me = thisProcess();
    const others = sameSession ? (existing?.holders ?? []).filter((h) => h.pid !== me.pid && processIsLive(h)) : [];
    writeClaim(file, {
      device,
      session,
      claimantPid: sameSession && existing ? existing.claimantPid : process.pid,
      holders: [...others, me],
      daemonAddress: opts.daemonAddress ?? (sameSession ? existing?.daemonAddress : undefined),
      daemonAddresses: [...new Set([
        ...(sameSession ? addressesOf(existing) : []),
        ...(opts.daemonAddress ? [opts.daemonAddress] : []),
      ])],
      claimedAt: sameSession && existing ? existing.claimedAt : new Date().toISOString(),
    });
    return { ok: true, fresh: !sameSession };
  });
}

/** Thrown when a device another live session holds is selected. */
export class DeviceClaimedError extends Error {
  constructor(readonly device: string, readonly holder: DeviceClaim) {
    super(
      `Device ${device} is in use by another Tapsmith session: ${describeHolder(holder)}. `
      + 'Two sessions driving one device break each other\'s runs. Stop that session, or pick another '
      + 'device (`--device <serial>`; `tapsmith list-devices` shows which devices are free).',
    );
    this.name = 'DeviceClaimedError';
  }
}

/** {@link claimDevice}, throwing a {@link DeviceClaimedError} naming the holder on refusal. */
export function claimDeviceOrThrow(
  device: string,
  session: SessionIdentity,
  opts: ClaimOptions & { daemonAddress?: string } = {},
): void {
  const res = claimDevice(device, session, opts);
  if (!res.ok) throw new DeviceClaimedError(device, res.holder);
}

/**
 * This process gives back its hold on `session`'s claim of `device` — for a
 * caller whose setup on the device failed, or that stopped driving it, so a
 * session that lives on (UI, watch, an MCP server) does not hold a device it
 * is not driving. The claim ends only when no live process of the session
 * holds it any more; a claim of another session is never touched.
 */
export function releaseDeviceClaim(device: string, session: SessionIdentity, opts: ClaimOptions = {}): void {
  const dir = claimsDir(opts.env ?? process.env);
  withRegistryLock(dir, () => {
    const file = claimFile(dir, device);
    const claim = readClaim(file);
    if (claim?.session.id !== session.id) return;
    const remaining = (claim.holders ?? []).filter((h) => h.pid !== process.pid && processIsLive(h));
    if (remaining.length > 0) {
      writeClaim(file, { ...claim, holders: remaining });
      return;
    }
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  });
}

/** The devices this process holds a claim of `session` on. */
export function devicesHeldByThisProcess(session: SessionIdentity = currentSession(), opts: ClaimOptions = {}): Set<string> {
  return new Set(listDeviceClaims(opts)
    .filter((c) => c.session.id === session.id && (c.holders ?? []).some((h) => h.pid === process.pid))
    .map((c) => c.device));
}

/** Drop every claim `sessionId` holds. */
export function releaseSessionClaims(sessionId: string, opts: ClaimOptions = {}): void {
  const dir = claimsDir(opts.env ?? process.env);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  // Under the lock, re-reading each file: a claim another session took over
  // between a read and the removal must survive.
  withRegistryLock(dir, () => {
    for (const f of files) {
      const file = path.join(dir, f);
      if (readClaim(file)?.session.id !== sessionId) continue;
      try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    }
  });
}

/** Every recorded claim, live or stale, sorted by device. */
export function listDeviceClaims(opts: ClaimOptions = {}): ListedDeviceClaim[] {
  const dir = claimsDir(opts.env ?? process.env);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  // Holders recur across a session's claims: judge each process once.
  const seen = new Map<string, boolean>();
  const live = (ref: ProcessRef): boolean => {
    const key = `${ref.pid}:${ref.startToken ?? ''}`;
    let alive = seen.get(key);
    if (alive === undefined) {
      alive = processIsLive(ref);
      seen.set(key, alive);
    }
    return alive;
  };
  const claims: ListedDeviceClaim[] = [];
  for (const f of files) {
    const claim = readClaim(path.join(dir, f));
    if (!claim) continue;
    const isLive = claim.holders && claim.holders.length > 0 ? claim.holders.some(live) : live(claim.session);
    claims.push({ ...claim, live: isLive });
  }
  return claims.sort((a, b) => a.device.localeCompare(b.device));
}

/** Live claims held by sessions other than `session`, by device. */
function heldElsewhere(session: SessionIdentity, opts: ClaimOptions): Map<string, DeviceClaim> {
  const held = new Map<string, DeviceClaim>();
  for (const claim of listDeviceClaims(opts)) {
    if (!claim.live || claim.session.id === session.id) continue;
    const { live: _live, ...rest } = claim;
    held.set(claim.device, rest);
  }
  return held;
}

/** The devices live sessions other than `session` hold. */
export function devicesHeldElsewhere(
  session: SessionIdentity = currentSession(),
  opts: ClaimOptions = {},
): Set<string> {
  return new Set(heldElsewhere(session, opts).keys());
}

/**
 * Split `candidates` into the devices `session` may take and those another
 * live session holds, keeping the candidates' order. For auto-pick paths: a
 * held device is skipped, not refused.
 */
export function withoutHeldDevices(
  candidates: readonly string[],
  session: SessionIdentity = currentSession(),
  opts: ClaimOptions = {},
): { free: string[]; held: DeviceClaim[] } {
  const elsewhere = heldElsewhere(session, opts);
  const free: string[] = [];
  const held: DeviceClaim[] = [];
  for (const device of candidates) {
    const claim = elsewhere.get(device);
    if (claim) held.push(claim);
    else free.push(device);
  }
  return { free, held };
}

/** `localhost:50051`, `127.0.0.1:50051` and `[::1]:50051` are one daemon. */
function normalizeAddress(address: string): string {
  const port = address.split(':').pop() ?? address;
  const host = address.slice(0, Math.max(0, address.length - port.length - 1)).replace(/^\[|\]$/g, '');
  const loopback = host === '' || host === 'localhost' || host === '::1' || host.startsWith('127.');
  return `${loopback ? 'loopback' : host}:${port}`;
}

/**
 * The live claims other sessions made through the daemon at `address`. When
 * the daemon's active device is one of them, the daemon is that session's,
 * and selecting a device on it would repoint the device it is driving. One
 * session can hold several (a sequential run's projects each claim their
 * device through the same port), so callers match the active device against
 * every one — see {@link daemonDriverElsewhere}.
 */
export function daemonClaimsElsewhere(
  address: string,
  session: SessionIdentity = currentSession(),
  opts: ClaimOptions = {},
): DeviceClaim[] {
  const wanted = normalizeAddress(address);
  return [...heldElsewhere(session, opts).values()]
    .filter((claim) => addressesOf(claim).some((a) => normalizeAddress(a) === wanted));
}

/**
 * The other live session driving its device through the daemon at `address`,
 * judged by the device that daemon is pointed at now (`activeDevice`): an
 * address alone is not proof, since a port a dead daemon left behind can be
 * reused by an unrelated one. `activeDevice` is only asked for when some other
 * session has claimed a device through this address.
 */
export async function daemonDriverElsewhere(
  address: string,
  activeDevice: () => Promise<string | undefined>,
  session: SessionIdentity = currentSession(),
  opts: ClaimOptions = {},
): Promise<DeviceClaim | undefined> {
  const claims = daemonClaimsElsewhere(address, session, opts);
  if (claims.length === 0) return undefined;
  const active = await activeDevice().catch(() => undefined);
  return active === undefined ? undefined : claims.find((claim) => claim.device === active);
}

/** Thrown when a session would select a device on another live session's daemon. */
export class DaemonClaimedError extends Error {
  constructor(readonly address: string, readonly holder: DeviceClaim) {
    super(
      `The Tapsmith daemon at ${address} belongs to another session: ${describeHolder(holder)}, `
      + `which is driving ${holder.device} through it. Selecting a device on it would move that session's device. `
      + 'Use a different daemon address, or stop that session.',
    );
    this.name = 'DaemonClaimedError';
  }
}

/** `` `tapsmith test --ui` (pid 4242) in /work/app, since 10:41:03 `` */
export function describeHolder(claim: DeviceClaim): string {
  const since = new Date(claim.claimedAt);
  const when = Number.isNaN(since.getTime()) ? claim.claimedAt : since.toLocaleTimeString();
  const base = `\`${claim.session.command}\` (pid ${claim.session.pid}) in ${claim.session.project}, since ${when}`;
  // The root gone but a process of the session still holding the device (a
  // worker that outlived it): name that process, or the pid above reads dead.
  if (processIsLive(claim.session)) return base;
  const running = (claim.holders ?? []).find(processIsLive);
  return running ? `${base}; that session's process ${running.pid} still holds it` : base;
}

/**
 * A sentence for a "no device available" message naming the devices that are
 * there but held by other sessions — so the user stops one rather than booting
 * another. Empty when none are held.
 */
export function heldDevicesNote(held: readonly DeviceClaim[]): string {
  if (held.length === 0) return '';
  const list = held.map((c) => `${c.device} (${describeHolder(c)})`).join('; ');
  return ` In use by ${held.length === 1 ? 'another Tapsmith session' : 'other Tapsmith sessions'}: ${list}.`;
}

/** `Skipping emulator-5554: in use by another Tapsmith session, …` — for auto-pick paths. */
export function skippedHeldDeviceMessage(claim: DeviceClaim): string {
  return `Skipping ${claim.device}: in use by another Tapsmith session, ${describeHolder(claim)}.`;
}

/**
 * Claim the first of `candidates` (in order) `session` can have, at the moment
 * it is picked — so two sessions starting together cannot both pick the same
 * free device and find out only when the loser's setup reaches its claim.
 * Returns the device claimed, or undefined when every candidate is held.
 */
export function claimFirstFree(
  candidates: readonly string[],
  session: SessionIdentity = currentSession(),
  opts: ClaimOptions = {},
): string | undefined {
  for (const device of candidates) {
    if (claimDevice(device, session, opts).ok) return device;
  }
  return undefined;
}

/**
 * Claim, in order, up to `count` of `candidates` — those `session` can have —
 * at the moment they are picked, so two sessions provisioning at the same
 * time divide the free devices between them instead of both taking the first
 * ones. Devices another session holds are skipped; ones beyond `count` are
 * left unclaimed (and dropped from the result) so a run never holds devices it
 * will not use.
 */
export function claimUpTo(
  candidates: readonly string[],
  count: number,
  session: SessionIdentity = currentSession(),
  opts: ClaimOptions = {},
): { claimed: string[]; held: DeviceClaim[] } {
  const claimed: string[] = [];
  const held: DeviceClaim[] = [];
  for (const device of candidates) {
    if (claimed.length >= count) break;
    const res = claimDevice(device, session, opts);
    if (res.ok) claimed.push(device);
    else held.push(res.holder);
  }
  return { claimed, held };
}

