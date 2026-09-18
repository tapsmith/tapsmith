import { describe, it, expect, vi } from 'vitest';
import { parseSelectorToInternal, resolveActionTarget, formatBounds } from '../mcp/locator-helper.js';
import { selectorToProto } from '../selectors.js';
import type { TapsmithGrpcClient, ElementInfo } from '../grpc-client.js';

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1',
    className: 'android.widget.TextView',
    text: '',
    contentDescription: '',
    resourceId: '',
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: '',
    checked: false,
    selected: false,
    focused: false,
    role: '',
    viewportRatio: 1.0,
    ...overrides,
  };
}

function makeClient(elements: ElementInfo[]): TapsmithGrpcClient {
  return {
    findElements: vi.fn(async () => ({ requestId: '1', elements, errorMessage: '' })),
  } as unknown as TapsmithGrpcClient;
}

describe('parseSelectorToInternal', () => {
  it('maps getByText without options to textContains (runtime substring default)', () => {
    const { selector, index } = parseSelectorToInternal('device.getByText("Sign in")');
    expect(selectorToProto(selector)).toEqual({ textContains: 'Sign in' });
    expect(index).toBeUndefined();
  });

  it('maps getByText with { exact: true } to exact text', () => {
    const { selector } = parseSelectorToInternal('device.getByText("Sign in", { exact: true })');
    expect(selectorToProto(selector)).toEqual({ text: 'Sign in' });
  });

  it('preserves the positional chain instead of dropping it', () => {
    expect(parseSelectorToInternal('device.getByText("Item").first()').index).toBe('first');
    expect(parseSelectorToInternal('device.getByText("Item").last()').index).toBe('last');
    expect(parseSelectorToInternal('device.getByText("Item").nth(2)').index).toBe(2);
  });

  it('maps getByRole with name', () => {
    const { selector } = parseSelectorToInternal('device.getByRole("button", { name: "Sign in" })');
    expect(selectorToProto(selector)).toEqual({ role: { role: 'button', name: 'Sign in' } });
  });

  it('throws on invalid locator strings', () => {
    expect(() => parseSelectorToInternal('not a locator')).toThrow(/Invalid locator/);
  });
});

describe('resolveActionTarget (strict mode, PILOT-226)', () => {
  it('returns the raw locator for a unique match', async () => {
    const client = makeClient([makeElementInfo({ text: 'Sign in' })]);
    const target = await resolveActionTarget(client, 'device.getByText("Sign in")');
    expect(target.error).toBeUndefined();
    expect(selectorToProto(target.selector)).toEqual({ textContains: 'Sign in' });
  });

  it('errors with the strict-mode match list when ambiguous and unchained', async () => {
    const client = makeClient([
      makeElementInfo({ text: 'Sign in to continue', role: 'text' }),
      makeElementInfo({ text: 'Sign in', role: 'button' }),
    ]);
    const target = await resolveActionTarget(client, 'device.getByText("Sign in")');
    expect(target.error).toMatch(/^strict mode violation/);
    expect(target.error).toContain('resolved to 2 elements');
    expect(target.error).toContain('Sign in to continue');
  });

  it('honors .nth() by re-targeting the resolved element', async () => {
    const client = makeClient([
      makeElementInfo({ text: 'Sign in to continue' }),
      makeElementInfo({ text: 'Sign in', resourceId: 'sign_in_button' }),
    ]);
    const target = await resolveActionTarget(client, 'device.getByText("Sign in").nth(1)');
    expect(target.error).toBeUndefined();
    expect(selectorToProto(target.selector)).toEqual({ resourceId: 'sign_in_button' });
  });

  it('errors when the index is out of range', async () => {
    const client = makeClient([makeElementInfo({ text: 'Only one' })]);
    const target = await resolveActionTarget(client, 'device.getByText("Only").nth(5)');
    expect(target.error).toMatch(/out of range/);
  });

  it('errors after the wait when nothing matches', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient([]);
      const targetPromise = resolveActionTarget(client, 'device.getByText("Ghost")');
      await vi.advanceTimersByTimeAsync(6_000);
      const target = await targetPromise;
      expect(target.error).toMatch(/No elements match/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatBounds', () => {
  it('renders hierarchy-XML style bounds', () => {
    expect(formatBounds({ left: 1, top: 2, right: 3, bottom: 4 })).toBe('[1,2][3,4]');
    expect(formatBounds(undefined)).toBe('');
  });
});

describe('review follow-ups (PR #124)', () => {
  it('parses and resolves negative .nth() indices from the end', async () => {
    const client = makeClient([
      makeElementInfo({ text: 'A', resourceId: 'a' }),
      makeElementInfo({ text: 'B', resourceId: 'b' }),
      makeElementInfo({ text: 'C', resourceId: 'c' }),
    ]);
    const target = await resolveActionTarget(client, 'device.getByText("Item").nth(-1)');
    expect(target.error).toBeUndefined();
    expect(selectorToProto(target.selector)).toEqual({ resourceId: 'c' });
  });

  it('surfaces daemon errorMessage immediately instead of polling to timeout', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'agent connection lost' }));
    const client = { findElements } as unknown as TapsmithGrpcClient;
    const start = Date.now();
    const target = await resolveActionTarget(client, 'device.getByText("X")');
    expect(target.error).toBe('agent connection lost');
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(findElements).toHaveBeenCalledTimes(1);
  });
});

describe('positional re-targeting ambiguity guard (PR #124 review)', () => {
  it('addresses the resolved element by its cached id when text is shared', async () => {
    const client = makeClient([
      makeElementInfo({ elementId: 'item-a', text: 'Item' }),
      makeElementInfo({ elementId: 'item-b', text: 'Item' }),
    ]);
    // .nth(1) resolves to the second "Item". Both share the same text, but the
    // exact element is addressed by its cached id — no error, no mis-tap.
    const target = await resolveActionTarget(client, 'device.getByText("Item", { exact: true }).nth(1)');
    expect(target.error).toBeUndefined();
    expect(target.elementId).toBe('item-b');
  });

  it('allows re-targeting when the identifying property is unique to the resolved element', async () => {
    const client = makeClient([
      makeElementInfo({ text: 'Item A' }),
      makeElementInfo({ text: 'Item B' }),
    ]);
    const target = await resolveActionTarget(client, 'device.getByText("Item").nth(1)');
    expect(target.error).toBeUndefined();
    expect(selectorToProto(target.selector)).toEqual({ text: 'Item B' });
  });

  it('prefers resourceId targeting, which disambiguates same-text elements', async () => {
    const client = makeClient([
      makeElementInfo({ text: 'Item', resourceId: 'row_0' }),
      makeElementInfo({ text: 'Item', resourceId: 'row_1' }),
    ]);
    const target = await resolveActionTarget(client, 'device.getByText("Item", { exact: true }).nth(1)');
    expect(target.error).toBeUndefined();
    expect(selectorToProto(target.selector)).toEqual({ resourceId: 'row_1' });
  });
});
