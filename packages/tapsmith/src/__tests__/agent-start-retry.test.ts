import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableAgentStartError,
  startAgentWithRetry,
} from '../worker-protocol.js';

// PILOT-948: on a loaded iOS CI runner the agent start failed before any
// test ran, and never got the retry the SDK keeps for transient starts.

const LAUNCH_TIMEOUT = 'The iOS agent could not launch dev.tapsmith.testapp on simulator SIM-1: '
  + 'Failed to launch dev.tapsmith.testapp: Timed out attempting to launch app.';
const NOT_INSTALLED = 'The iOS agent could not launch com.example.App on simulator SIM-1: '
  + 'Failed to launch com.example.App: The request to open "com.example.App" failed.\n'
  + 'com.example.App is not installed on this simulator.';
const AGENT_TIMEOUT = 'Timed out waiting for iOS agent to start on simulator SIM-1 after 150s. Killed xcodebuild.';

describe('isRetryableAgentStartError', () => {
  it("retries the runner's own launch timeout, which a slow runner hits on a cold start", () => {
    expect(isRetryableAgentStartError(new Error(LAUNCH_TIMEOUT))).toBe(true);
  });

  it('does not retry an app that is not installed', () => {
    expect(isRetryableAgentStartError(new Error(NOT_INSTALLED))).toBe(false);
  });

  it('keeps retrying the agent timeout and a dropped connection', () => {
    expect(isRetryableAgentStartError(new Error(AGENT_TIMEOUT))).toBe(true);
    expect(isRetryableAgentStartError(new Error('14 UNAVAILABLE: Connection dropped'))).toBe(true);
  });
});

describe('startAgentWithRetry', () => {
  const noDelay = { delayMs: 0, loadAverage: () => ({ load: 312.4, cpus: 3 }) };

  it('returns the first attempt without retrying', async () => {
    const start = vi.fn(async () => 'ok');
    const onRetry = vi.fn();
    await expect(startAgentWithRetry(start, onRetry, noDelay)).resolves.toBe('ok');
    expect(start).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries a transient failure once and reports it', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error(LAUNCH_TIMEOUT))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    await expect(startAgentWithRetry(start, onRetry, noDelay)).resolves.toBe('ok');
    expect(start).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ message: LAUNCH_TIMEOUT }));
  });

  it('fails a permanent error at once, unchanged', async () => {
    const start = vi.fn().mockRejectedValue(new Error(NOT_INSTALLED));
    await expect(startAgentWithRetry(start, vi.fn(), noDelay)).rejects.toThrow(NOT_INSTALLED);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('names the machine load when the retry also times out', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('14 UNAVAILABLE: Connection dropped'))
      .mockRejectedValueOnce(new Error(LAUNCH_TIMEOUT));
    const failure = startAgentWithRetry(start, vi.fn(), noDelay);
    await expect(failure).rejects.toThrow(LAUNCH_TIMEOUT);
    await expect(failure).rejects.toThrow(/The agent did not start in 2 attempts\. .*load average 312\.4 on 3 CPUs/s);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('adds no load note when the machine is not short of CPU', async () => {
    const start = vi.fn().mockRejectedValue(new Error(LAUNCH_TIMEOUT));
    const failure = startAgentWithRetry(start, vi.fn(), { delayMs: 0, loadAverage: () => ({ load: 0.5, cpus: 10 }) });
    await expect(failure).rejects.toThrow(LAUNCH_TIMEOUT);
    await expect(failure).rejects.not.toThrow(/load average/);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('adds no load note when the retry fails some other way', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error(AGENT_TIMEOUT))
      .mockRejectedValueOnce(new Error(NOT_INSTALLED));
    const failure = startAgentWithRetry(start, vi.fn(), noDelay);
    await expect(failure).rejects.toThrow(NOT_INSTALLED);
    await expect(failure).rejects.not.toThrow(/load average/);
  });

  it('rethrows a non-Error rejection as it came when it is not retried', async () => {
    const start = vi.fn().mockRejectedValue('boom');
    await expect(startAgentWithRetry(start, vi.fn(), noDelay)).rejects.toBe('boom');
  });
});
