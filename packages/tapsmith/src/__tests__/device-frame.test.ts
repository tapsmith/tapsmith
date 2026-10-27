import { describe, it, expect } from 'vitest';
import {
  inferDevicePlatform,
  inferDeviceFormFactor,
  resolveDeviceSkin,
} from '../ui-mode/ui-protocol.js';
import { bezelPlatform, selectDeviceFrame } from '../ui-mode/assets/bezels/frames.js';

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

describe('bezelPlatform', () => {
  it('draws a Mac screenshot with no phone bezel', () => {
    expect(bezelPlatform('macos')).toBeUndefined();
    expect(bezelPlatform('ios')).toBe('ios');
    expect(bezelPlatform('android')).toBe('android');
    expect(bezelPlatform(undefined)).toBeUndefined();
  });
});

describe('inferDevicePlatform (regression)', () => {
  it('still classifies common devices', () => {
    expect(inferDevicePlatform('iPhone 16')).toBe('ios');
    expect(inferDevicePlatform('Pixel 7')).toBe('android');
    expect(inferDevicePlatform('emulator-5554')).toBe('android');
  });
});
