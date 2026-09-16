import { describe, expect, it } from 'vitest';
import { emptyTraceData, resolveActionHierarchy, reconcileTraceWallDuration } from '../ui-mode/hooks/use-trace-data.js';
import type { ActionTraceEvent } from '../trace/types.js';

function action(actionIndex: number, duration: number, wallDuration = duration): ActionTraceEvent {
  return {
    type: 'action',
    actionIndex,
    timestamp: 1000 + actionIndex,
    category: 'tap',
    action: 'tap',
    duration,
    wallDuration,
    success: true,
    hasScreenshotBefore: false,
    hasScreenshotAfter: false,
    hasHierarchyBefore: false,
    hasHierarchyAfter: false,
  };
}

describe('reconcileTraceWallDuration', () => {
  it('allocates missing test duration to the final streamed action', () => {
    const first = action(0, 50, 100);
    const last = action(1, 25, 200);
    const trace = emptyTraceData('test.ts');
    trace.events = [first, last];
    trace.actionEvents = [first, last];

    const reconciled = reconcileTraceWallDuration(trace, 500);

    expect(reconciled).not.toBe(trace);
    expect(reconciled.actionEvents[0]).toBe(first);
    expect(reconciled.actionEvents[1].duration).toBe(25);
    expect(reconciled.actionEvents[1].wallDuration).toBe(400);
    expect(reconciled.actionEvents[1].trailingTime).toBe(200);
    expect(reconciled.events[1]).toBe(reconciled.actionEvents[1]);
  });

  it('does not rewrite trace data when wall durations already reconcile', () => {
    const only = action(0, 50, 500);
    const trace = emptyTraceData('test.ts');
    trace.events = [only];
    trace.actionEvents = [only];

    expect(reconcileTraceWallDuration(trace, 500)).toBe(trace);
  });
});

describe('resolveActionHierarchy', () => {
  const hier = (i: number, variant: 'before' | 'after', xml: string) =>
    [`hierarchy/action-${String(i).padStart(3, '0')}-${variant}.xml`, xml] as const;
  const shot = (i: number, variant: 'before' | 'after') =>
    [`screenshots/action-${String(i).padStart(3, '0')}-${variant}.png`, 'blob:x'] as const;

  it("uses the action's own before-hierarchy for the before display, with no borrow flag", () => {
    const hierarchies = new Map([hier(2, 'before', '<own />')]);
    const screenshots = new Map([shot(2, 'before')]);

    expect(resolveActionHierarchy(hierarchies, screenshots, 2, 'before')).toEqual({ xml: '<own />' });
  });

  it('borrows from the same step the displayed screenshot is borrowed from', () => {
    const hierarchies = new Map([hier(1, 'before', '<step1 />')]);
    const screenshots = new Map([shot(1, 'before')]);

    expect(resolveActionHierarchy(hierarchies, screenshots, 3, 'before')).toEqual({
      xml: '<step1 />',
      borrowedFromStep: 1,
    });
  });

  it("resolves nothing when the displayed frame's step lost its hierarchy, rather than mismatch", () => {
    // Step 2 saved its screenshot but its hierarchy capture failed; step 1
    // has a tree, but it depicts a different screen than the displayed frame.
    const hierarchies = new Map([hier(1, 'before', '<step1 />')]);
    const screenshots = new Map([shot(1, 'before'), shot(2, 'before')]);

    expect(resolveActionHierarchy(hierarchies, screenshots, 3, 'before')).toBeUndefined();
  });

  it("the after display uses the next step's before-capture — the same moment as its frame", () => {
    const hierarchies = new Map([hier(0, 'before', '<step0 />'), hier(2, 'before', '<step2 />')]);
    const screenshots = new Map([shot(0, 'before'), shot(2, 'before')]);

    // Not a borrow: the next step's before-capture IS this action's after state.
    expect(resolveActionHierarchy(hierarchies, screenshots, 1, 'after')).toEqual({ xml: '<step2 />' });
  });

  it("the after display resolves nothing when the next step's frame exists but its tree was lost", () => {
    const hierarchies = new Map([hier(0, 'before', '<step0 />')]);
    const screenshots = new Map([shot(0, 'before'), shot(2, 'before')]);

    expect(resolveActionHierarchy(hierarchies, screenshots, 1, 'after')).toBeUndefined();
  });

  it('keeps the locator playground working on screenshot-less traces', () => {
    const hierarchies = new Map([hier(1, 'before', '<own />')]);

    expect(resolveActionHierarchy(hierarchies, new Map(), 1, 'after')).toEqual({ xml: '<own />' });
  });

  it('resolves nothing for the first action and for empty traces', () => {
    expect(resolveActionHierarchy(new Map(), new Map(), 0, 'before')).toBeUndefined();
    const hierarchies = new Map([hier(1, 'before', '<later />')]);
    expect(resolveActionHierarchy(hierarchies, new Map(), 0, 'before')).toBeUndefined();
  });
});
