import { describe, it, expect, vi, afterEach } from 'vitest';
import { actionBudget } from '../element-handle.js';

// PILOT-223: the iOS agent can spend a dispatch's whole budget waiting out a
// covered target, so each dispatch of one action gets what is left of a single
// deadline — and that deadline starts at the first dispatch, not when the
// action was set up (a traced action captures the screen in between).

describe('actionBudget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts the deadline at the first read, not at creation', () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budget = actionBudget(4000);
    now += 3000; // e.g. a slow before-action trace capture
    expect(budget()).toBe(4000);
    now += 1500;
    expect(budget()).toBe(2500);
  });

  it('floors a late retry at the 1 s minimum action budget, not ~0', () => {
    // The daemon waits the budget + 5 s for the agent's answer; a retry sent
    // with ~1 ms would give a slow agent (Android a11y reads, PILOT-278) far
    // less room than it had before retries shared a deadline.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budget = actionBudget(4000);
    budget();
    now += 3500;
    expect(budget()).toBe(1000);
    now += 5000;
    expect(budget()).toBe(1000);
  });

  it('never raises a small starting budget to the floor', () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budget = actionBudget(300);
    expect(budget()).toBe(300);
    now += 200;
    expect(budget()).toBe(300);
  });

  it('keeps an explicit zero budget (no waiting) at zero', () => {
    expect(actionBudget(0)()).toBe(0);
  });
});
