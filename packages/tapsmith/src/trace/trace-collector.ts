/**
 * TraceCollector — accumulates trace events during a test execution.
 *
 * Constructed by the runner at test start, attached to the device, and
 * finalized at test end. Holds an in-memory buffer of events and
 * references to captured screenshots/hierarchy snapshots.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCurrentAttemptClosed } from '../attempt-fence.js';
import type {
  ActionTraceEvent,
  AssertionTraceEvent,
  GroupTraceEvent,
  ConsoleTraceEvent,
  AnyTraceEvent,
  ConsoleLevel,
  SourceLocation,
  TraceConfig,
} from './types.js';

/** Module-level count of active console interceptors to prevent racing. */
let _activeConsoleInterceptors = 0;

// ─── Global collector accessor ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _G = globalThis as any;
const COLLECTOR_KEY = Symbol.for('tapsmith.activeTraceCollector');
if (!(COLLECTOR_KEY in _G)) _G[COLLECTOR_KEY] = null;

export const TRACE_CAPTURE_TIMEOUT_MS = 5_000;

/** Get the currently active trace collector (set by the runner during test execution). */
export function getActiveTraceCollector(): TraceCollector | null {
  return _G[COLLECTOR_KEY];
}

/** @internal — Set the active collector. Called by the runner. */
export function setActiveTraceCollector(collector: TraceCollector | null): void {
  _G[COLLECTOR_KEY] = collector;
}

/**
 * @internal — Run a callback with the given collector as active, guaranteed to
 * be cleared on completion (even if the callback throws).
 */
export async function withActiveTraceCollector<T>(
  collector: TraceCollector,
  fn: () => Promise<T>,
): Promise<T> {
  setActiveTraceCollector(collector);
  try {
    return await fn();
  } finally {
    setActiveTraceCollector(null);
  }
}

async function captureWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs = TRACE_CAPTURE_TIMEOUT_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Trace capture context ───

/**
 * Lightweight handle passed through ElementHandle so assertions and element
 * queries can emit trace events without a direct Device dependency.
 */
export interface TraceCapture {
  collector: TraceCollector
  /** Group name of the device these events come from (multi-device tests). */
  deviceId?: string
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
  captureTraceState?: (options: {
    screenshot?: boolean;
    hierarchy?: boolean;
    elementSelector?: import('../selectors.js').Selector;
  }) => Promise<import('../grpc-client.js').CaptureTraceStateResponse | undefined>
}

// ─── Types ───

export interface ScreenshotCapture {
  /** Relative path within the archive screenshots/ dir. */
  archivePath: string
  /** Absolute path to the temporary file on disk. */
  diskPath: string
  /**
   * The disk file is owned by another collector (e.g. a replayed beforeAll
   * capture). It is still needed after this collector packages, so the
   * packager must not delete it — the owning collector's cleanup() will.
   */
  external?: boolean
}

export interface HierarchyCapture {
  /** Relative path within the archive hierarchy/ dir. */
  archivePath: string
  /** The XML content. */
  xml: string
}

export interface CaptureBeforeAfter {
  screenshotBefore?: ScreenshotCapture
  screenshotAfter?: ScreenshotCapture
  hierarchyBefore?: HierarchyCapture
  hierarchyAfter?: HierarchyCapture
}

// ─── Archive path naming ───

/** Basename of an action screenshot file (both on disk and in the archive). */
export function screenshotFileName(actionIndex: number, position: 'before' | 'after'): string {
  return `action-${String(actionIndex).padStart(3, '0')}-${position}.png`;
}

/** Path of an action screenshot within the trace archive. */
export function screenshotArchivePath(actionIndex: number, position: 'before' | 'after'): string {
  return `screenshots/${screenshotFileName(actionIndex, position)}`;
}

/** Path of an action hierarchy snapshot within the trace archive. */
export function hierarchyArchivePath(actionIndex: number, position: 'before' | 'after'): string {
  return `hierarchy/action-${String(actionIndex).padStart(3, '0')}-${position}.xml`;
}

// ─── Source location extraction ───

const STACK_FRAME_RE = /at\s+(?:.+\s+)?\(?(.+):(\d+):(\d+)\)?$/;

/**
 * A stack frame's file as a plain forward-slash path: ESM frames reference
 * modules by file:// URL — the runner loads tests via
 * import(pathToFileURL(absPath).href), so user-code frames look like
 * `file:///Users/.../test.ts` — and Windows frames use backslashes.
 * Undefined for a URL that is not a valid file URL.
 */
function frameFilePath(rawFile: string): string | undefined {
  let file = rawFile;
  if (file.startsWith('file://')) {
    try {
      // Strip any ?query / #fragment first — ESM loaders (tsx, vite, jiti)
      // append cache-busting queries like `?t=123` to import URLs, and
      // fileURLToPath would otherwise fold them into the path so the file
      // can't be found on disk. Clear search/hash on the URL object and let
      // fileURLToPath do the conversion rather than rebuilding the string.
      const url = new URL(file);
      url.search = '';
      url.hash = '';
      file = fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  return file.replace(/\\/g, '/');
}

/**
 * The SDK's own files, in every layout: `packages/tapsmith/(src|dist)` in the
 * monorepo, `node_modules/tapsmith/` for npm, yarn and pnpm installs (its
 * `dist/*.js`, or `src/*.ts` once source maps apply). The `(^|/)` anchor
 * matches both absolute and relative paths; the `i` flag keeps it robust on
 * case-insensitive filesystems (macOS/Windows) where the path's casing can
 * vary with how the project was cloned/navigated. Matching these exact
 * directories (not bare "tapsmith") avoids misclassifying a user project that
 * happens to be named "tapsmith".
 */
const TAPSMITH_FILE_RE = /(^|\/)(packages\/tapsmith\/(src|dist)|node_modules\/tapsmith)\//i;

function isNodeInternal(file: string): boolean {
  return file.startsWith('node:') || file.startsWith('internal/');
}

/**
 * Extract all user-code frames from a stack trace, top frame first.
 * Skips frames inside the tapsmith SDK, node_modules, and node internals.
 */
export function extractStack(stack: string): SourceLocation[] {
  const frames: SourceLocation[] = [];
  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_RE.exec(line.trim());
    if (!match) continue;
    const file = frameFilePath(match[1]);
    if (file === undefined) continue;
    // A source location is the user's own code, so every dependency is
    // skipped here, not only the SDK.
    if (TAPSMITH_FILE_RE.test(file) || /(^|\/)node_modules\//i.test(file)) continue;
    if (isNodeInternal(file)) continue;
    frames.push({ file, line: parseInt(match[2], 10), column: parseInt(match[3], 10) });
  }
  return frames;
}

/**
 * The stack lines worth showing a user under a failure (PILOT-841): every
 * frame except Tapsmith's own and Node's internals, and those with no file
 * at all (`at new Promise (<anonymous>)`). Third-party dependency frames stay,
 * as in Playwright's filtered stacks — only the framework hides itself. Lines
 * that are not frames (`Caused by: …`) stay too. When no frame would be left —
 * an error raised inside Tapsmith with no test code on the stack, like a
 * runner timeout — the lines come back unchanged, so a failure never prints
 * an empty stack.
 *
 * Filter before capping how many frames to print: an npm install's
 * assertion error carries three or more SDK frames above the test's.
 */
export function userStackFrames(lines: readonly string[]): string[] {
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) return true;
    const match = STACK_FRAME_RE.exec(trimmed);
    if (!match) return false;
    const file = frameFilePath(match[1]);
    return file !== undefined && !TAPSMITH_FILE_RE.test(file) && !isNodeInternal(file);
  });
  return kept.some((line) => line.trim().startsWith('at ')) ? kept : [...lines];
}

/**
 * Whether one raw stack line is a frame of Tapsmith itself or of Node's
 * internals — the frames {@link userStackFrames} hides.
 */
export function isFrameworkFrame(line: string): boolean {
  const match = STACK_FRAME_RE.exec(line.trim());
  if (!match) return false;
  const file = frameFilePath(match[1]);
  return file !== undefined && (TAPSMITH_FILE_RE.test(file) || isNodeInternal(file));
}

/**
 * Extract the caller's source location (the top user-code frame) from a stack
 * trace. Convenience wrapper over {@link extractStack}.
 */
export function extractSourceLocation(stack: string): SourceLocation | undefined {
  return extractStack(stack)[0];
}

/**
 * Collect the unique set of absolute file paths referenced by the stacks of all
 * action/assertion events. Used to snapshot exactly the source files the trace
 * can display.
 */
export function collectReferencedFiles(events: readonly AnyTraceEvent[]): string[] {
  const files = new Set<string>();
  for (const ev of events) {
    if ((ev.type === 'action' || ev.type === 'assertion') && ev.stack) {
      for (const frame of ev.stack) {
        if (frame?.file) files.add(frame.file);
      }
    }
  }
  return [...files];
}

// ─── TraceCollector ───

/** Callback for live trace event streaming (UI mode). */
export type TraceEventCallback = (
  event: AnyTraceEvent,
  screenshots?: {
    before?: Buffer
    after?: Buffer
    hierarchyBefore?: string
    hierarchyAfter?: string
  },
  /**
   * Lifecycle stage of the event. Omitted for events that don't have a
   * lifecycle (groups, console, error). For action/assertion events:
   *   - 'started' fires immediately after the before-capture so UI mode can
   *     render an in-progress row with a spinner; the event has placeholder
   *     duration/success/passed and is NOT pushed to the persistent _events.
   *   - 'completed' (or omitted) is the existing behavior.
   */
  lifecycle?: 'started' | 'completed',
) => void

export class TraceCollector {
  readonly config: TraceConfig;
  private _events: AnyTraceEvent[] = [];
  /**
   * Index the next *emitted* action/assertion takes when nothing reserved one
   * for it — also the count of recorded actions. Advances on emit only.
   */
  private _actionIndex = 0;
  /**
   * Index the next before-capture reserves. Two devices acting at once each
   * capture before emitting; without a reservation both would write their
   * screenshot under the same index and the second would overwrite the first.
   * Reservations run ahead of `_actionIndex`; an emit that carries its
   * reserved index moves `_actionIndex` past it.
   */
  private _nextReservable = 0;
  private _timelineOrigin: number;
  private _lastTimelineTimestamp: number;
  private _lastTimedEvent: ActionTraceEvent | AssertionTraceEvent | null = null;
  private _screenshots: ScreenshotCapture[] = [];
  private _hierarchies: HierarchyCapture[] = [];
  private _groupStack: string[] = [];
  /**
   * Pending group-start events that haven't been emitted yet — held back
   * until a child event arrives so we can drop empty groups silently.
   * Each entry is the group event waiting to be flushed.
   */
  private _pendingGroupStarts: GroupTraceEvent[] = [];
  private _tempDir: string;
  private _onEvent?: TraceEventCallback;
  /** Buffered screenshot/hierarchy data for the current action, forwarded via _onEvent. */
  private _pendingCaptures = new Map<number, {
    before?: Buffer
    after?: Buffer
    hierarchyBefore?: string
    hierarchyAfter?: string
  }>();
  private _originalConsole: {
    log: typeof console.log
    warn: typeof console.warn
    error: typeof console.error
    info: typeof console.info
    debug: typeof console.debug
  };
  private _consoleIntercepted = false;
  /** Handler to emit a failed event for the in-flight action/assertion on timeout. */
  private _pendingOperationHandler: ((error: string) => void) | null = null;
  /** User-code frames of the in-flight operation, for timeout-error attribution. */
  private _pendingOperationStack: SourceLocation[] | null = null;
  /** Pending after-action capture promises that must complete before trace packaging. */
  private _pendingAfterCaptures: Promise<void>[] = [];

  constructor(config: TraceConfig, tempDir: string, timelineOrigin = Date.now()) {
    this.config = config;
    this._tempDir = tempDir;
    this._timelineOrigin = timelineOrigin;
    this._lastTimelineTimestamp = timelineOrigin;
    this._originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };

    // Ensure temp directories exist
    fs.mkdirSync(path.join(tempDir, 'screenshots'), { recursive: true });
  }

  // ── Properties ──

  get events(): readonly AnyTraceEvent[] {
    return this._events;
  }

  get screenshots(): readonly ScreenshotCapture[] {
    return this._screenshots;
  }

  get hierarchies(): readonly HierarchyCapture[] {
    return this._hierarchies;
  }

  get currentActionIndex(): number {
    return this._actionIndex;
  }

  // ── Event callback (UI mode live streaming) ──

  /**
   * Set a callback that is invoked for every trace event as it is emitted.
   * Used by UI mode to stream events in real-time via IPC.
   */
  setEventCallback(cb: TraceEventCallback): void {
    this._onEvent = cb;
  }

  /** Get the current event callback (for transferring between collectors). */
  getEventCallback(): TraceEventCallback | undefined {
    return this._onEvent;
  }

  /** @internal — Set the starting action index (used to offset for beforeAll events). */
  setActionIndexOffset(offset: number): void {
    this._actionIndex = offset;
    this._nextReservable = offset;
  }

  /**
   * @internal — Claim the next action index for an action whose before-capture
   * happens before its event is emitted. The emit must pass the index back.
   */
  _reserveActionIndex(): number {
    const index = Math.max(this._actionIndex, this._nextReservable);
    this._nextReservable = index + 1;
    return index;
  }

  /** @internal — The index the next reservation or emit would take. */
  _peekActionIndex(): number {
    return Math.max(this._actionIndex, this._nextReservable);
  }

  /** Consume an index for an emit: the one reserved for it, or a fresh one. */
  private _indexForEmit(reserved: number | undefined): number {
    const index = reserved ?? this._reserveActionIndex();
    this._actionIndex = Math.max(this._actionIndex, index + 1);
    return index;
  }

  /**
   * A fenced emit (the attempt ended while its action was in flight) records
   * nothing, but the index its capture reserved is still spent: leave it
   * behind `_actionIndex` and `actionCount` falls short of the next
   * reservation, so the terminal screenshots the runner reserves afterwards
   * land past where the viewer looks for them (`actionCount + ordinal`) and
   * the afterAll amendment offset can collide with them.
   */
  private _dropFencedReservation(reserved: number | undefined): void {
    if (reserved !== undefined) this._actionIndex = Math.max(this._actionIndex, reserved + 1);
  }

  /**
   * @internal — Record an already-formed event replayed from another
   * collector (beforeAll hooks) so it lands in this collector's packaged
   * trace, not just the UI-mode live stream. The event keeps its original
   * actionIndex and timestamps; screenshot captures reference the source
   * collector's on-disk files, which must outlive this test's packaging.
   */
  ingestReplayedEvent(
    event: AnyTraceEvent,
    captures?: {
      screenshotBefore?: string
      screenshotAfter?: string
      hierarchyBefore?: string
      hierarchyAfter?: string
    },
  ): void {
    // Shallow copy: the same saved event is replayed into every test's
    // collector, and later steps (finalizeTimeline) mutate events in place —
    // a shared reference would let one test's packaging corrupt another's.
    this._events.push({ ...event });
    if (event.type !== 'action' && event.type !== 'assertion') return;
    if (captures?.screenshotBefore) {
      this._screenshots.push({
        archivePath: screenshotArchivePath(event.actionIndex, 'before'),
        diskPath: captures.screenshotBefore,
        external: true,
      });
    }
    if (captures?.screenshotAfter) {
      this._screenshots.push({
        archivePath: screenshotArchivePath(event.actionIndex, 'after'),
        diskPath: captures.screenshotAfter,
        external: true,
      });
    }
    if (captures?.hierarchyBefore) {
      this._hierarchies.push({
        archivePath: hierarchyArchivePath(event.actionIndex, 'before'),
        xml: captures.hierarchyBefore,
      });
    }
    if (captures?.hierarchyAfter) {
      this._hierarchies.push({
        archivePath: hierarchyArchivePath(event.actionIndex, 'after'),
        xml: captures.hierarchyAfter,
      });
    }
  }

  /**
   * @internal — Set the timestamp that action wall durations should account
   * from. This should be called before the first action/assertion is emitted.
   */
  setTimelineOrigin(timestamp: number): void {
    this._timelineOrigin = timestamp;
    this._lastTimelineTimestamp = timestamp;
  }

  /** @internal — Get the temp directory path (for reading saved screenshots). */
  get tempDir(): string {
    return this._tempDir;
  }

  // ── Console interception ──

  startConsoleCapture(): void {
    if (this._consoleIntercepted) return;
    this._consoleIntercepted = true;
    _activeConsoleInterceptors++;

    // Only patch if we're the first interceptor
    if (_activeConsoleInterceptors > 1) return;

    const capture = (level: ConsoleLevel) => {
      return (...args: unknown[]) => {
        this._originalConsole[level](...args);
        const message = args.map((a) =>
          typeof a === 'string' ? a : JSON.stringify(a),
        ).join(' ');
        this._addConsoleEvent(level, message, 'test');
      };
    };

    console.log = capture('log');
    console.warn = capture('warn');
    console.error = capture('error');
    console.info = capture('info');
    console.debug = capture('debug');
  }

  stopConsoleCapture(): void {
    if (!this._consoleIntercepted) return;
    this._consoleIntercepted = false;
    _activeConsoleInterceptors--;

    // Only restore if we're the last interceptor
    if (_activeConsoleInterceptors > 0) return;

    console.log = this._originalConsole.log;
    console.warn = this._originalConsole.warn;
    console.error = this._originalConsole.error;
    console.info = this._originalConsole.info;
    console.debug = this._originalConsole.debug;
  }

  // ── Pending operation (timeout detection) ──

  /**
   * Register a fail handler for the currently in-flight action or assertion.
   * Called by tracedAction / wrapAssertionWithTrace before executing the user's fn().
   *
   * `stack` is the operation's user-code frames (from extractStack): the runner
   * reads it via [pendingOperationStack] to attribute a test-timeout error to
   * the test line whose operation was in flight, instead of the runner's own
   * timer callback.
   */
  setPendingOperation(failHandler: (error: string) => void, stack?: SourceLocation[]): void {
    // A zombie body (timed-out attempt still executing) shares the global
    // active collector with the current attempt — its writes are dropped so
    // it can't clobber the live attempt's pending operation or events.
    if (isCurrentAttemptClosed()) return;
    this._pendingOperationHandler = failHandler;
    this._pendingOperationStack = stack ?? null;
  }

  /**
   * Clear the pending operation after it completes normally.
   */
  clearPendingOperation(): void {
    if (isCurrentAttemptClosed()) return;
    this._pendingOperationHandler = null;
    this._pendingOperationStack = null;
  }

  /**
   * User-code frames of the currently in-flight action/assertion, or null when
   * nothing is pending. Read by the runner at timeout time — before
   * [failPendingOperation] clears the registration.
   */
  get pendingOperationStack(): SourceLocation[] | null {
    return this._pendingOperationStack;
  }

  /**
   * Emit a failed event for the currently in-flight action/assertion.
   * Called by the runner when a test times out, so the stuck action appears in the trace.
   */
  failPendingOperation(error: string): void {
    if (!this._pendingOperationHandler) return;
    const handler = this._pendingOperationHandler;
    this._pendingOperationHandler = null;
    this._pendingOperationStack = null;
    handler(error);
  }

  // ── Action recording ──

  /**
   * Record a before-action capture (screenshot + hierarchy).
   * Returns the action index for this action.
   */
  async captureBeforeAction(
    takeScreenshot: () => Promise<Buffer | undefined>,
    captureHierarchy: () => Promise<string | undefined>,
    timeoutMs = TRACE_CAPTURE_TIMEOUT_MS,
    /** An index already reserved for this action (see `_reserveActionIndex`). */
    reservedActionIndex?: number,
  ): Promise<{ actionIndex: number; captures: Partial<CaptureBeforeAfter> }> {
    const actionIndex = reservedActionIndex ?? this._reserveActionIndex();
    const captures: Partial<CaptureBeforeAfter> = {};

    // Fenced zombie attempt — record nothing against the live attempt.
    if (isCurrentAttemptClosed()) return { actionIndex, captures };

    const tasks: Promise<void>[] = [];

    if (this.config.screenshots) {
      tasks.push(
        captureWithTimeout(takeScreenshot(), timeoutMs).then((data) => {
          if (data) {
            const filename = screenshotFileName(actionIndex, 'before');
            const diskPath = path.join(this._tempDir, 'screenshots', filename);
            fs.writeFileSync(diskPath, data);
            const capture: ScreenshotCapture = {
              archivePath: `screenshots/${filename}`,
              diskPath,
            };
            this._screenshots.push(capture);
            captures.screenshotBefore = capture;
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.before = data;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    if (this.config.snapshots) {
      tasks.push(
        captureWithTimeout(captureHierarchy(), timeoutMs).then((xml) => {
          if (xml) {
            captures.hierarchyBefore = {
              archivePath: hierarchyArchivePath(actionIndex, 'before'),
              xml,
            };
            this._hierarchies.push(captures.hierarchyBefore!);
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.hierarchyBefore = xml;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    await Promise.all(tasks);
    return { actionIndex, captures };
  }

  /**
   * Record an after-action capture.
   */
  async captureAfterAction(
    actionIndex: number,
    takeScreenshot: () => Promise<Buffer | undefined>,
    captureHierarchy: () => Promise<string | undefined>,
  ): Promise<Partial<CaptureBeforeAfter>> {
    const captures: Partial<CaptureBeforeAfter> = {};
    const tasks: Promise<void>[] = [];

    if (this.config.screenshots) {
      tasks.push(
        captureWithTimeout(takeScreenshot()).then((data) => {
          if (data) {
            const filename = screenshotFileName(actionIndex, 'after');
            const diskPath = path.join(this._tempDir, 'screenshots', filename);
            fs.writeFileSync(diskPath, data);
            const capture: ScreenshotCapture = {
              archivePath: `screenshots/${filename}`,
              diskPath,
            };
            this._screenshots.push(capture);
            captures.screenshotAfter = capture;
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.after = data;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    if (this.config.snapshots) {
      tasks.push(
        captureWithTimeout(captureHierarchy()).then((xml) => {
          if (xml) {
            captures.hierarchyAfter = {
              archivePath: hierarchyArchivePath(actionIndex, 'after'),
              xml,
            };
            this._hierarchies.push(captures.hierarchyAfter!);
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.hierarchyAfter = xml;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    await Promise.all(tasks);
    return captures;
  }

  /**
   * Track a pending after-action capture promise. These are awaited before
   * the trace is packaged to ensure all screenshots/hierarchies are written.
   */
  trackPendingCapture(promise: Promise<void>): void {
    this._pendingAfterCaptures.push(promise);
  }

  /**
   * Wait for all pending after-action captures to complete.
   * Called before packaging the trace to ensure all data is flushed.
   */
  async flushPendingCaptures(): Promise<void> {
    await Promise.allSettled(this._pendingAfterCaptures);
    this._pendingAfterCaptures = [];
  }

  /**
   * Flush buffered screenshot/hierarchy data for a given action index via
   * the live event callback.  Used to stream the final end-of-test screenshot
   * to UI mode without emitting a visible action event.
   */
  emitPendingCaptures(actionIndex: number): void {
    if (!this._onEvent) return;
    const pending = this._pendingCaptures.get(actionIndex);
    if (pending) {
      this._pendingCaptures.delete(actionIndex);
      // Emit as an action event with the screenshot data so the frontend
      // stores it in the screenshots map at the correct key.
      this._onEvent(
        {
          type: 'action',
          actionIndex,
          timestamp: Date.now(),
          category: 'other',
          action: '__final_screenshot',
          duration: 0,
          success: true,
          log: [],
          hasScreenshotBefore: !!pending.before,
          hasScreenshotAfter: false,
          hasHierarchyBefore: !!pending.hierarchyBefore,
          hasHierarchyAfter: false,
        } as ActionTraceEvent,
        pending,
      );
    }
  }

  /**
   * Emit a fully-formed action event.
   */
  addActionEvent(
    event: Omit<ActionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>,
    /** The index `captureBeforeAction` reserved for this action, when it captured. */
    reservedActionIndex?: number,
  ): void {
    if (isCurrentAttemptClosed()) return this._dropFencedReservation(reservedActionIndex);
    this._flushPendingGroups();
    const actionIndex = this._indexForEmit(reservedActionIndex);
    const now = Date.now();
    const full = {
      ...event,
      type: 'action',
      actionIndex,
      timestamp: now,
    } as ActionTraceEvent;
    this._applyTimelineTiming(full, now);
    this._events.push(full);
    const pending = this._pendingCaptures.get(actionIndex);
    this._pendingCaptures.delete(actionIndex);
    this._onEvent?.(full, pending, 'completed');
  }

  /**
   * Emit an assertion event.
   */
  addAssertionEvent(
    event: Omit<AssertionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>,
    /** The index `captureBeforeAction` reserved for this assertion, when it captured. */
    reservedActionIndex?: number,
  ): void {
    if (isCurrentAttemptClosed()) return this._dropFencedReservation(reservedActionIndex);
    this._flushPendingGroups();
    const actionIndex = this._indexForEmit(reservedActionIndex);
    const now = Date.now();
    const full = {
      ...event,
      type: 'assertion',
      actionIndex,
      timestamp: now,
    } as AssertionTraceEvent;
    this._applyTimelineTiming(full, now);
    this._events.push(full);
    const pending = this._pendingCaptures.get(actionIndex);
    this._pendingCaptures.delete(actionIndex);
    this._onEvent?.(full, pending, 'completed');
  }

  private _applyTimelineTiming(
    event: ActionTraceEvent | AssertionTraceEvent,
    completedAt: number,
  ): void {
    const ownDuration = Math.max(0, event.duration ?? 0);
    const startedAt = event.startTime ?? Math.max(this._timelineOrigin, completedAt - ownDuration);
    const previousBoundary = this._lastTimelineTimestamp;

    event.startTime = startedAt;
    event.endTime = event.endTime ?? completedAt;
    event.gapBefore = Math.max(0, startedAt - previousBoundary);
    event.wallDuration = Math.max(0, completedAt - previousBoundary);

    this._lastTimelineTimestamp = Math.max(previousBoundary, completedAt);
    this._lastTimedEvent = event;
  }

  /**
   * @internal — Allocate any remaining trace time after the last action to
   * that final action. This keeps visible wall durations consistent with the
   * metadata's test duration while preserving each action's raw `duration`.
   */
  finalizeTimeline(endTime: number): void {
    if (!this._lastTimedEvent) return;
    const trailing = Math.max(0, endTime - this._lastTimelineTimestamp);
    if (trailing === 0) return;
    this._lastTimedEvent.wallDuration = (
      this._lastTimedEvent.wallDuration ?? this._lastTimedEvent.duration
    ) + trailing;
    this._lastTimedEvent.trailingTime = (this._lastTimedEvent.trailingTime ?? 0) + trailing;
    this._lastTimelineTimestamp = endTime;
  }

  /**
   * Emit a "started" lifecycle signal for the in-flight action so UI mode
   * can render an in-progress row with a spinner. Streams via _onEvent only —
   * does NOT push to _events (saved trace archives carry only completed
   * events) and does NOT increment _actionIndex (the matching addActionEvent
   * will own the index).
   *
   * Caller passes the partial set of fields known at action start; the
   * collector fills in type/actionIndex/timestamp and the placeholder
   * `duration`/`success` fields needed to satisfy the ActionTraceEvent shape.
   */
  _emitActionStarted(
    partial: Omit<
      ActionTraceEvent,
      'type' | 'actionIndex' | 'timestamp' | 'duration' | 'success'
        | 'hasScreenshotAfter' | 'hasHierarchyAfter'
    > & {
      hasScreenshotAfter?: boolean
      hasHierarchyAfter?: boolean
    },
    /** The index reserved for the in-flight action, when its capture already ran. */
    reservedActionIndex?: number,
  ): void {
    if (!this._onEvent || isCurrentAttemptClosed()) return;
    // Flush any pending group-starts so UI mode renders the group header
    // (e.g. "beforeEach Hooks") immediately when the first action in the
    // group goes in-flight, rather than only after it completes. Once
    // streamed, the group is no longer eligible for the empty-group drop
    // optimization — but if a started signal fires, content is incoming.
    this._flushPendingGroups();
    const actionIndex = reservedActionIndex ?? this._peekActionIndex();
    const full = {
      ...partial,
      type: 'action',
      actionIndex,
      timestamp: Date.now(),
      duration: 0,
      success: true,
      hasScreenshotAfter: partial.hasScreenshotAfter ?? false,
      hasHierarchyAfter: partial.hasHierarchyAfter ?? false,
    } as ActionTraceEvent;
    const pending = this._pendingCaptures.get(actionIndex);
    this._onEvent(full, pending, 'started');
  }

  /**
   * Emit a "started" lifecycle signal for an in-flight assertion. See
   * _emitActionStarted for semantics — this is the assertion variant.
   */
  _emitAssertionStarted(
    partial: Omit<
      AssertionTraceEvent,
      'type' | 'actionIndex' | 'timestamp' | 'duration' | 'attempts' | 'passed'
    >,
    /** The index reserved for the in-flight assertion, when its capture already ran. */
    reservedActionIndex?: number,
  ): void {
    if (!this._onEvent || isCurrentAttemptClosed()) return;
    this._flushPendingGroups();
    const actionIndex = reservedActionIndex ?? this._peekActionIndex();
    const full = {
      ...partial,
      type: 'assertion',
      actionIndex,
      timestamp: Date.now(),
      duration: 0,
      attempts: 0,
      passed: true,
    } as AssertionTraceEvent;
    const pending = this._pendingCaptures.get(actionIndex);
    this._onEvent(full, pending, 'started');
  }

  // ── Groups ──

  startGroup(name: string): void {
    if (isCurrentAttemptClosed()) return;
    this._groupStack.push(name);
    // Defer emission — only flush when a child event arrives. Empty
    // groups are dropped silently in endGroup() so the trace viewer
    // doesn't render hollow section headers.
    const event = {
      type: 'group-start',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent;
    this._pendingGroupStarts.push(event);
  }

  endGroup(): void {
    if (isCurrentAttemptClosed()) return;
    const name = this._groupStack.pop() ?? 'unknown';
    // If the matching group-start is still pending, the group had no
    // children — drop both events.
    const pending = this._pendingGroupStarts[this._pendingGroupStarts.length - 1];
    if (pending && pending.name === name) {
      this._pendingGroupStarts.pop();
      return;
    }
    const event = {
      type: 'group-end',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent;
    this._events.push(event);
    this._onEvent?.(event);
  }

  /**
   * Flush any deferred group-start events. Called immediately before
   * emitting any child event so the start ordering is preserved.
   */
  private _flushPendingGroups(): void {
    if (this._pendingGroupStarts.length === 0) return;
    for (const event of this._pendingGroupStarts) {
      this._events.push(event);
      this._onEvent?.(event);
    }
    this._pendingGroupStarts.length = 0;
  }

  // ── Console ──

  private _addConsoleEvent(
    level: ConsoleLevel,
    message: string,
    source: 'test' | 'device' | 'daemon',
    deviceId?: string,
    timestamp?: number,
  ): void {
    this._flushPendingGroups();
    const event = {
      type: 'console',
      level,
      message,
      source,
      actionIndex: this._actionIndex,
      // The source's own timestamp when it has one: device and daemon log
      // lines arrive over a stream, and stamping them on arrival ordered two
      // devices' logs by stream latency rather than by when they happened.
      timestamp: timestamp && timestamp > 0 ? timestamp : Date.now(),
      ...(deviceId ? { deviceId } : {}),
    } as ConsoleTraceEvent;
    this._events.push(event);
    this._onEvent?.(event);
  }

  addLogcatEntry(level: ConsoleLevel, message: string, deviceId?: string, timestampMs?: number): void {
    this._addConsoleEvent(level, message, 'device', deviceId, timestampMs);
  }

  addDaemonLogEntry(level: ConsoleLevel, message: string, deviceId?: string, timestampMs?: number): void {
    this._addConsoleEvent(level, message, 'daemon', deviceId, timestampMs);
  }

  // ── Error ──

  addError(message: string, stack?: string): void {
    this._flushPendingGroups();
    const event = {
      type: 'error' as const,
      message,
      stack,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    };
    this._events.push(event);
    this._onEvent?.(event as AnyTraceEvent);
  }

  // ── Finalization ──

  /**
   * Get all events as NDJSON string.
   */
  toNDJSON(): string {
    return this._events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  /**
   * Clean up temporary files.
   */
  cleanup(): void {
    this.stopConsoleCapture();
    this._pendingCaptures.clear();
    this._pendingOperationHandler = null;
    this._pendingOperationStack = null;
    // Remove temp directory and its contents
    try {
      fs.rmSync(this._tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
