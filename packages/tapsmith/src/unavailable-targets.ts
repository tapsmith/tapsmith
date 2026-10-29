/**
 * Device targets a UI or watch session could not start.
 *
 * A multi-target session (an `android` and an `ios` project, say) goes on
 * without a target whose devices cannot be provisioned, as `tapsmith test`
 * does: the target's test files fail with its labelled reason,
 * and a run that includes them tries the target again — the way Playwright
 * launches a project's browser again on every run.
 */

import type { DeviceGroupEntry } from './config.js';
import type { LaunchedEmulator } from './emulator.js';
import type { SerializedConfig } from './worker-protocol.js';
import { deviceTargetLabel, isProgrammingError, targetUnavailableMessage } from './dispatcher.js';

/** A device target's provisioned devices, ready for the session to start its workers on. */
export interface ProvisionedTarget {
  /** One device group per worker, primary first. */
  workerGroups: string[][]
  /** Each device's serialized config (the target's effective config). */
  configByDevice: Map<string, SerializedConfig>
  /** Each device's worker group names, primary first. */
  deviceGroupByDevice: Map<string, DeviceGroupEntry[]>
  /** Emulators this provisioning launched. */
  launched: LaunchedEmulator[]
}

/** Provision one device target again, by signature. Rejects with the reason it cannot start. */
export type ProvisionTarget = (signature: string) => Promise<ProvisionedTarget>;

export class UnavailableTargets {
  private readonly _failed = new Map<string, unknown>();
  private readonly _inFlight = new Map<string, Promise<boolean>>();

  /**
   * @param _provision How to provision a target again; absent in a session
   *   with one target, which has nothing to go on with if it fails.
   * @param failed The targets that could not start, with the error, in order.
   */
  constructor(
    private readonly _provision: ProvisionTarget | undefined,
    failed: Iterable<[string, unknown]> = [],
  ) {
    for (const [signature, err] of failed) this._failed.set(signature, err);
  }

  get size(): number {
    return this._failed.size;
  }

  has(signature: string | undefined): boolean {
    return signature !== undefined && this._failed.has(signature);
  }

  /** A target that stopped being usable after startup (its workers all failed to start). */
  add(signature: string, err: unknown): void {
    this._failed.set(signature, err);
  }

  entries(): Array<{ signature: string; label: string; error: unknown }> {
    return [...this._failed].map(([signature, error]) => ({ signature, label: deviceTargetLabel(signature), error }));
  }

  /** What a test file of the target reports: `Device target "<label>" could not start: <reason>`. */
  reason(signature: string): string | undefined {
    return this._failed.has(signature)
      ? targetUnavailableMessage(deviceTargetLabel(signature), this._failed.get(signature))
      : undefined;
  }

  /** The reason with `hint` appended to its first line; the later lines (the hints) follow. */
  notice(signature: string, hint: string): string | undefined {
    const reason = this.reason(signature);
    if (reason === undefined) return undefined;
    const [first, ...rest] = reason.split('\n');
    return [`${first.replace(/\.$/, '')}. ${hint}`, ...rest].join('\n');
  }

  /** The unavailable targets the given projects run on, each once, in first-seen order. */
  signaturesFor(
    projectNames: Iterable<string | undefined>,
    bucketByProject: ReadonlyMap<string, string> | undefined,
  ): string[] {
    if (!bucketByProject) return [];
    const found = new Set<string>();
    for (const name of projectNames) {
      const signature = name === undefined ? undefined : bucketByProject.get(name);
      if (signature !== undefined && this._failed.has(signature)) found.add(signature);
    }
    return [...found];
  }

  /**
   * Try the target again. On success `apply` starts the session's workers
   * on the new devices — exactly once, however many callers are waiting on
   * the same attempt — and the target is available from then on. A failure,
   * in provisioning or in `apply`, keeps the target unavailable with the new
   * reason. A Tapsmith bug is rethrown rather than recorded as a reason.
   *
   * @returns whether the target is available now.
   */
  retry(signature: string, apply: (target: ProvisionedTarget) => Promise<void>): Promise<boolean> {
    if (!this._failed.has(signature)) return Promise.resolve(true);
    const provision = this._provision;
    if (!provision) return Promise.resolve(false);
    const inFlight = this._inFlight.get(signature);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      try {
        await apply(await provision(signature));
        this._failed.delete(signature);
        return true;
      } catch (err) {
        if (isProgrammingError(err)) throw err;
        this._failed.set(signature, err);
        return false;
      }
    })().finally(() => this._inFlight.delete(signature));
    this._inFlight.set(signature, attempt);
    return attempt;
  }
}

/**
 * The first project of each device target that has test files, in config
 * order: the targets a session can set its primary device up on, the
 * session's first target first.
 */
export function firstProjectPerTarget<P extends { deviceSignature: string; testFiles: readonly string[] }>(projects: readonly P[]): P[] {
  const seen = new Set<string>();
  return projects.filter((p) => {
    if (p.testFiles.length === 0 || seen.has(p.deviceSignature)) return false;
    seen.add(p.deviceSignature);
    return true;
  });
}
