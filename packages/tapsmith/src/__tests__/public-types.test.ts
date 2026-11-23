/**
 * Types the docs name in signatures and config tables must be importable
 * from "tapsmith", or a user annotating with them gets TS2305. The checks are
 * type-level and run under `npm run typecheck`.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { Device, ElementHandle, ElementInfo, ScreenshotResponse, TapsmithConfig, VideoConfig, VideoMode } from '../index.js';

describe('public types named by the docs', () => {
  it('exports the element and screenshot result types', () => {
    expectTypeOf<Awaited<ReturnType<ElementHandle['find']>>>().toEqualTypeOf<ElementInfo>();
    expectTypeOf<Awaited<ReturnType<Device['takeScreenshot']>>>().toEqualTypeOf<ScreenshotResponse>();
  });

  it('exports the video config types', () => {
    expectTypeOf<VideoMode>().toMatchTypeOf<TapsmithConfig['video']>();
    expectTypeOf<Partial<VideoConfig>>().toMatchTypeOf<TapsmithConfig['video']>();
  });
});
