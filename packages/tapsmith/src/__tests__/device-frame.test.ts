import { describe, it, expect } from 'vitest';
import {
  inferDevicePlatform,
  inferDeviceFormFactor,
  resolveDeviceSkin,
} from '../ui-mode/ui-protocol.js';
import { selectDeviceFrame, selectMirrorBezel } from '../ui-mode/assets/bezels/frames.js';

describe('inferDeviceFormFactor', () => {
  it('treats tablet model names as tablets regardless of ratio', () => {
    expect(inferDeviceFormFactor({ hints: ['iPad Pro (12.9-inch)'] })).toBe('tablet');
    expect(inferDeviceFormFactor({ hints: ['Pixel Tablet'] })).toBe('tablet');
    expect(inferDeviceFormFactor({ hints: ['Galaxy Tab S9'] })).toBe('tablet');
    expect(inferDeviceFormFactor({ hints: ['SM-X510'] })).toBe('tablet');
    expect(inferDeviceFormFactor({ hints: ['Nexus 9'] })).toBe('tablet');
  });

  it('treats phone model names as phones', () => {
    expect(inferDeviceFormFactor({ hints: ['iPhone 16 Pro'] })).toBe('phone');
    expect(inferDeviceFormFactor({ hints: ['Pixel 7'] })).toBe('phone');
  });

  it('falls back to the screen aspect ratio for opaque serials', () => {
    // Phones are elongated; tablets are squarer.
    expect(inferDeviceFormFactor({ hints: ['emulator-5554'], aspectRatio: 1080 / 2400 })).toBe('phone');
    expect(inferDeviceFormFactor({ hints: ['emulator-5554'], aspectRatio: 1600 / 2560 })).toBe('tablet');
    // 16:9 (≈0.5625) is a phone; 5:3 (≈0.6, common Android tablets) is a tablet.
    expect(inferDeviceFormFactor({ hints: ['emulator-5554'], aspectRatio: 9 / 16 })).toBe('phone');
    expect(inferDeviceFormFactor({ hints: ['emulator-5554'], aspectRatio: 3 / 5 })).toBe('tablet');
  });

  it('defaults to phone when nothing is known', () => {
    expect(inferDeviceFormFactor()).toBe('phone');
  });
});

describe('resolveDeviceSkin', () => {
  it('combines platform and form factor', () => {
    expect(resolveDeviceSkin('ios', 'phone')).toBe('ios-phone');
    expect(resolveDeviceSkin('android', 'tablet')).toBe('android-tablet');
  });

  it('defaults to phone and returns undefined without a platform', () => {
    expect(resolveDeviceSkin('ios')).toBe('ios-phone');
    expect(resolveDeviceSkin(undefined)).toBeUndefined();
  });
});

describe('selectDeviceFrame', () => {
  it('returns a photographic frame for phones', () => {
    const ios = selectDeviceFrame({ platform: 'ios', formFactor: 'phone' });
    expect(ios?.src).toBeTruthy();
    expect(ios?.screenAspect).toBeGreaterThan(0.4);
    expect(ios?.screenAspect).toBeLessThan(0.55);
    expect(selectDeviceFrame({ platform: 'android', formFactor: 'phone' })?.src).toBeTruthy();
  });

  it('falls back to CSS for tablets and unknown platforms', () => {
    expect(selectDeviceFrame({ platform: 'ios', formFactor: 'tablet' })).toBeUndefined();
    expect(selectDeviceFrame({ platform: undefined })).toBeUndefined();
  });

  it('rejects screens whose aspect ratio differs too much from the frame', () => {
    // Modern phone ratio → accepted.
    expect(selectDeviceFrame({ platform: 'ios', contentAspect: 1179 / 2556 })).toBeTruthy();
    // iPad-ish ratio → rejected (would be stretched).
    expect(selectDeviceFrame({ platform: 'ios', contentAspect: 0.75 })).toBeUndefined();
    // iPhone SE (squarer 16:9) → rejected.
    expect(selectDeviceFrame({ platform: 'ios', contentAspect: 750 / 1334 })).toBeUndefined();
  });
});

describe('selectMirrorBezel', () => {
  // The live mirror's choice: name hints plus the shape of the frame on screen.
  const pick = (platform: 'ios' | 'android' | undefined, hints: string[], contentAspect?: number) =>
    selectMirrorBezel({ platform, hints, contentAspect });

  it('uses the photographic frame for a modern portrait phone', () => {
    const b = pick('android', ['Pixel 7'], 1080 / 2400);
    expect(b.frame).toBeDefined();
    expect(b.formFactor).toBe('phone');
    expect(pick('ios', ['iPhone 16 Pro'], 1179 / 2556).frame).toBeDefined();
  });

  it('falls back to the CSS phone bezel for a landscape frame', () => {
    const b = pick('ios', ['iPhone 16 Pro'], 2556 / 1179);
    expect(b.frame).toBeUndefined();
    expect(b.formFactor).toBe('phone');
    expect(pick('android', ['emulator-5554'], 2400 / 1080)).toEqual({ frame: undefined, formFactor: 'phone' });
  });

  it('treats an opaque-named device with a tablet-shaped screen as a tablet', () => {
    expect(pick('android', ['emulator-5554'], 1600 / 2560)).toEqual({ frame: undefined, formFactor: 'tablet' });
    // Rotated, still a tablet.
    expect(pick('android', ['emulator-5554'], 2560 / 1600)).toEqual({ frame: undefined, formFactor: 'tablet' });
  });

  it('falls back to the CSS phone bezel for squarer phones (iPhone SE class)', () => {
    expect(pick('ios', ['iPhone SE (3rd generation)'], 750 / 1334)).toEqual({ frame: undefined, formFactor: 'phone' });
  });

  it('keeps a named tablet a tablet whatever the frame shape', () => {
    expect(pick('ios', ['iPad Air 11-inch (M2)'], 0.46).formFactor).toBe('tablet');
    expect(pick('ios', ['iPad Air 11-inch (M2)'], 0.46).frame).toBeUndefined();
  });

  it('decides from the name alone before the first frame arrives', () => {
    expect(pick('ios', ['iPhone 16'], undefined).frame).toBeDefined();
    expect(pick('ios', ['iPad Pro'], undefined)).toEqual({ frame: undefined, formFactor: 'tablet' });
    expect(pick(undefined, ['mystery'], 0.46)).toEqual({ frame: undefined, formFactor: 'phone' });
  });
});

describe('inferDevicePlatform (regression)', () => {
  it('still classifies common devices', () => {
    expect(inferDevicePlatform('iPhone 16')).toBe('ios');
    expect(inferDevicePlatform('Pixel 7')).toBe('android');
    expect(inferDevicePlatform('emulator-5554')).toBe('android');
  });
});
