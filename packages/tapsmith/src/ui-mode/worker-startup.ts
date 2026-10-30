/**
 * Holds a run requested while UI mode's test workers are still starting.
 *
 * The UI server serves the page — and accepts run requests from it, MCP and
 * watch — before its workers are up. A run asked for then used to fail at once
 * with "no worker", leaving the page's pending pulse spinning. It now waits
 * here for startup to end, and the page shows it waiting.
 *
 * One run waits at a time, as one run runs at a time: a second request while
 * one waits is turned away as busy, the same answer a request gets while a run
 * is under way.
 */

export type StartupWaitOutcome = 'ready' | 'busy' | 'stopped'

export interface StartupWait {
  outcome: StartupWaitOutcome
  /** The run was held (and the page told so) before this outcome. */
  waited: boolean
}

export class WorkerStartupGate {
  private _starting: boolean;
  private _waiter: ((outcome: StartupWaitOutcome) => void) | null = null;

  constructor(
    starting: boolean,
    /** Called when a run starts or stops waiting. */
    private readonly _onWaitingChange: (waiting: boolean) => void,
  ) {
    this._starting = starting;
  }

  /** Workers are still starting. */
  get starting(): boolean {
    return this._starting;
  }

  /** A run is waiting for startup to end. */
  get waiting(): boolean {
    return this._waiter !== null;
  }

  /**
   * Resolves when a run may go ahead: at once when startup is over, else when
   * it ends (`ready`), or when the waiting run is stopped (`stopped`).
   */
  wait(): Promise<StartupWait> {
    if (!this._starting) return Promise.resolve({ outcome: 'ready', waited: false });
    if (this._waiter) return Promise.resolve({ outcome: 'busy', waited: false });
    return new Promise<StartupWait>((resolve) => {
      this._waiter = (outcome) => resolve({ outcome, waited: true });
      this._onWaitingChange(true);
    });
  }

  /** Startup is over, whether or not any worker came up: release the waiting run. */
  finish(): void {
    this._starting = false;
    this._release('ready');
  }

  /**
   * Stop the waiting run, if any. Startup itself carries on.
   *
   * @returns whether a run was waiting.
   */
  cancel(): boolean {
    return this._release('stopped');
  }

  private _release(outcome: StartupWaitOutcome): boolean {
    const waiter = this._waiter;
    if (!waiter) return false;
    this._waiter = null;
    this._onWaitingChange(false);
    waiter(outcome);
    return true;
  }
}
