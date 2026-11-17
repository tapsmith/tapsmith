import { describe, it, expect } from 'vitest';
import {
  inferDevicePlatform,
  inferDeviceFormFactor,
  resolveDeviceSkin,
} from '../ui-mode/ui-protocol.js';
import { selectBezel, svgFrame, turnCcw } from '../ui-mode/assets/bezels/frames.js';

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

describe('selectBezel', () => {
  // The one choice the live mirror, its grid tiles and the trace viewer share:
  // name hints plus the shape of the screen.
  const pick = (platform: 'ios' | 'android' | undefined, hints: string[], contentAspect?: number) =>
    selectBezel({ platform, hints, contentAspect });
  const kind = (platform: 'ios' | 'android' | undefined, hints: string[], contentAspect?: number) =>
    pick(platform, hints, contentAspect).frame?.kind;

  it('uses the photographic frame for a modern portrait phone', () => {
    expect(kind('android', ['Pixel 7'], 1080 / 2400)).toBe('photo');
    expect(kind('ios', ['iPhone 16 Pro'], 1179 / 2556)).toBe('photo');
    expect(kind('android', ['emulator-5554'], 1080 / 2340)).toBe('photo');
    expect(pick('ios', ['iPhone 16 Pro'], 1179 / 2556)).toMatchObject({ formFactor: 'phone', landscape: false });
  });

  it('turns the photographic frame for a landscape phone', () => {
    const b = pick('ios', ['iPhone 16 Pro'], 2556 / 1179);
    expect(b.landscape).toBe(true);
    expect(b.frame?.kind).toBe('photo-landscape');
    expect(b.frame?.turn).toBe('ccw');
    // The portrait image, in a box of the inverse shape, with a landscape window.
    const portrait = pick('ios', ['iPhone 16 Pro'], 1179 / 2556).frame!;
    expect(b.frame?.src).toBe(portrait.src);
    expect(b.frame?.mask).not.toBe(portrait.mask);
    expect(b.frame?.frameAspect).toBeCloseTo(1 / portrait.frameAspect, 6);
    expect(b.frame?.screenAspect).toBeCloseTo(1 / portrait.screenAspect, 6);
    expect(kind('android', ['emulator-5554'], 2400 / 1080)).toBe('photo-landscape');
  });

  it('turns the screen rect counter-clockwise (top edge to the left)', () => {
    const r = turnCcw({ leftPct: 0.1, topPct: 0.02, widthPct: 0.8, heightPct: 0.9 });
    expect(r.leftPct).toBeCloseTo(0.02, 9);
    expect(r.topPct).toBeCloseTo(0.1, 9);
    expect(r.widthPct).toBeCloseTo(0.9, 9);
    expect(r.heightPct).toBeCloseTo(0.8, 9);
  });

  it('draws an SVG tablet frame at the exact screen shape, either way up', () => {
    for (const [platform, hints, aspect] of [
      ['ios', ['iPad Air 11-inch (M2)'], 1640 / 2360],
      ['ios', ['iPad Air 11-inch (M2)'], 2360 / 1640],
      ['android', ['emulator-5554'], 1600 / 2560],
      ['android', ['emulator-5554'], 2560 / 1600],
      ['android', ['Pixel Tablet'], 2560 / 1600],
    ] as const) {
      const b = pick(platform, [...hints], aspect);
      expect(b.frame?.kind).toBe('tablet');
      expect(b.formFactor).toBe('tablet');
      expect(b.frame?.screenAspect).toBeCloseTo(aspect, 2);
      expect(b.frame?.turn).toBeUndefined();
    }
  });

  it('keeps a named tablet a tablet whatever the frame shape', () => {
    expect(kind('ios', ['iPad Air 11-inch (M2)'], 0.46)).toBe('tablet');
  });

  it('draws compact (SE-class) phones as SVG, upright and turned', () => {
    const b = pick('ios', ['iPhone SE (3rd generation)'], 750 / 1334);
    expect(b.frame?.kind).toBe('compact');
    expect(b.formFactor).toBe('phone');
    expect(b.frame?.screenAspect).toBeCloseTo(750 / 1334, 2);
    const turned = pick('ios', ['iPhone SE (3rd generation)'], 1334 / 750);
    expect(turned.frame?.kind).toBe('compact');
    expect(turned.landscape).toBe(true);
    expect(turned.frame?.screenAspect).toBeCloseTo(1334 / 750, 2);
    expect(turned.frame?.frameAspect).toBeGreaterThan(1);
    // A 16:9 Android emulator is the same class.
    expect(kind('android', ['emulator-5556'], 720 / 1280)).toBe('compact');
  });

  it('draws an exact SVG phone for phone shapes the photographs do not fit', () => {
    // 18:9 is squarer than the ≈0.45 photo window; 0.4 is taller.
    expect(kind('android', ['emulator-5554'], 1080 / 2160)).toBe('phone');
    expect(kind('android', ['Pixel 7'], 0.4)).toBe('phone');
    expect(pick('android', ['emulator-5554'], 1080 / 2160).frame?.screenAspect).toBeCloseTo(0.5, 2);
  });

  it('draws foldables folded (outer) and unfolded (inner)', () => {
    // Pixel 9 Pro Fold: named like a phone, but a foldable.
    expect(kind('android', ['Pixel 9 Pro Fold'], 1080 / 2424)).toBe('foldable-outer');
    expect(pick('android', ['Pixel 9 Pro Fold'], 2076 / 2152)).toMatchObject({ formFactor: 'tablet' });
    expect(kind('android', ['Pixel 9 Pro Fold'], 2076 / 2152)).toBe('foldable-inner');
    expect(kind('android', ['pixel_fold'], 2208 / 1840)).toBe('foldable-inner');
    expect(kind('android', ['Galaxy Z Fold6'], 968 / 2376)).toBe('foldable-outer');
    // iPhone Duo: outer ≈5.4", inner ≈7.6" near-square.
    expect(kind('ios', ['iPhone Duo'], 0.47)).toBe('foldable-outer');
    expect(kind('ios', ['iPhone Duo'], 0.87)).toBe('foldable-inner');
    expect(kind('ios', ['iPhone Duo'], 1 / 0.87)).toBe('foldable-inner');
    // A folded foldable turned on its side is turned like a phone.
    const turned = pick('ios', ['iPhone Duo'], 1 / 0.47).frame!;
    expect(turned.kind).toBe('foldable-outer');
    expect(turned.screenAspect).toBeCloseTo(1 / 0.47, 2);
  });

  it('decides from the name alone before the first frame arrives', () => {
    expect(kind('ios', ['iPhone 16'])).toBe('photo');
    expect(kind('ios', ['iPad Pro'])).toBe('tablet');
    expect(kind('android', ['Pixel Fold'])).toBe('foldable-outer');
    expect(pick('ios', ['iPhone 16']).landscape).toBe(false);
  });

  it('draws no bezel without a platform', () => {
    expect(pick(undefined, ['mystery'], 0.46)).toEqual({ frame: undefined, formFactor: 'phone', landscape: false });
  });

  it('ignores a non-finite or zero aspect', () => {
    expect(kind('ios', ['iPhone 16'], 0)).toBe('photo');
    expect(kind('ios', ['iPhone 16'], Number.NaN)).toBe('photo');
  });
});

describe('svgFrame (accept check)', () => {
  // PILOT-1238's accept check for generated frames, applied to every SVG kind
  // and both orientations: one axis-aligned window of the screen's shape,
  // symmetric where the device is, within a frame box of the right shape.
  const kinds = ['phone', 'compact', 'tablet', 'foldable-outer', 'foldable-inner'] as const;
  const aspects = [0.45, 0.5625, 0.75, 0.87, 1, 1 / 0.87, 1.6, 2.2];

  it.each(kinds.flatMap((k) => (['ios', 'android'] as const).flatMap((p) => aspects.map((a) => [k, p, a] as const))))(
    '%s %s at %f',
    (k, p, a) => {
      const f = svgFrame(k, p, a);
      expect(f.kind).toBe(k);
      expect(Math.abs(f.screenAspect / a - 1)).toBeLessThan(0.005);
      const { leftPct, topPct, widthPct, heightPct } = f.screen;
      for (const v of [leftPct, topPct, widthPct, heightPct]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      }
      expect(leftPct + widthPct).toBeLessThan(1);
      expect(topPct + heightPct).toBeLessThan(1);
      // The folded foldable's hinge side is thicker; everything else is
      // symmetric across the axis its camera sits on.
      const right = 1 - leftPct - widthPct;
      const bottom = 1 - topPct - heightPct;
      const turned = f.frameAspect > 1 && (k === 'phone' || k === 'compact' || k === 'foldable-outer');
      if (k !== 'foldable-outer') {
        if (turned) expect(topPct).toBeCloseTo(bottom, 6);
        else expect(leftPct).toBeCloseTo(right, 6);
      }
      expect(f.src.startsWith('data:image/svg+xml,')).toBe(true);
      expect(f.mask.startsWith('data:image/svg+xml,')).toBe(true);
      const svg = decodeURIComponent(f.src.slice('data:image/svg+xml,'.length));
      const mask = decodeURIComponent(f.mask.slice('data:image/svg+xml,'.length));
      const viewBox = (s: string) => /viewBox="([^"]+)"/.exec(s)?.[1];
      expect(viewBox(mask)).toBe(viewBox(svg));
      const [, , vw, vh] = viewBox(svg)!.split(' ').map(Number);
      expect(vw / vh).toBeCloseTo(f.frameAspect, 4);
    },
  );

  it('caches frames by kind, platform and shape', () => {
    expect(svgFrame('tablet', 'ios', 0.75)).toBe(svgFrame('tablet', 'ios', 0.7501));
    expect(svgFrame('tablet', 'ios', 0.75)).not.toBe(svgFrame('tablet', 'android', 0.75));
  });

  it('gives compact iPhones square screen corners (no status-bar clipping)', () => {
    const mask = decodeURIComponent(svgFrame('compact', 'ios', 750 / 1334).mask);
    expect(mask).not.toMatch(/ a/);
  });
});

describe('inferDevicePlatform (regression)', () => {
  it('still classifies common devices', () => {
    expect(inferDevicePlatform('iPhone 16')).toBe('ios');
    expect(inferDevicePlatform('Pixel 7')).toBe('android');
    expect(inferDevicePlatform('emulator-5554')).toBe('android');
  });
});
