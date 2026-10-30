import type { ActionTraceEvent, AssertionTraceEvent } from '../trace/types.js';

type StepEvent = ActionTraceEvent | AssertionTraceEvent;
type ElementBounds = NonNullable<StepEvent['bounds']>;

/**
 * The element box UI mode draws for a step: its own recorded bounds, or the
 * box of the step right before it when the step is a passing value assertion
 * checking what that step read, e.g. `expect(await el.textContent()).toBe(...)`
 * (value assertions have no element of their own to look up).
 *
 * Nothing else borrows. A failed step has nothing on screen to point at
 * (`show-trace` shows no box either). A locator assertion or an action that
 * recorded no bounds did look its element up and did not find it on screen:
 * `toBeHidden`, `waitFor({ state: 'detached' })`, `count()` returning 0. A
 * borrowed box there would sit over empty space. Bounds never cross devices.
 */
export function inheritedStepBounds(
  ev: StepEvent,
  previous: StepEvent | undefined,
): ElementBounds | undefined {
  if (ev.bounds) return ev.bounds;
  const isValueAssertion = ev.type === 'assertion' && !ev.selector;
  if (!isValueAssertion || ev.passed === false) return undefined;
  if (!previous?.bounds || ev.deviceId !== previous.deviceId) return undefined;
  return previous.bounds;
}
