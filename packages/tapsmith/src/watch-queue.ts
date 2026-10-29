/**
 * Run queue and keypress mapping for watch mode.
 *
 * Extracted from watch.ts for independent unit testing.
 */

// ─── Keypress mapping ───

export type WatchAction = 'run-all' | 'run-failed' | 'rerun' | 'quit'

/**
 * The keys watch mode lists after each run, in order. docs/watch-mode.md's
 * keyboard table carries the same text (a unit test holds them together:
 * they had drifted apart).
 */
export const WATCH_KEYS: ReadonlyArray<{ key: string; action: string }> = [
  { key: 'a', action: 'run all test files' },
  { key: 'f', action: 're-run the files that had failures' },
  { key: 'Enter', action: 're-run the last run\'s files' },
  { key: 'q', action: 'quit (Ctrl+C also quits)' },
];

/**
 * The key list as printed: Enter only once there is a run to repeat, naming
 * its files.
 */
export function watchUsage(lastRunFiles: readonly string[]): Array<{ key: string; action: string }> {
  return WATCH_KEYS.flatMap(({ key, action }) => {
    if (key !== 'Enter') return [{ key, action }];
    if (lastRunFiles.length === 0) return [];
    const names = lastRunFiles.map((f) => f.split(/[\\/]/).pop()).join(', ');
    return [{ key, action: `${action}: ${names}` }];
  });
}

export function mapKeyToAction(key: string): WatchAction | null {
  switch (key) {
    case 'a': return 'run-all';
    case 'f': return 'run-failed';
    case '\r': // Enter
    case '\n': return 'rerun';
    case 'q':
    case '\x03': return 'quit'; // Ctrl+C
    default: return null;
  }
}

// ─── Run queue ───

export type RunRequest = { type: 'files'; files: string[] } | { type: 'all' }

/**
 * Manages debounce and queuing for watch mode re-runs.
 *
 * - Debounces rapid file changes, accumulating files across calls
 * - Queues runs while another is in progress
 * - 'run-all' supersedes individual pending files
 */
export class RunQueue {
  private _debounceFiles = new Set<string>();
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingFiles: Set<string> | 'all' | null = null;
  private _isRunning = false;
  private readonly _debounceMs: number;
  private readonly _onRun: (request: RunRequest) => void;

  constructor(debounceMs: number, onRun: (request: RunRequest) => void) {
    this._debounceMs = debounceMs;
    this._onRun = onRun;
  }

  get isRunning(): boolean { return this._isRunning; }

  /** Schedule specific files with debounce accumulation. */
  scheduleFiles(files: string[]): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    if (this._isRunning) {
      if (this._pendingFiles === 'all') return;
      if (this._pendingFiles) {
        for (const f of files) this._pendingFiles.add(f);
      } else {
        this._pendingFiles = new Set(files);
      }
      return;
    }

    for (const f of files) this._debounceFiles.add(f);

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      const batch = [...this._debounceFiles];
      this._debounceFiles.clear();
      this._onRun({ type: 'files', files: batch });
    }, this._debounceMs);
  }

  /** Schedule a full run (immediate, no debounce). */
  scheduleAll(): void {
    if (this._isRunning) {
      this._pendingFiles = 'all';
      return;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._onRun({ type: 'all' });
  }

  /** Schedule specific files immediately (no debounce). */
  scheduleImmediate(files: string[]): void {
    if (this._isRunning) {
      this._pendingFiles = new Set(files);
      return;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._onRun({ type: 'files', files });
  }

  /** Mark that a run has started. */
  notifyRunStarted(): void {
    this._isRunning = true;
  }

  /** Mark that a run has finished and drain any queued work. */
  notifyRunFinished(): void {
    this._isRunning = false;
    if (this._pendingFiles) {
      const pending = this._pendingFiles;
      this._pendingFiles = null;
      if (pending === 'all') {
        this._onRun({ type: 'all' });
      } else {
        this._onRun({ type: 'files', files: [...pending] });
      }
    }
  }
}
