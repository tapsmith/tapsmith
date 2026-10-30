import { describe, it, expect } from 'vitest';
import { inheritedStepBounds } from '../ui-mode/step-bounds.js';
import type { ActionTraceEvent, AssertionTraceEvent } from '../trace/types.js';

const WELCOME = { left: 10, top: 20, right: 110, bottom: 60 };
const OWN = { left: 0, top: 0, right: 5, bottom: 5 };
const WELCOME_SEL = '{"text":"Welcome to Expo"}';
const TYPO_SEL = '{"text":"Try editting"}';

let index = 0;

function action(o: Partial<ActionTraceEvent> = {}): ActionTraceEvent {
  return {
    type: 'action',
    actionIndex: index++,
    timestamp: 0,
    category: 'tap',
    action: 'tap',
    duration: 1,
    success: true,
    hasScreenshotBefore: false,
    hasScreenshotAfter: false,
    hasHierarchyBefore: false,
    hasHierarchyAfter: false,
    ...o,
  };
}

function assertion(o: Partial<AssertionTraceEvent> = {}): AssertionTraceEvent {
  return {
    type: 'assertion',
    actionIndex: index++,
    timestamp: 0,
    assertion: 'toBeVisible',
    passed: true,
    soft: false,
    negated: false,
    duration: 1,
    attempts: 1,
    ...o,
  };
}

describe('inheritedStepBounds (PILOT-920)', () => {
  it('keeps a step\'s own bounds', () => {
    const prev = action({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(assertion({ selector: WELCOME_SEL, bounds: OWN }), prev)).toEqual(OWN);
  });

  it('gives a failed assertion on another element no box', () => {
    const prev = assertion({ selector: WELCOME_SEL, bounds: WELCOME });
    const failed = assertion({ selector: TYPO_SEL, passed: false, error: 'not visible' });
    expect(inheritedStepBounds(failed, prev)).toBeUndefined();
  });

  it('gives a passing step on another element no box', () => {
    const prev = assertion({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(action({ selector: TYPO_SEL }), prev)).toBeUndefined();
  });

  it('gives an in-flight assertion on another element no box', () => {
    // The started half of an event carries passed: true until it completes.
    const prev = assertion({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(assertion({ selector: TYPO_SEL }), prev)).toBeUndefined();
  });

  it('carries the element box to the value assertion that checks what the step read', () => {
    // const text = await getByText('Welcome').textContent(); expect(text).toBe(...)
    const read = action({ category: 'other', action: 'textContent', selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(assertion({ assertion: 'toBe' }), read)).toEqual(WELCOME);
  });

  it('carries it on through a chain of value assertions', () => {
    const read = action({ category: 'other', action: 'textContent', selector: WELCOME_SEL, bounds: WELCOME });
    const first = assertion({ assertion: 'toContain', bounds: inheritedStepBounds(assertion({ assertion: 'toContain' }), read) });
    expect(inheritedStepBounds(assertion({ assertion: 'toContain' }), first)).toEqual(WELCOME);
  });

  it('gives a failed value assertion no box', () => {
    const read = action({ category: 'other', action: 'textContent', selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(assertion({ assertion: 'toBe', passed: false }), read)).toBeUndefined();
  });

  it('carries the box to an action on the same element whose own lookup missed', () => {
    const prev = action({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(action({ selector: WELCOME_SEL }), prev)).toEqual(WELCOME);
  });

  it('gives a failed action on the same element no box', () => {
    const prev = action({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(action({ selector: WELCOME_SEL, success: false }), prev)).toBeUndefined();
  });

  it('gives a locator assertion that recorded no bounds no box, even on the same element', () => {
    // tap(x) then expect(x).toBeHidden(): the recorder leaves bounds unset
    // because the element is gone, so a box would sit over empty space.
    const tap = action({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(assertion({ assertion: 'toBeHidden', selector: WELCOME_SEL }), tap)).toBeUndefined();
  });

  it('gives a device-level action no element box', () => {
    const tap = action({ selector: WELCOME_SEL, bounds: WELCOME });
    expect(inheritedStepBounds(action({ category: 'navigation', action: 'pressBack' }), tap)).toBeUndefined();
  });

  it('borrows only from the step right before, never an earlier one', () => {
    const before = action({ selector: TYPO_SEL });
    expect(inheritedStepBounds(assertion({ assertion: 'toBe' }), before)).toBeUndefined();
  });

  it('never carries a box to a step on another device', () => {
    const aliceRead = action({ action: 'textContent', selector: WELCOME_SEL, bounds: WELCOME, deviceId: 'alice' });
    expect(inheritedStepBounds(action({ selector: WELCOME_SEL, deviceId: 'bob' }), aliceRead)).toBeUndefined();
    expect(inheritedStepBounds(assertion({ assertion: 'toBe' }), aliceRead)).toBeUndefined();
  });

  it('gives the first step of a test no borrowed box', () => {
    expect(inheritedStepBounds(assertion({ assertion: 'toBe' }), undefined)).toBeUndefined();
  });
});
