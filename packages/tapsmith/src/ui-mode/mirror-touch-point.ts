/**
 * mirror-touch-point — where a touch on the live mirror goes on the device.
 *
 * Mirror frames are upright, as the screen shows them, so a point on one is
 * a point in the app's interface. iOS coordinate touches (tapXY, touchDown,
 * …) take points in the device's native portrait space instead, so on a
 * turned iOS device the point is turned back with the frame's `turn`, the
 * same mapping the agent's `HidTouch.nativePoint` uses for test taps
 * (PILOT-1235). Android touches take screen points, and its frames carry no
 * turn.
 */

/** How the device was turned when the frame was captured (`ScreenshotResponse.orientation`). */
export type DeviceTurn = 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown';

export interface MirrorFrame {
  /** The frame's pixel size, upright. */
  width: number
  height: number
  /** Set for iOS frames; absent when the device's touches take screen points. */
  turn?: DeviceTurn
}

/** A `ScreenshotResponse.orientation` as a turn; undefined for empty or unknown. */
export function parseDeviceTurn(orientation: string | undefined): DeviceTurn | undefined {
  switch (orientation) {
    case 'portrait':
    case 'landscapeLeft':
    case 'landscapeRight':
    case 'portraitUpsideDown':
      return orientation;
    default:
      return undefined;
  }
}

/**
 * The device point for a normalized (0–1, clamped) point on `frame`: frame
 * pixels ÷ `dpr` give interface points, turned to native portrait points
 * when the frame records a turn. undefined before the first frame.
 */
export function mirrorTouchPoint(
  nx: number,
  ny: number,
  frame: MirrorFrame | undefined,
  dpr: number,
): { x: number; y: number } | undefined {
  if (!frame) return undefined;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const width = frame.width / dpr;
  const height = frame.height / dpr;
  const x = clamp(nx) * width;
  const y = clamp(ny) * height;
  switch (frame.turn) {
    case 'landscapeLeft':
      // The interface's top edge is the device's right edge, its left edge
      // the device's top. The native width is the interface's height.
      return { x: height - y, y: x };
    case 'landscapeRight':
      // The interface's top edge is the device's left edge, its left edge
      // the device's bottom. The native height is the interface's width.
      return { x: y, y: width - x };
    case 'portraitUpsideDown':
      return { x: width - x, y: height - y };
    default:
      return { x, y };
  }
}
