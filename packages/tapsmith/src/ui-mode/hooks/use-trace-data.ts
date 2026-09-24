/**
 * Hook for managing per-test trace data in UI mode.
 *
 * Handles trace accumulation, blob URL lifecycle, screenshot storage,
 * and source file buffering.
 */

import { useState, useRef } from 'preact/hooks';
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, NetworkEntry } from '../../trace/types.js';
import type { InFlightAction } from '../../trace-viewer/types.js';
import type { TestIsolation } from '../ui-protocol.js';

// Re-export so existing callers (main.tsx) keep their import path.
export type { InFlightAction };

// ─── Types ───

/** Per-test trace data accumulated during execution. */
export interface TestTraceData {
  events: AnyTraceEvent[];
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[];
  screenshots: Map<string, string>;
  hierarchies: Map<string, string>;
  sources: Map<string, string>;
  network: NetworkEntry[];
  networkCaptureEnabled?: boolean;
  /** How this test's capture reached the proxy (PILOT-319); `ios-system-proxy` is host-wide. */
  networkCaptureRoute?: import('../../trace/types.js').NetworkCaptureRoute;
  /** Raw network request/response body bytes keyed by path (e.g.
   * `network/res-0.bin`). Kept as bytes rather than a decoded string because
   * binary payloads — notably gRPC/protobuf — cannot survive a UTF-8 decode:
   * invalid sequences become replacement characters and the original bytes are
   * unrecoverable. The Network tab decodes to text (or to protobuf) at render
   * time instead. */
  networkBodies: Map<string, Uint8Array>;
  /** File this test belongs to — used to scope clearing on re-runs. */
  filePath?: string;
  /** Path to the trace ZIP on the server (set when test completes). */
  tracePath?: string;
  /** Path to the recorded video MP4 on the server (set when test completes). */
  videoPath?: string;
  /** Currently in-flight action/assertion (UI mode live streaming only). */
  inFlightAction?: InFlightAction | null;
  /** Isolation the test ran under (from `test-start`); shown in the Metadata tab. */
  isolation?: TestIsolation;
}

// ─── Helpers ───

export function base64ToBlobUrl(base64: string): string {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: 'image/png' }));
}

/** Upper bound for inline body decoding in the UI (2 MiB decoded). Anything
 * larger would stall the main thread on decode and isn't useful to render
 * in a `<pre>` anyway — we substitute a placeholder so the rest of the
 * Network tab still works. */
const MAX_INLINE_BODY_BYTES = 2 * 1024 * 1024;

/** Decode a base64-encoded body into its raw bytes. Returns a short
 * placeholder (as encoded text) for bodies above `MAX_INLINE_BODY_BYTES` so we
 * don't freeze the UI on a multi-megabyte response. `atob` throws
 * `DOMException` on malformed input, so we catch and substitute a placeholder — this
 * function runs inside the network-message handler and an uncaught throw
 * would break subsequent trace updates. */
export function base64ToBytes(base64: string): Uint8Array {
  // base64 encodes ~3 bytes per 4 chars; use the encoded length as a cheap
  // upper bound to short-circuit huge bodies before we allocate.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_INLINE_BODY_BYTES) {
    return new TextEncoder().encode(
      `[body too large to display inline — ${(approxBytes / (1024 * 1024)).toFixed(1)} MB; open the trace archive to inspect]`,
    );
  }
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) {
    // The over-cap and error paths both substitute a text marker, encoded as
    // bytes so the map stays one type. Markers are ASCII, so they render
    // identically once decoded downstream.
    return new TextEncoder().encode(
      `[error decoding body: ${e instanceof Error ? e.message : String(e)}]`,
    );
  }
}

/** Nearest step before `actionIndex` with any screenshot — the step the panel
 * borrows its displayed frame from when the selected action captured none. */
function nearestScreenshotStep(
  screenshots: Map<string, string>,
  actionIndex: number,
): number | undefined {
  for (let i = actionIndex - 1; i >= 0; i--) {
    const pad = String(i).padStart(3, '0');
    if (screenshots.has(`screenshots/action-${pad}-after.png`)
      || screenshots.has(`screenshots/action-${pad}-before.png`)) return i;
  }
  return undefined;
}

/**
 * Walk backwards from `actionIndex` to find the nearest available screenshot.
 * Used at render time so no-screenshot actions (e.g. toBe assertions, query
 * methods) display a thumbnail without sharing blob URL references in the map.
 */
export function findNearestScreenshot(
  screenshots: Map<string, string>,
  actionIndex: number,
): string | undefined {
  const step = nearestScreenshotStep(screenshots, actionIndex);
  if (step === undefined) return undefined;
  const pad = String(step).padStart(3, '0');
  return screenshots.get(`screenshots/action-${pad}-after.png`)
    ?? screenshots.get(`screenshots/action-${pad}-before.png`);
}

export interface ResolvedHierarchy {
  xml: string;
  /** Set when the tree was borrowed from an earlier step because this action
   * captured none (network actions never touch the device). The displayed
   * screenshot is borrowed from the same step, so tree and frame agree —
   * but the UI should say the data predates the selected action. */
  borrowedFromStep?: number;
}

/**
 * The hierarchy the locator playground must hit-test for an action, which
 * has to depict the same moment as the screenshot the panel displays — or a
 * pick would resolve one screen over a picture of another (PILOT-302):
 *
 * - The "after" display is the next action's before-screenshot (see
 *   ScreenshotPanel), so its tree is the next action's before-hierarchy —
 *   the same moment by definition, not a borrow. Own after-hierarchies
 *   (legacy traces only) and, failing those, the own before-hierarchy
 *   (correct for read-only actions like assertions) come first for
 *   compatibility with traces that captured them.
 * - The "before" display falls back to the frame findNearestScreenshot
 *   borrows, so the tree is anchored to that same step; if that step's
 *   hierarchy capture was lost, resolve nothing rather than hit-test a tree
 *   from a different step than the displayed frame.
 */
export function resolveActionHierarchy(
  hierarchies: Map<string, string>,
  screenshots: Map<string, string>,
  actionIndex: number,
  variant: 'before' | 'after',
): ResolvedHierarchy | undefined {
  const pad = String(actionIndex).padStart(3, '0');
  const ownBefore = hierarchies.get(`hierarchy/action-${pad}-before.xml`);
  const ownAfter = hierarchies.get(`hierarchy/action-${pad}-after.xml`);

  if (variant === 'after') {
    const nextPad = String(actionIndex + 1).padStart(3, '0');
    const nextBefore = hierarchies.get(`hierarchy/action-${nextPad}-before.xml`);
    if (screenshots.has(`screenshots/action-${nextPad}-before.png`)) {
      // The panel displays the next action's before-frame; only trees from
      // that same moment may hit-test it. ownAfter (legacy) is equivalent —
      // nothing runs between the end of N and the start of N+1.
      const xml = nextBefore ?? ownAfter;
      return xml ? { xml } : undefined;
    }
    if (screenshots.has(`screenshots/action-${pad}-after.png`)) {
      const xml = ownAfter ?? nextBefore;
      return xml ? { xml } : undefined;
    }
    // No after-frame at all (e.g. screenshot-less traces): the own tree keeps
    // the Locator playground working; there is no picture to disagree with.
    const own = ownAfter ?? nextBefore ?? ownBefore;
    if (own) return { xml: own };
  } else {
    const own = ownBefore ?? ownAfter;
    if (own) return { xml: own };
  }

  const step = nearestScreenshotStep(screenshots, actionIndex);
  if (step === undefined) return undefined;
  const stepPad = String(step).padStart(3, '0');
  const xml = hierarchies.get(`hierarchy/action-${stepPad}-after.xml`)
    ?? hierarchies.get(`hierarchy/action-${stepPad}-before.xml`);
  return xml ? { xml, borrowedFromStep: step } : undefined;
}

/** Revoke all blob URLs in a trace's screenshot map to free memory. */
export function revokeTraceScreenshots(data: TestTraceData): void {
  for (const blobUrl of data.screenshots.values()) {
    try { URL.revokeObjectURL(blobUrl); } catch { /* already revoked */ }
  }
}

export function reconcileTraceWallDuration(
  data: TestTraceData,
  testDuration: number | undefined,
): TestTraceData {
  if (!testDuration || testDuration <= 0 || data.actionEvents.length === 0) return data;
  const visibleTotal = data.actionEvents.reduce(
    (sum, event) => sum + (event.wallDuration ?? event.duration),
    0,
  );
  const missing = Math.round(testDuration - visibleTotal);
  if (missing <= 0) return data;

  const last = data.actionEvents[data.actionEvents.length - 1];
  const patched = {
    ...last,
    wallDuration: (last.wallDuration ?? last.duration) + missing,
    trailingTime: (last.trailingTime ?? 0) + missing,
  } satisfies ActionTraceEvent | AssertionTraceEvent;

  const actionEvents = data.actionEvents.slice();
  actionEvents[actionEvents.length - 1] = patched;
  const events = data.events.map((event) => event === last ? patched : event);
  return { ...data, events, actionEvents };
}

export function emptyTraceData(filePath?: string): TestTraceData {
  return { events: [], actionEvents: [], screenshots: new Map(), hierarchies: new Map(), sources: new Map(), network: [], networkBodies: new Map(), filePath, inFlightAction: null };
}

/** Get existing trace data or create a new entry. */
export function getOrCreateTrace(
  testFullName: string,
  traces: Map<string, TestTraceData>,
  filePath?: string,
): { data: TestTraceData; map: Map<string, TestTraceData> } {
  const existing = traces.get(testFullName);
  if (existing) return { data: existing, map: traces };
  const data = emptyTraceData(filePath);
  const map = new Map(traces);
  map.set(testFullName, data);
  return { data, map };
}

// ─── Stable empty references ───

export const EMPTY_MAP = new Map<string, string>();
/** Byte-valued counterpart for `TestTraceData.networkBodies`, which holds raw
 * bytes so binary (gRPC/protobuf) payloads survive to the Network tab. */
export const EMPTY_BYTES_MAP = new Map<string, Uint8Array>();
export const EMPTY_EVENTS: AnyTraceEvent[] = [];
export const EMPTY_ACTION_EVENTS: (ActionTraceEvent | AssertionTraceEvent)[] = [];
export const EMPTY_NETWORK: NetworkEntry[] = [];

// ─── Hook ───

export function useTraceData() {
  const [testTraces, setTestTraces] = useState<Map<string, TestTraceData>>(new Map());

  // Ref tracks the currently-running test — a ref (not state) so the message
  // handler always reads the latest value regardless of React batching.
  const activeTestRef = useRef<string | null>(null);

  // Pending source files keyed by filename — accumulated from 'source' messages
  // and snapshotted into per-test trace data when 'test-start' fires.
  const pendingSourcesRef = useRef<Map<string, string>>(new Map());

  return {
    testTraces,
    setTestTraces,
    activeTestRef,
    pendingSourcesRef,
  };
}
