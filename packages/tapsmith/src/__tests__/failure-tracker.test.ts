import { describe, it, expect, vi } from 'vitest';
import { FailureTracker } from '../failure-tracker.js';
import type { TestResult } from '../runner.js';

const result = (fullName: string, over: Partial<TestResult> = {}): TestResult => ({
  name: fullName, fullName, status: 'failed', durationMs: 1, filePath: '/a.test.ts', error: new Error('expected'), ...over,
});

describe('FailureTracker', () => {
  it('is reached at the limit, once, and tells its listeners', () => {
    const tracker = new FailureTracker(2);
    const listener = vi.fn();
    tracker.onReached(listener);
    tracker.onTestEnd(result('one'));
    expect(tracker.reached).toBe(false);
    tracker.onTestEnd(result('two'));
    tracker.onTestEnd(result('three'));
    expect(tracker.reached).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts neither a pass, a skip nor an attempt that will be retried', () => {
    const tracker = new FailureTracker(1);
    tracker.onTestEnd(result('a', { status: 'passed', error: undefined }));
    tracker.onTestEnd(result('b', { status: 'skipped', error: undefined }));
    tracker.onTestEnd(result('c', { _willRetry: true }));
    expect(tracker.reached).toBe(false);
  });

  it('counts a test once, however often it is reported', () => {
    const tracker = new FailureTracker(2);
    tracker.onTestEnd(result('a'));
    tracker.onTestFileEnd('/a.test.ts', [result('a')]);
    expect(tracker.reached).toBe(false);
  });

  it('counts the same test of two projects twice', () => {
    const tracker = new FailureTracker(2);
    tracker.onTestEnd(result('a', { project: 'android' }));
    tracker.onTestEnd(result('a', { project: 'ios' }));
    expect(tracker.reached).toBe(true);
  });

  it('counts an infrastructure failure only if the file ends with it', () => {
    const infra = result('a', { error: new Error('Agent connection dropped') });
    const tracker = new FailureTracker(1);
    tracker.onTestEnd(infra);
    expect(tracker.reached).toBe(false);
    tracker.onTestFileEnd('/a.test.ts', [infra]);
    expect(tracker.reached).toBe(true);
  });

  it('forgets a failure of a discarded file attempt', () => {
    const tracker = new FailureTracker(2);
    tracker.onTestEnd(result('a'));
    tracker.onTestFileEnd('/a.test.ts', [result('a', { status: 'passed', error: undefined })]);
    tracker.onTestEnd(result('b'));
    expect(tracker.reached).toBe(false);
  });
});
