import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentResetEpoch } from '../epoch.js';
import { _resetLinkStateForTests, claimInitialUrl, handleIncomingUrl, linkState, subscribeLinkState } from '../link-state.js';

const RESET = 'app:///?__tapsmith_reset=1&nonce=n1';

describe('per-process link state', () => {
  beforeEach(() => { _resetLinkStateForTests(); });

  it('acknowledges a reset whose component unmounted while it ran (an onReload that remounts the root)', async () => {
    const before = currentResetEpoch();
    const run = vi.fn(async () => {});

    // Mounted when the link arrived, unmounted by the time the reset finished.
    const isDisposed = vi.fn(() => false);
    run.mockImplementationOnce(async () => { isDisposed.mockReturnValue(true); });

    await handleIncomingUrl(RESET, { initial: false, isDisposed, run });

    expect(run).toHaveBeenCalledTimes(1);
    expect(currentResetEpoch()).toBe(before + 1);
  });

  it('ignores a link that arrives after its component unmounted', async () => {
    const before = currentResetEpoch();
    const run = vi.fn(async () => {});

    await handleIncomingUrl(RESET, { initial: false, isDisposed: () => true, run });

    expect(run).not.toHaveBeenCalled();
    expect(currentResetEpoch()).toBe(before);
    expect(linkState().nav).toBe(0);
  });

  it('never runs the same reset twice, across remounts', async () => {
    const run = vi.fn(async () => {});
    const mounted = { initial: false, isDisposed: () => false, run };

    await handleIncomingUrl(RESET, mounted);
    await handleIncomingUrl(RESET, mounted);

    expect(run).toHaveBeenCalledTimes(1);
    expect(linkState().nav).toBe(2);
  });

  it('claims the cold-launch URL once per process', () => {
    expect(claimInitialUrl()).toBe(true);
    expect(claimInitialUrl()).toBe(false);
  });

  it('keeps the error a failed reset reported for a remounted marker, and clears it on the next success', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLinkState(listener);
    const mounted = { initial: false, isDisposed: () => false };

    await handleIncomingUrl(RESET, { ...mounted, run: async () => { throw new Error('boom'); } });
    expect(linkState().error).toBe('boom');
    await handleIncomingUrl('app:///?__tapsmith_reset=1&nonce=n2', { ...mounted, run: async () => {} });
    expect(linkState().error).toBeUndefined();

    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
