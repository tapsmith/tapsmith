/**
 * DeviceFrame — wraps a device mirror canvas in a bezel.
 *
 * Renders a photographic frame image (from bezel.fit, see assets/bezels) when
 * one fits the device, with the canvas positioned over the frame's screen
 * window. Falls back to the CSS bezel (`.dm-skin-*`) for tablets, landscape or
 * odd-shaped screens, unknown platforms, or if the frame image fails to load.
 * The choice follows the live frame's shape (`contentAspect`), so a rotation
 * mid-session switches bezels.
 *
 * Both bezels render the same element tree around `children` (the CSS bezel's
 * wrappers are `display: contents`), so switching bezels never remounts the
 * mirror canvas: the grid registers each tile's canvas once, and a remounted
 * canvas would stop receiving frames.
 */

import type { ComponentChildren } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import type { DevicePlatform } from '../ui-protocol.js';
import { selectMirrorBezel, screenWindowStyle, screenMaskStyle } from '../assets/bezels/frames.js';

interface DeviceFrameProps {
  platform?: DevicePlatform
  /** Device name / serial — tablet model names win over the screen shape. */
  hints: Array<string | undefined>
  /** width÷height of the frame on screen; undefined before the first frame. */
  contentAspect?: number
  /** When true (single mirror), the frame is sized to fit the container's height
   * as well as its width — measured in JS since the container's CSS height is
   * not reliably "definite" enough for container queries. Grid tiles omit this
   * and fill their width (their height is content-driven). */
  heightBound?: boolean
  /** The mirror canvas (with its ref + event handlers) to place inside the frame. */
  children: ComponentChildren
}

export function DeviceFrame({ platform, hints, contentAspect, heightBound, children }: DeviceFrameProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  const bezel = selectMirrorBezel({ platform, hints, contentAspect });
  const formFactor = bezel.formFactor;

  // Re-attempt the photographic frame when the device changes — a past load
  // failure (or a different platform/form factor) shouldn't stick forever.
  useLayoutEffect(() => {
    setImgFailed(false);
  }, [platform, formFactor]);

  const frame = imgFailed ? undefined : bezel.frame;
  const frameAspect = frame?.frameAspect;
  // The CSS bezel's box is the canvas plus the skin's padding, so it is fitted
  // through the canvas's own shape — known once a frame has arrived.
  const cssFitAspect = frame ? undefined : contentAspect;

  // Fit the whole device into the container by width AND height: CSS max-*
  // alone caps the canvas's height without narrowing it, which letterboxes the
  // screen inside the canvas box and skews the tap/pick mapping (both
  // normalise against that box). For the image bezel this caps the frame
  // width at (container height × frame aspect); for the CSS bezel, the canvas
  // width at the room left inside the skin's padding. clientHeight reflects
  // the real rendered height regardless of CSS definiteness, so this works
  // where container-query height does not.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    const fitAspect = frameAspect ?? cssFitAspect;
    if (!heightBound || !fitAspect || !el || !parent) return;
    const measure = () => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w <= 0 || h <= 0) return;
      if (frameAspect) {
        setWidth(Math.min(w, h * frameAspect));
        return;
      }
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setWidth(Math.max(0, Math.min(w - padX, (h - padY) * fitAspect)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [heightBound, frameAspect, cssFitAspect]);

  if (frame) {
    const style: Record<string, string> = { '--dm-fa': String(frame.frameAspect) };
    if (heightBound && width) style.width = `${width.toFixed(2)}px`;
    return (
      <div ref={ref} class="dm-frame dm-frame-img" data-testid="device-bezel" data-bezel="image" style={style}>
        <div class="dm-frame-screen" style={screenMaskStyle(frame)}>
          <div class="dm-frame-screen-rect" style={screenWindowStyle(frame)}>
            {children}
          </div>
        </div>
        <img
          class="dm-frame-png"
          src={frame.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={() => setImgFailed(true)}
        />
      </div>
    );
  }

  // Same tree as above (root > div > div > children), minus the frame image,
  // so Preact keeps the canvas element when the bezel switches.
  const classes = ['dm-frame'];
  if (platform) classes.push(`dm-skin-${platform}`, `dm-skin-${formFactor}`);
  // A phone whose screen shape rules out the photo frame is rotated or has no
  // notch (iPhone SE class): the skin's island / punch-hole / side buttons are
  // drawn for an upright modern phone and would sit over real screen content.
  if (platform && formFactor === 'phone' && !bezel.frame && contentAspect !== undefined) {
    classes.push('dm-skin-bare');
  }
  const style: Record<string, string> = {};
  if (platform && heightBound && cssFitAspect && width) style['--dm-canvas-w'] = `${width.toFixed(2)}px`;
  return (
    <div ref={ref} class={classes.join(' ')} style={style} data-testid="device-bezel" data-bezel={platform ? `css-${formFactor}` : 'none'}>
      <div class="dm-frame-passthrough">
        <div class="dm-frame-passthrough">
          {children}
        </div>
      </div>
    </div>
  );
}
