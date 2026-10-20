import normalizeColor from '@react-native/normalize-colors';
import { describe, expect, it } from 'vitest';
import { CARRIER_TEXT_COLOR } from '../carrier-color.js';

/**
 * How React Native hands a colour to Android: `processColor()` reorders the
 * normalised `0xRRGGBBAA` into Android's `0xAARRGGBB`. Fabric's Android
 * renderer treats the resulting int `0` as "no colour set" (`UndefinedColor`)
 * and never sends it to the TextView, which then draws in the theme's default
 * text colour — black.
 */
function androidColorInt(color: string): number {
  const normalized = normalizeColor(color);
  if (normalized === null) throw new Error(`${color} is not a colour React Native understands`);
  return ((normalized << 24) | (normalized >>> 8)) >>> 0;
}

describe('hooks marker carrier colour (PILOT-732)', () => {
  it("is not 'transparent', which Fabric on Android reads as unset and draws black", () => {
    // Why the carrier cannot simply be transparent: it encodes to 0.
    expect(androidColorInt('transparent')).toBe(0);
    expect(androidColorInt(CARRIER_TEXT_COLOR)).not.toBe(0);
  });

  it('keeps an alpha that does not round to 0', () => {
    // A colour like rgba(0,0,0,0.001) is not "transparent" by name but rounds
    // to alpha 0 and so to the same unset int.
    expect(androidColorInt(CARRIER_TEXT_COLOR) >>> 24).toBeGreaterThan(0);
  });

  it('is still invisible: alpha of at most 1/255', () => {
    // At alpha 1/255 a pixel moves by at most one level out of 255.
    expect(androidColorInt(CARRIER_TEXT_COLOR) >>> 24).toBeLessThanOrEqual(1);
  });
});
