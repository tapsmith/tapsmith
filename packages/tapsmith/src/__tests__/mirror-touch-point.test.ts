import { describe, expect, it } from 'vitest';
import { mirrorTouchPoint } from '../ui-mode/mirror-touch-point.js';

// iPhone 17 Pro: 402x874 points, 3x. The frames are upright, so turned to
// landscape the frame is 2622x1206 and the interface 874x402 points. iOS
// coordinate touches take native portrait points (PILOT-1235).
const portrait = { width: 1206, height: 2622 };
const landscapeLeft = { width: 2622, height: 1206, turn: 'landscapeLeft' } as const;
const landscapeRight = { width: 2622, height: 1206, turn: 'landscapeRight' } as const;

describe('mirrorTouchPoint', () => {
  it('scales a portrait frame point to points, unturned', () => {
    expect(mirrorTouchPoint(0.5, 0.25, { ...portrait, turn: 'portrait' }, 3)).toEqual({ x: 201, y: 218.5 });
  });

  it('leaves the point alone when the turn is unknown (Android, an older agent)', () => {
    expect(mirrorTouchPoint(0.5, 0.25, portrait, 3)).toEqual({ x: 201, y: 218.5 });
    // An Android landscape frame: screen pixels are what its touches take.
    expect(mirrorTouchPoint(0.5, 0.5, { width: 2400, height: 1080 }, 1)).toEqual({ x: 1200, y: 540 });
  });

  // Measured on an iOS 26.5 simulator: the test app's tap area centre sits
  // at (437, 241.5) in the 874x402 landscape interface. Turned left, a tap
  // landed on it at native (160.5, 437); turned right, at (241.5, 437).
  it('maps a landscapeLeft point to the native portrait point that hits it', () => {
    const p = mirrorTouchPoint(437 / 874, 241.5 / 402, landscapeLeft, 3);
    expect(p!.x).toBeCloseTo(160.5);
    expect(p!.y).toBeCloseTo(437);
  });

  it('maps a landscapeRight point to the native portrait point that hits it', () => {
    const p = mirrorTouchPoint(437 / 874, 241.5 / 402, landscapeRight, 3);
    expect(p!.x).toBeCloseTo(241.5);
    expect(p!.y).toBeCloseTo(437);
  });

  it('maps the corners of a landscape frame onto the native screen', () => {
    // landscapeLeft: the interface's top-left is the device's top-right.
    expect(mirrorTouchPoint(0, 0, landscapeLeft, 3)).toEqual({ x: 402, y: 0 });
    expect(mirrorTouchPoint(1, 1, landscapeLeft, 3)).toEqual({ x: 0, y: 874 });
    // landscapeRight: the interface's top-left is the device's bottom-left.
    expect(mirrorTouchPoint(0, 0, landscapeRight, 3)).toEqual({ x: 0, y: 874 });
    expect(mirrorTouchPoint(1, 1, landscapeRight, 3)).toEqual({ x: 402, y: 0 });
  });

  it('turns an upside-down point half way round', () => {
    const upsideDown = { ...portrait, turn: 'portraitUpsideDown' } as const;
    expect(mirrorTouchPoint(0.25, 0.25, upsideDown, 3)).toEqual({ x: 301.5, y: 655.5 });
  });

  it('clamps a point outside the frame before turning it', () => {
    expect(mirrorTouchPoint(-1, 2, landscapeLeft, 3)).toEqual({ x: 0, y: 0 });
  });

  it('returns undefined with no frame yet', () => {
    expect(mirrorTouchPoint(0.5, 0.5, undefined, 3)).toBeUndefined();
  });
});
