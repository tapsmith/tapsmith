/**
 * Device readiness — the per-worker state machine behind speculative app
 * preparation in UI mode.
 *
 * After a run ends (and after startup) the worker resets the app in the
 * background so the *next* Run click pays only a cheap validation. This module
 * decides when to arm, what to arm for, when a prepared device has gone stale,
 * and how the chip in the top rail should describe it. It is pure: no timers,
 * no IPC, no process handles — it takes events and returns commands for
 * `ui-server.ts` to execute, so every transition is unit-testable.
 */

import { satisfies, type AppResetPolicy, type PreparedState } from '../app-reset.js';

export type StaleReason =
  | 'mcp-tool'
  | 'mirror-gesture'
  | 'target-changed'
  | 'validation-failed'
  | 'run-stopped'
  | 'run-failed'
  | 'manual';

export type UnpreparedReason =
  | 'speculation-off'
  | 'no-candidate'
  | 'grace'
  | 'cancelled'
  | 'startup';

export type ReadinessState =
  | { kind: 'initializing' }
  | { kind: 'running'; file?: string }
  | { kind: 'unprepared'; reason: UnpreparedReason }
  | { kind: 'preparing'; prepareId: string; target: AppResetPolicy; forFile?: string; startedAt: number; detail?: string }
  | { kind: 'ready'; policy: AppResetPolicy; forFile?: string; preparedAt: number; durationMs: number; prepareId: string; /** Who did the work (default: background preparation). */ source?: string }
  | { kind: 'stale'; reason: StaleReason; since: number; previous?: AppResetPolicy }
  | { kind: 'error'; message: string; since: number; attempts: number }
  | { kind: 'retired' };

export interface Candidate {
  file: string;
  projectName?: string;
  policy: AppResetPolicy;
}

export type ReadinessEvent =
  | { type: 'worker-ready'; initialPolicy?: AppResetPolicy }
  | { type: 'dispatch'; file: string; want: AppResetPolicy }
  | { type: 'file-done' }
  | { type: 'run-ended'; stopped: boolean; failed?: boolean }
  | { type: 'grace-elapsed'; timerId: string }
  | { type: 'prepared'; prepareId: string; policy: AppResetPolicy; startedAt: number; durationMs: number; satisfiedBy?: PreparedState }
  | { type: 'prepare-failed'; prepareId: string; message: string; cancelled: boolean }
  | { type: 'progress'; detail?: string }
  | { type: 'invalidate'; reason: StaleReason }
  | { type: 'candidate-changed' }
  | { type: 'preferences-changed' }
  | { type: 'prepare-now' }
  | { type: 'worker-retired' }
  | { type: 'worker-respawning' }
  | { type: 'worker-recycled' };

export type ReadinessCommand =
  | { type: 'send-prepare'; prepareId: string; target: AppResetPolicy; forFile?: string; projectName?: string }
  | { type: 'send-cancel-prepare'; prepareId: string }
  | { type: 'start-timer'; timerId: string; ms: number }
  | { type: 'clear-timer'; timerId: string }
  | { type: 'broadcast' };

export interface ReadinessEnv {
  now(): number;
  /** Preference ∧ platform allows it. */
  speculationEnabled(): boolean;
  /** The file most likely to run next on this worker, with its resolved policy. */
  nextCandidate(): Candidate | undefined;
  /** Quiet time after a run before the device is yanked into a reset. */
  graceMs(): number;
  /** Someone is poking the mirror right now — hold off. */
  recentlyInteracted(): boolean;
}

export const DEFAULT_GRACE_MS = 5_000;
export const INTERACTION_HOLD_MS = 2_000;
export const TARGET_CHANGED_GRACE_MS = 1_000;
export const MAX_PREPARE_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000];

export class DeviceReadiness {
  private _state: ReadinessState = { kind: 'initializing' };
  private _seq = 0;
  private _errorAttempts = 0;
  private readonly _timerId: string;

  constructor(readonly workerId: number, private readonly env: ReadinessEnv) {
    this._timerId = `readiness-${workerId}`;
  }

  get state(): ReadinessState {
    return this._state;
  }

  /**
   * The prepared state to stamp on a `run-file`, when the device already
   * satisfies what the file wants. Undefined means the runner resets inline.
   */
  preparedFor(want: AppResetPolicy): PreparedState | undefined {
    const s = this._state;
    if (s.kind !== 'ready' || !satisfies(s.policy, want)) return undefined;
    return { policy: s.policy, preparedAt: s.preparedAt, durationMs: s.durationMs, source: s.source ?? 'background preparation' };
  }

  handle(event: ReadinessEvent): ReadinessCommand[] {
    const s = this._state;
    switch (event.type) {
      case 'worker-ready': {
        this._errorAttempts = 0;
        if (event.initialPolicy) {
          this._state = {
            kind: 'ready', policy: event.initialPolicy, preparedAt: this.env.now(), durationMs: 0, prepareId: this.nextId(), source: 'startup launch',
          };
          // The startup launch may not be what the likely-next file wants.
          return [{ type: 'broadcast' }, ...this.reconcileCandidate()];
        }
        this._state = { kind: 'unprepared', reason: 'startup' };
        return [{ type: 'broadcast' }, ...this.arm()];
      }

      case 'dispatch': {
        const cmds: ReadinessCommand[] = [{ type: 'clear-timer', timerId: this._timerId }];
        if (s.kind === 'preparing') cmds.push({ type: 'send-cancel-prepare', prepareId: s.prepareId });
        this._state = { kind: 'running', file: event.file };
        cmds.push({ type: 'broadcast' });
        return cmds;
      }

      case 'file-done':
        // Files inside one run reset inline; arming waits for the run to end.
        return [];

      case 'run-ended': {
        if (s.kind === 'retired') return [];
        // The run is broadcast to every worker, but only a worker that ran a
        // file touched its device (dispatch moved it to `running`). A worker
        // still `ready` or mid-`preparing` sat the run out — its preparation
        // is as valid as it was, so keep it rather than discard it and redo
        // the same reset after the grace period.
        if (s.kind === 'ready' || s.kind === 'preparing') return [];
        if (event.stopped || event.failed) {
          // The user stopped the run, or a test on this device failed — either
          // way the state on the device is worth inspecting. Don't yank it
          // into a background reset; preparation re-arms on the next normal
          // trigger (selection change, prepare-now, a later run).
          this._state = { kind: 'stale', reason: event.stopped ? 'run-stopped' : 'run-failed', since: this.env.now() };
          return [{ type: 'clear-timer', timerId: this._timerId }, { type: 'broadcast' }];
        }
        this._state = { kind: 'unprepared', reason: 'grace' };
        return [{ type: 'broadcast' }, { type: 'start-timer', timerId: this._timerId, ms: this.env.graceMs() }];
      }

      case 'grace-elapsed': {
        if (event.timerId !== this._timerId) return [];
        if (s.kind === 'running' || s.kind === 'preparing' || s.kind === 'ready' || s.kind === 'retired' || s.kind === 'initializing') return [];
        return this.arm();
      }

      case 'prepared': {
        if (s.kind !== 'preparing' || s.prepareId !== event.prepareId) return [];
        this._errorAttempts = 0;
        this._state = {
          kind: 'ready',
          policy: event.policy,
          forFile: s.forFile,
          // A pass that found the device already prepared credits the
          // preparation that actually did the work.
          preparedAt: event.satisfiedBy?.preparedAt ?? event.startedAt + event.durationMs,
          durationMs: event.satisfiedBy?.durationMs ?? event.durationMs,
          source: event.satisfiedBy?.source,
          prepareId: event.prepareId,
        };
        return [{ type: 'broadcast' }];
      }

      case 'prepare-failed': {
        if (s.kind !== 'preparing' || s.prepareId !== event.prepareId) return [];
        if (event.cancelled) {
          this._state = { kind: 'unprepared', reason: 'cancelled' };
          return [{ type: 'broadcast' }];
        }
        this._errorAttempts += 1;
        this._state = { kind: 'error', message: event.message, since: this.env.now(), attempts: this._errorAttempts };
        const cmds: ReadinessCommand[] = [{ type: 'broadcast' }];
        if (this._errorAttempts < MAX_PREPARE_ATTEMPTS) {
          const backoff = RETRY_BACKOFF_MS[Math.min(this._errorAttempts - 1, RETRY_BACKOFF_MS.length - 1)];
          cmds.push({ type: 'start-timer', timerId: this._timerId, ms: backoff });
        }
        return cmds;
      }

      case 'progress': {
        if (s.kind !== 'preparing') return [];
        this._state = { ...s, detail: event.detail };
        return [{ type: 'broadcast' }];
      }

      case 'invalidate': {
        if (s.kind === 'running' || s.kind === 'retired' || s.kind === 'initializing') return [];
        const cmds: ReadinessCommand[] = [];
        if (s.kind === 'preparing') cmds.push({ type: 'send-cancel-prepare', prepareId: s.prepareId });
        const previous = s.kind === 'ready' ? s.policy : undefined;
        this._state = { kind: 'stale', reason: event.reason, since: this.env.now(), previous };
        cmds.push({ type: 'broadcast' }, { type: 'start-timer', timerId: this._timerId, ms: this.env.graceMs() });
        return cmds;
      }

      case 'candidate-changed': {
        if (s.kind === 'ready') return this.reconcileCandidate();
        if (s.kind === 'unprepared' && s.reason !== 'grace') return this.arm();
        // A stop- or failure-induced hold has no pending timer (unlike other
        // stale states); picking a new target is the user moving on — re-arm.
        if (s.kind === 'stale' && (s.reason === 'run-stopped' || s.reason === 'run-failed')) return this.arm();
        return [];
      }

      case 'preferences-changed': {
        if (!this.env.speculationEnabled()) {
          if (s.kind === 'preparing') {
            this._state = { kind: 'unprepared', reason: 'speculation-off' };
            return [{ type: 'send-cancel-prepare', prepareId: s.prepareId }, { type: 'broadcast' }];
          }
          if (s.kind === 'unprepared' || s.kind === 'stale' || s.kind === 'error') {
            this._state = { kind: 'unprepared', reason: 'speculation-off' };
            return [{ type: 'clear-timer', timerId: this._timerId }, { type: 'broadcast' }];
          }
          return []; // a valid `ready` is kept; it just won't be re-armed later
        }
        if (s.kind === 'unprepared' || s.kind === 'stale' || s.kind === 'error') return this.arm();
        return [];
      }

      case 'prepare-now': {
        if (s.kind === 'running' || s.kind === 'preparing' || s.kind === 'retired' || s.kind === 'initializing') return [];
        return this.arm({ force: true });
      }

      case 'worker-retired': {
        const cmds: ReadinessCommand[] = [{ type: 'clear-timer', timerId: this._timerId }];
        if (s.kind === 'preparing') cmds.push({ type: 'send-cancel-prepare', prepareId: s.prepareId });
        this._state = { kind: 'retired' };
        cmds.push({ type: 'broadcast' });
        return cmds;
      }

      case 'worker-respawning':
        this._state = { kind: 'initializing' };
        return [{ type: 'broadcast' }];

      case 'worker-recycled':
        // The Node process restarted; the device did not change.
        return [];
    }
  }

  private nextId(): string {
    this._seq += 1;
    return `${this.workerId}-${this._seq}`;
  }

  /** `ready(P)` stays ready while the likely-next file is satisfied by P. */
  private reconcileCandidate(): ReadinessCommand[] {
    const s = this._state;
    if (s.kind !== 'ready') return [];
    const cand = this.env.nextCandidate();
    if (!cand || satisfies(s.policy, cand.policy)) return [];
    this._state = { kind: 'stale', reason: 'target-changed', since: this.env.now(), previous: s.policy };
    return [{ type: 'broadcast' }, { type: 'start-timer', timerId: this._timerId, ms: TARGET_CHANGED_GRACE_MS }];
  }

  private arm(opts: { force?: boolean } = {}): ReadinessCommand[] {
    if (!opts.force && !this.env.speculationEnabled()) {
      this._state = { kind: 'unprepared', reason: 'speculation-off' };
      return [{ type: 'broadcast' }];
    }
    const cand = this.env.nextCandidate();
    if (!cand) {
      this._state = { kind: 'unprepared', reason: 'no-candidate' };
      return [{ type: 'broadcast' }];
    }
    if (!opts.force && this.env.recentlyInteracted()) {
      this._state = { kind: 'unprepared', reason: 'grace' };
      return [{ type: 'broadcast' }, { type: 'start-timer', timerId: this._timerId, ms: INTERACTION_HOLD_MS }];
    }
    const prepareId = this.nextId();
    this._state = { kind: 'preparing', prepareId, target: cand.policy, forFile: cand.file, startedAt: this.env.now() };
    return [
      { type: 'send-prepare', prepareId, target: cand.policy, forFile: cand.file, projectName: cand.projectName },
      { type: 'broadcast' },
    ];
  }
}

// ─── MCP tool targeting ───

/** What `mcpToolWorkers` needs to know about one live worker. */
export interface McpTargetWorker {
  id: number
  /** The worker's devices, primary first: serial and group name (`alice`). */
  devices: Array<{ serial: string; name?: string }>
}

/**
 * The workers a mutating MCP device tool touched, so only their devices are
 * invalidated — each invalidation costs a real reset on the next
 * preparation. `resolved` is the serial the MCP connection actually acted on
 * (the tool-call event's `device`); without it, an explicit `device`
 * argument (serial or group name) is used. Undefined means "every worker":
 * a call the session cannot place is not narrowed, since missing the touched
 * device would let a stale prepared state through. Re-deriving the MCP's
 * own default or project choice here is not attempted — it drifts from the
 * connection pool's order.
 */
export function mcpToolWorkers(
  resolved: string | undefined,
  args: Record<string, unknown> | undefined,
  workers: McpTargetWorker[],
): number[] | undefined {
  const device = resolved || (typeof args?.device === 'string' && args.device ? args.device : undefined);
  if (!device) return undefined;
  const hit = workers.filter((w) => w.devices.some((d) => d.serial === device || d.name === device));
  return hit.length > 0 ? hit.map((w) => w.id) : undefined;
}

// ─── Wire representation ───

/** What the client sees; a flattened, JSON-friendly view of the state. */
export type WorkerReadiness =
  | { state: 'initializing' }
  | { state: 'running'; file?: string }
  | { state: 'unprepared'; reason: UnpreparedReason }
  | { state: 'preparing'; policy: AppResetPolicy; forFile?: string; startedAt: number; detail?: string }
  | { state: 'ready'; policy: AppResetPolicy; forFile?: string; preparedAt: number; durationMs: number }
  | { state: 'stale'; reason: StaleReason; since: number }
  | { state: 'error'; message: string; attempts: number }
  | { state: 'retired' };

export function toWireReadiness(s: ReadinessState): WorkerReadiness {
  switch (s.kind) {
    case 'initializing': return { state: 'initializing' };
    case 'running': return { state: 'running', file: s.file };
    case 'unprepared': return { state: 'unprepared', reason: s.reason };
    case 'preparing': return { state: 'preparing', policy: s.target, forFile: s.forFile, startedAt: s.startedAt, detail: s.detail };
    case 'ready': return { state: 'ready', policy: s.policy, forFile: s.forFile, preparedAt: s.preparedAt, durationMs: s.durationMs };
    case 'stale': return { state: 'stale', reason: s.reason, since: s.since };
    case 'error': return { state: 'error', message: s.message, attempts: s.attempts };
    case 'retired': return { state: 'retired' };
  }
}
