import type { ActionTraceEvent, AssertionTraceEvent } from '../trace/types.js';

type StepEvent = ActionTraceEvent | AssertionTraceEvent;
type ElementBounds = NonNullable<StepEvent['bounds']>;

/**
 * The element box UI mode draws for a step: its own recorded bounds, or the
 * box of the step right before it when the two are provably about the same
 * element.
 *
 * Borrowing is for the chains where the recorder could not look the element
 * up itself:
 * - a passing value assertion (no selector) checking what the step before
 *   read, e.g. `expect(await el.textContent()).toBe(...)`;
 * - a passing action on the same element whose own bounds lookup missed.
 *
 * Never borrowed: a failed step (nothing matched — `show-trace` shows no box
 * either), a step on another element or device, a device-level action, or a
 * locator assertion (expect.ts records no bounds on purpose when the element
 * is hidden or gone, rather than a box over empty space).
 */
export function inheritedStepBounds(
  ev: StepEvent,
  previous: StepEvent | undefined,
): ElementBounds | undefined {
  if (ev.bounds) return ev.bounds;
  if (!previous?.bounds) return undefined;
  if (ev.deviceId !== previous.deviceId) return undefined;
  if (ev.type === 'assertion') {
    return ev.passed !== false && !ev.selector ? previous.bounds : undefined;
  }
  return ev.success !== false && ev.selector !== undefined && ev.selector === previous.selector
    ? previous.bounds
    : undefined;
}
