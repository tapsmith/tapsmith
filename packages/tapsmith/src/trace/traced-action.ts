/**
 * Shared trace-recording wrapper for actions on Device and ElementHandle.
 *
 * Both classes need identical before/after screenshot + hierarchy capture,
 * element bounds lookup, and event emission logic. This module extracts that
 * common flow so neither class duplicates it.
 */

import type { TraceCollector } from './trace-collector.js';
import { extractStack, TRACE_CAPTURE_TIMEOUT_MS } from './trace-collector.js';
import type { ActionCategory } from './types.js';
import type { ActionResponse, ElementInfo, CaptureTraceStateResponse } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import { selectorToProto } from '../selectors.js';

const MIN_TRACE_FALLBACK_TIMEOUT_MS = 250;

// ─── Trace context ───

export interface TraceContext {
  collector: TraceCollector
  /** Group name of the acting device — tags every event this action emits. */
  deviceId?: string
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
  findElement?: (selector: Selector, timeoutMs: number) => Promise<{ found: boolean; element?: ElementInfo }>
  captureTraceState?: (options: {
    screenshot?: boolean;
    hierarchy?: boolean;
    elementSelector?: Selector;
  }) => Promise<CaptureTraceStateResponse | undefined>
}

// ─── Shared helper ───

export interface TracedActionExtra {
  inputValue?: string
  /**
   * Free-text second line for the action row. A function is evaluated after
   * the action completes so it can describe the result (e.g. which rung of
   * the reset ladder actually ran).
   */
  detail?: string | (() => string | undefined)
  origin?: 'inline' | 'prepared' | 'skipped'
  /**
   * Skip the before-action screenshot + hierarchy capture. Fixture-setup
   * actions (the runner's app reset) set this: the pre-reset screen is the
   * previous test's leftover state, and the capture costs a full round trip
   * on every test.
   */
  skipBeforeCapture?: boolean
  /**
   * Action index the caller already reserved (an element handle emits its
   * "started" row before the auto-wait, ahead of the capture here). The
   * capture and the completed event reuse it so the row completes in place.
   */
  reservedActionIndex?: number
}

function resolveDetail(extra: TracedActionExtra | undefined): string | undefined {
  if (!extra?.detail) return undefined;
  return typeof extra.detail === 'function' ? extra.detail() : extra.detail;
}

// ─── Before-capture with element bounds ───

type Bounds = { left: number; top: number; right: number; bottom: number };

export interface BeforeState {
  /** The index the capture reserved, or the one handed in. */
  actionIndex: number
  captures: { screenshotBefore?: unknown; hierarchyBefore?: unknown }
  /** The element's bounds at the moment of the capture, when it was found then. */
  bounds?: Bounds
}

/**
 * Capture a row's before frame (screenshot + hierarchy) together with the
 * bounds of `selector`'s element at that same moment, so the box the viewer
 * draws over the frame describes that frame. One batched round trip where the
 * device supports it (iOS), else the capture and a short element lookup in
 * parallel. Appends what it did to `log`.
 */
export async function captureBeforeState(
  ctx: TraceContext,
  selector: Selector | undefined,
  log: string[],
  reservedActionIndex?: number,
): Promise<BeforeState> {
  let actionIndex = reservedActionIndex;
  let captures: BeforeState['captures'] = {};
  let bounds: Bounds | undefined;
  const traceCaptureDeadline = Date.now() + TRACE_CAPTURE_TIMEOUT_MS;

  // When the batched captureTraceState is available (iOS), use a single
  // round-trip for screenshot + hierarchy + element bounds instead of 3
  // separate gRPC calls that each trigger their own app.snapshot() IPC.
  let batchSuccess = false;
  if (ctx.captureTraceState) {
    const batchStart = Date.now();
    try {
      const batchResult = await ctx.captureTraceState({
        screenshot: ctx.collector.config.screenshots,
        hierarchy: ctx.collector.config.snapshots,
        elementSelector: selector,
      });
      if (batchResult?.success) {
        batchSuccess = true;
        const screenshotData = batchResult.screenshotData?.length
          ? batchResult.screenshotData : undefined;
        const hierarchyXml = batchResult.hierarchyXml || undefined;

        const captured = await ctx.collector.captureBeforeAction(
          () => Promise.resolve(screenshotData as Buffer | undefined),
          () => Promise.resolve(hierarchyXml),
          undefined,
          actionIndex,
        );
        captures = captured.captures;
        actionIndex = captured.actionIndex;

        if (batchResult.elementFound && batchResult.element?.bounds) {
          bounds = batchResult.element.bounds;
          log.push(`Element found at [${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}] (${Date.now() - batchStart}ms)`);
        } else if (selector) {
          log.push(`Element lookup returned no match (${Date.now() - batchStart}ms)`);
        }
      } else {
        log.push(`Batch trace state capture failed: ${batchResult?.errorMessage ?? 'no response'}`);
      }
    } catch (err) {
      log.push(`Batch trace state capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!batchSuccess) {
    const remainingCaptureMs = traceCaptureDeadline - Date.now();
    if (remainingCaptureMs < MIN_TRACE_FALLBACK_TIMEOUT_MS) {
      log.push('Skipping individual trace capture fallback; batch consumed capture budget');
    } else {
      // Individual parallel calls (Android, or iOS fallback on batch failure)
      const boundsPromise = (selector && ctx.findElement)
        ? (async () => {
            const lookupStart = Date.now();
            try {
              const res = await ctx.findElement!(selector, 100);
              if (res.found && res.element?.bounds) {
                bounds = res.element.bounds;
                log.push(`Element found at [${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}] (${Date.now() - lookupStart}ms)`);
              } else {
                log.push(`Element lookup returned no match (${Date.now() - lookupStart}ms)`);
              }
            } catch {
              log.push(`Element lookup failed (${Date.now() - lookupStart}ms)`);
            }
          })()
        : Promise.resolve();

      const [, captured] = await Promise.all([
        boundsPromise,
        ctx.collector.captureBeforeAction(ctx.takeScreenshot, ctx.captureHierarchy, remainingCaptureMs, actionIndex),
      ]);
      captures = captured.captures;
      actionIndex = captured.actionIndex;
    }
  }

  // Nothing captured (the batch spent the whole budget): reserve the index
  // anyway, so the started row streamed next and the completed event share it
  // even when another device acts in between.
  actionIndex ??= ctx.collector._reserveActionIndex();
  return { actionIndex, captures, bounds };
}

export async function tracedAction(
  ctx: TraceContext | undefined,
  action: string,
  category: ActionCategory,
  selector: Selector | undefined,
  fn: () => Promise<ActionResponse>,
  fallbackMsg: string,
  extra?: TracedActionExtra,
): Promise<void> {
  // No trace context — just run the action directly
  if (!ctx) {
    const res = await fn();
    if (!res.success) {
      throw new Error(res.errorMessage || fallbackMsg);
    }
    return;
  }

  const stack = extractStack(new Error().stack ?? '');
  const sourceLocation = stack[0];
  const selectorStr = selector ? JSON.stringify(selectorToProto(selector)) : undefined;
  const log: string[] = [];

  let bounds: { left: number; top: number; right: number; bottom: number } | undefined;
  let point: { x: number; y: number } | undefined;

  // The index this action's events carry. Reserved by the before-capture (or
  // handed in by the caller) so a concurrent action on another device cannot
  // take the same one.
  let actionIndex: number | undefined = extra?.reservedActionIndex;
  // A skipped capture reserves nothing, so reserve here: the runner resets
  // every device of a group concurrently, and two started rows peeking the
  // same index would each be completed by the other device's event.
  if (actionIndex === undefined && extra?.skipBeforeCapture) {
    actionIndex = ctx.collector._reserveActionIndex();
  }
  let beforeCaptures: { screenshotBefore?: unknown; hierarchyBefore?: unknown } = {};

  if (extra?.skipBeforeCapture) {
    log.push('Skipping before screenshot + hierarchy (fixture setup)');
  } else {
    log.push('Capturing before screenshot + hierarchy');
    const before = await captureBeforeState(ctx, selector, log, actionIndex);
    beforeCaptures = before.captures;
    actionIndex = before.actionIndex;
    bounds = before.bounds;
    if (bounds && category === 'tap') {
      point = {
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
      };
      log.push(`Tap target: (${point.x}, ${point.y})`);
    }
  }

  // Stream a "started" lifecycle signal so UI mode can render an in-flight
  // row with a spinner immediately. The matching addActionEvent below will
  // emit at the same actionIndex with lifecycle='completed'.
  ctx.collector._emitActionStarted({
    category, action, selector: selectorStr, inputValue: extra?.inputValue,
    bounds, point, sourceLocation, stack, log: [...log], deviceId: ctx.deviceId,
    hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
    hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
  }, actionIndex);

  const start = Date.now();
  let success = true;
  let error: string | undefined;
  let errorStack: string | undefined;
  let caughtErr: unknown;

  // Local flag set by the fail handler — immune to interleaving from other actions
  let failedByTimeout = false;

  // Register pending operation so the runner can emit a failed event on timeout
  ctx.collector.setPendingOperation((timeoutError: string) => {
    failedByTimeout = true;
    ctx.collector.addActionEvent({
      category, action, selector: selectorStr, inputValue: extra?.inputValue,
      duration: Date.now() - start, success: false, error: timeoutError,
      bounds, point, log: [...log, `Timed out: ${timeoutError}`],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      sourceLocation, stack, deviceId: ctx.deviceId,
    }, actionIndex);
  }, stack);

  try {
    const res = await fn();
    if (!res.success) {
      success = false;
      error = res.errorMessage || fallbackMsg;
      throw new Error(error);
    }
  } catch (err) {
    success = false;
    if (err instanceof Error) { error = err.message; errorStack = err.stack; }
    else { error = String(err); }
    log.push(`Action failed: ${error} (${Date.now() - start}ms)`);
    caughtErr = err;
  }

  ctx.collector.clearPendingOperation();

  // If the runner's timeout already emitted a failed event, skip the normal emit
  if (failedByTimeout) {
    if (caughtErr !== undefined) {
      throw caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));
    }
    return;
  }

  if (success) {
    log.push(`Action completed successfully (${Date.now() - start}ms)`);
  }

  // Snapshot action duration before the async capture so it reflects the
  // actual action time, not action + screenshot overhead.
  const duration = Date.now() - start;

  // Emit event immediately so _actionIndex increments before the runner
  // emits group-end boundaries.  No after-capture — the trace viewer uses
  // the next action's before-screenshot as the "after" view (like Playwright).
  // This halves the screenshot overhead and avoids fire-and-forget reliability issues.
  ctx.collector.addActionEvent({
    category, action, selector: selectorStr, inputValue: extra?.inputValue,
    detail: resolveDetail(extra), origin: extra?.origin,
    duration, success, error, errorStack,
    bounds, point, log,
    hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
    hasScreenshotAfter: false,
    hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
    hasHierarchyAfter: false,
    sourceLocation, stack, deviceId: ctx.deviceId,
  }, actionIndex);

  if (caughtErr !== undefined) {
    throw caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));
  }
}
