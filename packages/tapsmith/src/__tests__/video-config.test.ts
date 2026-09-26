import { describe, it, expect } from 'vitest';
import { resolveVideoConfig } from '../video/types.js';

describe('resolveVideoConfig (PILOT-114)', () => {
  it('defaults to off when input is undefined', () => {
    expect(resolveVideoConfig(undefined)).toEqual({ mode: 'off' });
  });

  it('defaults to off when input is null (untyped .mjs configs)', () => {
    expect(resolveVideoConfig(null)).toEqual({ mode: 'off' });
  });

  it('accepts every supported mode shorthand', () => {
    const modes = [
      'off',
      'on',
      'on-first-retry',
      'on-all-retries',
      'retain-on-failure',
      'retain-on-first-failure',
      'retain-on-failure-and-retries',
    ] as const;
    for (const m of modes) {
      expect(resolveVideoConfig(m)).toEqual({ mode: m });
    }
  });

  it('preserves size when supplied via object form', () => {
    const c = resolveVideoConfig({
      mode: 'on',
      size: { width: 1280, height: 720 },
    });
    expect(c.mode).toBe('on');
    expect(c.size).toEqual({ width: 1280, height: 720 });
  });

  it('falls back to off when object form is given without a mode', () => {
    const c = resolveVideoConfig({ size: { width: 800, height: 600 } });
    expect(c.mode).toBe('off');
    expect(c.size).toEqual({ width: 800, height: 600 });
  });
});

describe('resolveVideoConfig falsy modes', () => {
  it.each([[''], [{ mode: '' }], [{ mode: false }], [false]])('%j resolves to off', (input) => {
    expect(resolveVideoConfig(input as never).mode).toBe('off');
  });
});
