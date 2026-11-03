import { describe, it, expect } from 'vitest';
import {
  ACTION_RETRY_DELAYS_MS,
  EXPECT_RETRY_DELAYS_MS,
  backoff,
  estimateAttempts,
} from '../retry-schedule.js';

describe('retry schedules (PILOT-972)', () => {
  it("match Playwright's action and expect schedules", () => {
    expect(ACTION_RETRY_DELAYS_MS).toEqual([0, 20, 100, 100, 500]);
    expect(EXPECT_RETRY_DELAYS_MS).toEqual([100, 250, 500, 1000]);
  });

  it('cannot be mutated by a caller', () => {
    expect(Object.isFrozen(ACTION_RETRY_DELAYS_MS)).toBe(true);
    expect(Object.isFrozen(EXPECT_RETRY_DELAYS_MS)).toBe(true);
  });
});

describe('backoff()', () => {
  it('walks the schedule and repeats its last delay', () => {
    const next = backoff([0, 20, 100, 100, 500]);
    expect([next(), next(), next(), next(), next(), next(), next()]).toEqual([0, 20, 100, 100, 500, 500, 500]);
  });

  it('starts every instance at the first delay', () => {
    const a = backoff(ACTION_RETRY_DELAYS_MS);
    a(); a(); a();
    const b = backoff(ACTION_RETRY_DELAYS_MS);
    expect(b()).toBe(0);
    expect(a()).toBe(100);
  });

  it('caps a delay at what is left of the deadline, never below 0', () => {
    const now = Date.now();
    const next = backoff([100, 1000]);
    expect(next(now + 40)).toBeLessThanOrEqual(40);
    expect(next(now + 40)).toBeGreaterThanOrEqual(0);
    expect(next(now - 500)).toBe(0);
  });

  it('still advances the schedule when a delay is capped', () => {
    const next = backoff([100, 250, 500]);
    next(Date.now() - 1);
    expect(next()).toBe(250);
  });

  it('refuses an empty schedule', () => {
    expect(() => backoff([])).toThrow(/at least one delay/);
  });
});

describe('estimateAttempts()', () => {
  it('counts the reads an idealised loop (instant reads) fits into a duration', () => {
    // reads at 0, 100, 350, 850, 1850, 2850 …
    expect(estimateAttempts(0, EXPECT_RETRY_DELAYS_MS)).toBe(1);
    expect(estimateAttempts(99, EXPECT_RETRY_DELAYS_MS)).toBe(1);
    expect(estimateAttempts(100, EXPECT_RETRY_DELAYS_MS)).toBe(2);
    expect(estimateAttempts(849, EXPECT_RETRY_DELAYS_MS)).toBe(3);
    expect(estimateAttempts(850, EXPECT_RETRY_DELAYS_MS)).toBe(4);
    expect(estimateAttempts(5000, EXPECT_RETRY_DELAYS_MS)).toBe(8);
  });

  it('counts a zero delay as a read of its own', () => {
    // reads at 0, 0, 20, 120, 220, 720
    expect(estimateAttempts(0, ACTION_RETRY_DELAYS_MS)).toBe(2);
    expect(estimateAttempts(720, ACTION_RETRY_DELAYS_MS)).toBe(6);
  });

  it('treats a negative duration as one read', () => {
    expect(estimateAttempts(-5, EXPECT_RETRY_DELAYS_MS)).toBe(1);
  });
});
