/**
 * Device-frame bezels for UI mode's live mirror and the trace viewer.
 *
 * Every device class gets a frame whose screen window matches its screen:
 *
 * - **Modern phones, portrait** — photographic frames (`iphone.png`,
 *   `android.png`) with a transparent screen window, extracted once from the
 *   bezel.fit API by scripts/fetch-bezels.mjs. Re-run that script to
 *   regenerate them, then paste its printed metadata into PHOTO_FRAMES below.
 * - **Modern phones, landscape** — the same photographs turned 90°
 *   counter-clockwise (camera on the left). The frame PNG is turned in CSS
 *   (`.dm-frame-png-ccw`), so no second copy is inlined; its screen-opening
 *   mask is turned at build time by scripts/rotate-bezels.mjs
 *   (`*-mask-landscape.png`), because a CSS mask cannot be.
 * - **Everything else** — tablets, compact (iPhone SE-class) phones, phones
 *   whose shape the photographs don't fit, and foldables (iPhone Duo, Pixel
 *   Fold, Galaxy Z Fold; folded and unfolded) — SVG frames drawn here in code
 *   (`svgFrame`) at the device's exact screen aspect, so the window always
 *   matches. They are small data: URIs built on demand and cached.
 *
 * The assets are imported here so Vite inlines them into the single-file
 * builds; bezel.fit is never called at runtime.
 *
 * Provenance and licence:
 * - bezel.fit frames: bezel.fit's terms (https://bezel.fit/terms, last
 *   updated 2026-05-07, checked 2026-11-17) say "You keep all rights to the
 *   screenshots you upload and to the framed PNGs the API returns" and that
 *   the service is "free for personal and commercial use". They add that the
 *   frames "depict third-party hardware" and that the user is responsible for
 *   using the images "in line with each manufacturer's trademark and brand
 *   guidelines". No attribution is required. The masks and landscape masks
 *   are derived from those PNGs.
 * - SVG frames: drawn from scratch in this file (MIT, like the rest of the
 *   package). They are generic shapes, not likenesses of a specific product.
 *
 * The CSS bezels (ui-mode.css.ts / trace-viewer.css.ts `.dm-skin-*`) remain
 * as the fallback if a frame image fails to load.
 */

import type { DevicePlatform, DeviceFormFactor } from '../../ui-protocol.js';
import { inferDeviceFormFactor } from '../../ui-protocol.js';
import iphoneFrame from './iphone.png';
import androidFrame from './android.png';
import iphoneMask from './iphone-mask.png';
import androidMask from './android-mask.png';
import iphoneMaskLandscape from './iphone-mask-landscape.png';
import androidMaskLandscape from './android-mask-landscape.png';

/** Screen window within a frame image, as fractions of the frame's width/height. */
export interface ScreenRect {
  leftPct: number
  topPct: number
  widthPct: number
  heightPct: number
}

export interface DeviceFrame {
  /** Inlined data URI of the frame image (transparent screen window). */
  src: string
  /** width / height of the full frame box. */
  frameAspect: number
  /** Where the device screen sits inside the frame. */
  screen: ScreenRect
  /** width / height of the screen window. */
  screenAspect: number
  /** Inlined data URI of the full-frame screen-opening mask (opaque over the
   * exact screen shape, transparent over the bezel and outside). Applied to a
   * layer that fills the frame — identically to the frame image — so the two
   * align exactly and the content is clipped to the bezel's real opening. */
  mask: string
  /** Set when `src` is a portrait image to be drawn turned 90° counter-clockwise
   * to fill this (landscape) frame box. */
  turn?: 'ccw'
  /** Which kind of frame this is (exposed for tests and the DOM's data-frame). */
  kind: FrameKind
}

/**
 * - `photo` / `photo-landscape`: the bezel.fit phone photographs.
 * - `phone`: a generic modern phone the photographs don't fit.
 * - `compact`: an SE-class phone (thick top and bottom bezels, home button on iOS).
 * - `tablet`: an iPad / Android tablet.
 * - `foldable-outer` / `foldable-inner`: a book-style foldable's cover screen / unfolded screen.
 */
export type FrameKind = 'photo' | 'photo-landscape' | 'phone' | 'compact' | 'tablet' | 'foldable-outer' | 'foldable-inner'

function rectAspect(screen: ScreenRect, frameAspect: number): number {
  return (screen.widthPct / screen.heightPct) * frameAspect;
}

function photoFrame(src: string, frameAspect: number, screen: ScreenRect, mask: string): DeviceFrame {
  return { src, frameAspect, screen, screenAspect: rectAspect(screen, frameAspect), mask, kind: 'photo' };
}

/** A screen rect after turning its frame 90° counter-clockwise (top edge → left edge). */
export function turnCcw(screen: ScreenRect): ScreenRect {
  return {
    leftPct: screen.topPct,
    topPct: 1 - screen.leftPct - screen.widthPct,
    widthPct: screen.heightPct,
    heightPct: screen.widthPct,
  };
}

function landscapeOf(portrait: DeviceFrame, landscapeMask: string): DeviceFrame {
  const frameAspect = 1 / portrait.frameAspect;
  const screen = turnCcw(portrait.screen);
  return {
    src: portrait.src,
    frameAspect,
    screen,
    screenAspect: rectAspect(screen, frameAspect),
    mask: landscapeMask,
    turn: 'ccw',
    kind: 'photo-landscape',
  };
}

// ─── Generated by scripts/fetch-bezels.mjs (bezel.fit) ───
const PHOTO_FRAMES: Record<DevicePlatform, { portrait: DeviceFrame; landscape: DeviceFrame }> = (() => {
  const ios = photoFrame(iphoneFrame, 0.4895, { leftPct: 0.0533, topPct: 0.025, widthPct: 0.8935, heightPct: 0.95 }, iphoneMask);
  const android = photoFrame(androidFrame, 0.4751, { leftPct: 0.0418, topPct: 0.0202, widthPct: 0.9078, heightPct: 0.9623 }, androidMask);
  return {
    ios: { portrait: ios, landscape: landscapeOf(ios, iphoneMaskLandscape) },
    android: { portrait: android, landscape: landscapeOf(android, androidMaskLandscape) },
  };
})();

/**
 * How far a phone's screen aspect may differ from a photograph's screen
 * window before an exact-fit SVG frame is drawn instead. The photographs'
 * windows are ≈0.46 (iOS) and ≈0.45 (Android); modern phones (≈0.43–0.49)
 * fit. Squarer phones (18:9 = 0.5, a folded Pixel Fold 0.52, iPhone SE 0.56)
 * would show black bars inside the window, so they get an SVG frame.
 */
const PHOTO_TOLERANCE = 0.1;

// ─── Device classes ───

/** Book-style foldables: iPhone Duo, Pixel (Pro) Fold, Galaxy Z Fold, Honor/Oppo/Vivo folds. */
const FOLDABLE_RE = /fold(?!er)|\bduo\b/i;
/** A foldable's screen at least this square (short ÷ long side) is its unfolded inner screen. */
const UNFOLDED_MIN_RATIO = 0.7;
/** A phone at least this square (short ÷ long side) is drawn compact (SE class, 16:9). */
const COMPACT_MIN_RATIO = 0.53;

/** Short side ÷ long side (≤ 1). */
function squareness(aspect: number): number {
  return aspect <= 1 ? aspect : 1 / aspect;
}

/** Typical screen aspect (portrait) per class, used before the first frame tells us the real one. */
const DEFAULT_ASPECT: Record<Exclude<FrameKind, 'photo' | 'photo-landscape'>, Record<DevicePlatform, number>> = {
  'phone': { ios: 1179 / 2556, android: 1080 / 2400 },
  'compact': { ios: 750 / 1334, android: 720 / 1280 },
  'tablet': { ios: 1640 / 2360, android: 1600 / 2560 },
  'foldable-outer': { ios: 0.5, android: 1080 / 2092 },
  'foldable-inner': { ios: 0.86, android: 2208 / 1840 },
};

/** The bezel to draw around a device's screen. */
export interface Bezel {
  /** The frame to draw; undefined without a platform (no bezel at all). */
  frame: DeviceFrame | undefined
  /** Which CSS skin to draw if the frame image fails to load. */
  formFactor: DeviceFormFactor
  /** The screen is wider than tall (the CSS skin moves its camera and buttons to the short edges). */
  landscape: boolean
}

/**
 * Pick the bezel for a device from what is known about it: its name and
 * serial (`hints` — authoritative for tablets and foldables) and the shape of
 * its screen (`contentAspect`, width÷height: the live frame or the screenshot,
 * which changes on rotation). Before the first frame `contentAspect` is
 * undefined and the choice rests on the name alone. The one entry point the
 * live mirror, its grid tiles and the trace viewer all go through.
 */
export function selectBezel(opts: {
  platform?: DevicePlatform
  hints?: Array<string | undefined>
  contentAspect?: number
}): Bezel {
  const { platform, hints = [] } = opts;
  const aspect = opts.contentAspect && opts.contentAspect > 0 && Number.isFinite(opts.contentAspect)
    ? opts.contentAspect
    : undefined;
  const landscape = aspect !== undefined && aspect > 1;
  const kind = classify(hints, aspect, platform);
  const formFactor: DeviceFormFactor = kind === 'tablet' || kind === 'foldable-inner' ? 'tablet' : 'phone';
  if (!platform) return { frame: undefined, formFactor, landscape };
  if (kind === 'photo') {
    return { frame: landscape ? PHOTO_FRAMES[platform].landscape : PHOTO_FRAMES[platform].portrait, formFactor, landscape };
  }
  return { frame: svgFrame(kind, platform, aspect ?? DEFAULT_ASPECT[kind][platform]), formFactor, landscape };
}

function classify(hints: Array<string | undefined>, aspect: number | undefined, platform: DevicePlatform | undefined): Exclude<FrameKind, 'photo-landscape'> {
  const text = hints.filter(Boolean).join(' ');
  if (FOLDABLE_RE.test(text)) {
    return aspect !== undefined && squareness(aspect) >= UNFOLDED_MIN_RATIO ? 'foldable-inner' : 'foldable-outer';
  }
  if (inferDeviceFormFactor({ hints, aspectRatio: aspect }) === 'tablet') return 'tablet';
  if (aspect === undefined) return 'photo';
  if (platform) {
    const photo = PHOTO_FRAMES[platform].portrait.screenAspect;
    if (Math.abs(squareness(aspect) / photo - 1) <= PHOTO_TOLERANCE) return 'photo';
  }
  return squareness(aspect) >= COMPACT_MIN_RATIO ? 'compact' : 'phone';
}

// ─── SVG frames ───

/** Geometry of an SVG frame, in units where the screen's short side is 1000. */
interface Geometry {
  /** Bezel thickness on each side of the screen, in the frame's upright (portrait) orientation. */
  top: number
  bottom: number
  left: number
  right: number
  bodyRadius: number
  screenRadius: number
}

/**
 * Materials, as SVG gradients. Each frame is its own document (an <img>
 * data: URI), so these ids cannot collide with another frame's or the page's.
 * Light comes from the top of the frame as it is shown; `lit()` gives a
 * gradient's direction in the upright drawing (a turned frame is lit from its
 * upright right side, which ends up on top).
 */
function defs(turned: boolean): string {
  // Top → bottom as shown; for a turned frame that is right → left upright.
  const lit = turned ? 'x1="1" y1="0" x2="0" y2="0"' : 'x1="0" y1="0" x2="0" y2="1"';
  // Across a button or groove: they are tall, thin rects in the upright
  // drawing, and a bounding-box gradient turns with its element, so this is
  // the same in both orientations.
  const across = 'x1="0" y1="0" x2="1" y2="0"';
  return '<defs>'
    // Brushed-metal band: bright top, mid-grey flanks, a lift near the bottom.
    + `<linearGradient id="m" ${lit}><stop offset="0" stop-color="#cfd1d5"/><stop offset=".2" stop-color="#aeb0b4"/><stop offset=".6" stop-color="#9c9ea3"/><stop offset=".9" stop-color="#8c8e93"/><stop offset="1" stop-color="#b3b5b9"/></linearGradient>`
    // Chamfer on the outer edge: a bright catch-light on top, darker below.
    + `<linearGradient id="c" ${lit}><stop offset="0" stop-color="#fafafb"/><stop offset=".5" stop-color="#c9cbcf"/><stop offset="1" stop-color="#6d6f74"/></linearGradient>`
    // Black glass around the screen, a touch lighter at the top.
    + `<linearGradient id="g" ${lit}><stop offset="0" stop-color="#1a1b1e"/><stop offset=".3" stop-color="#0b0b0d"/><stop offset="1" stop-color="#050506"/></linearGradient>`
    // Specular sheen across the glass, from the top-left as shown.
    + `<linearGradient id="s" ${turned ? 'x1="1" y1="0" x2=".5" y2=".6"' : 'x1="0" y1="0" x2=".6" y2=".5"'}><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".45" stop-color="#fff" stop-opacity=".03"/><stop offset=".46" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    // Raised buttons: lit face, shaded sides.
    + `<linearGradient id="b" ${across}><stop offset="0" stop-color="#7c7e83"/><stop offset=".45" stop-color="#e2e3e6"/><stop offset="1" stop-color="#8a8c91"/></linearGradient>`
    // Camera lens: deep blue-black glass.
    + '<radialGradient id="l" cx=".4" cy=".4" r=".7"><stop offset="0" stop-color="#3a4a6e"/><stop offset=".5" stop-color="#121826"/><stop offset="1" stop-color="#020203"/></radialGradient>'
    // Hinge groove: dark in the middle, metal at its edges.
    + `<linearGradient id="h" ${across}><stop offset="0" stop-color="#8d8f94"/><stop offset=".3" stop-color="#3b3c40"/><stop offset=".5" stop-color="#1a1a1c"/><stop offset=".7" stop-color="#3b3c40"/><stop offset="1" stop-color="#9fa1a6"/></linearGradient>`
    + '</defs>';
}

/** Width of the metal band around the edge, in screen units (short side 1000). */
const RIM = 16;

/** A camera lens: dark ring, glass, and a small catch-light. */
function lens(cx: number, cy: number, r: number): string {
  return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="#050506" stroke="#2b2c30" stroke-width="${fmt(r * 0.22)}"/>`
    + `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 0.6)}" fill="url(#l)"/>`
    + `<circle cx="${fmt(cx - r * 0.22)}" cy="${fmt(cy - r * 0.22)}" r="${fmt(r * 0.16)}" fill="#fff" fill-opacity=".55"/>`;
}

const GEOMETRY: Record<Exclude<FrameKind, 'photo' | 'photo-landscape'>, Geometry> = {
  'phone': { top: 70, bottom: 70, left: 40, right: 40, bodyRadius: 150, screenRadius: 105 },
  'compact': { top: 230, bottom: 230, left: 45, right: 45, bodyRadius: 140, screenRadius: 0 },
  'tablet': { top: 45, bottom: 45, left: 45, right: 45, bodyRadius: 80, screenRadius: 40 },
  'foldable-outer': { top: 60, bottom: 60, left: 60, right: 35, bodyRadius: 110, screenRadius: 70 },
  'foldable-inner': { top: 45, bottom: 45, left: 35, right: 35, bodyRadius: 70, screenRadius: 35 },
};
/** Room left of and right of the body for the side buttons, in the same units. */
const BUTTON_ROOM = 12;

const svgCache = new Map<string, DeviceFrame>();

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return `M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}z`;
  return `M${fmt(x + rr)} ${fmt(y)}h${fmt(w - 2 * rr)}a${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(rr)} ${fmt(rr)}`
    + `v${fmt(h - 2 * rr)}a${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(-rr)} ${fmt(rr)}`
    + `h${fmt(-(w - 2 * rr))}a${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(-rr)} ${fmt(-rr)}`
    + `v${fmt(-(h - 2 * rr))}a${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(rr)} ${fmt(-rr)}z`;
}

function svgUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * An SVG frame (and its mask) around a screen of exactly `aspect`
 * (width÷height). Phones and folded foldables are drawn upright and turned
 * counter-clockwise when the screen is landscape, like the photographs.
 * Tablets and unfolded foldables are used either way up, so they are drawn at
 * the screen's own orientation with the camera on the top edge.
 */
export function svgFrame(kind: Exclude<FrameKind, 'photo' | 'photo-landscape'>, platform: DevicePlatform, aspect: number): DeviceFrame {
  // Three decimals is far below a visible difference, and keeps the cache small.
  const a = Number(aspect.toFixed(3));
  const key = `${kind}|${platform}|${a}`;
  const cached = svgCache.get(key);
  if (cached) return cached;

  const turns = kind === 'phone' || kind === 'compact' || kind === 'foldable-outer';
  const turned = turns && a > 1;
  // The drawing's own (upright) screen size, short side 1000.
  const uprightAspect = turned ? 1 / a : a;
  const sw = uprightAspect <= 1 ? 1000 : 1000 * uprightAspect;
  const sh = uprightAspect <= 1 ? 1000 / uprightAspect : 1000;
  const g = GEOMETRY[kind];
  const buttons = turns; // phones carry side buttons; tablets and unfolded screens keep a clean outline
  const pad = buttons ? BUTTON_ROOM : 0;
  const bodyW = g.left + sw + g.right;
  const bodyH = g.top + sh + g.bottom;
  const w = bodyW + 2 * pad;
  const h = bodyH;
  const sx = pad + g.left;
  const sy = g.top;

  const parts: string[] = [defs(turned)];
  // Side buttons (behind the body, poking out on the right; volume on the left for iOS).
  if (buttons) {
    const btn = (x: number, y: number, len: number) =>
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(pad + 8)}" height="${fmt(len)}" rx="5" fill="url(#b)" stroke="#5f6166" stroke-width="1.5"/>`;
    parts.push(btn(w - pad - 8, sy + sh * 0.2, sh * 0.09));
    if (platform === 'ios') {
      parts.push(btn(0, sy + sh * 0.16, sh * 0.05), btn(0, sy + sh * 0.23, sh * 0.05));
    } else {
      parts.push(btn(w - pad - 8, sy + sh * 0.32, sh * 0.12));
    }
  }
  const screenPath = roundRect(sx, sy, sw, sh, g.screenRadius);
  // The metal band (with a chamfer catching the light on its outer edge).
  parts.push(`<path fill-rule="evenodd" fill="url(#m)" stroke="url(#c)" stroke-width="3" d="${roundRect(pad + 1.5, 1.5, bodyW - 3, bodyH - 3, g.bodyRadius)}${screenPath}"/>`);
  // The black glass face inside it, with the screen cut out, a dark inner
  // edge where it meets the metal, and a soft sheen from the top-left.
  const face = roundRect(pad + RIM, RIM, bodyW - 2 * RIM, bodyH - 2 * RIM, g.bodyRadius - RIM) + screenPath;
  parts.push(`<path fill-rule="evenodd" fill="url(#g)" stroke="#000" stroke-width="2.5" d="${face}"/>`);
  parts.push(`<path fill-rule="evenodd" fill="url(#s)" d="${face}"/>`);
  // A thin shadow ring just outside the screen (never over it: the frame is drawn above the content).
  const ring = 4;
  parts.push(`<path fill-rule="evenodd" fill="#000" fill-opacity=".7" d="${roundRect(sx - ring, sy - ring, sw + 2 * ring, sh + 2 * ring, g.screenRadius ? g.screenRadius + ring : 0)}${screenPath}"/>`);
  // A hinge groove across the band and glass, `width` wide, centred on x = `at`, from y0 to y1.
  const groove = (at: number, width: number, y0: number, y1: number) =>
    `<rect x="${fmt(at - width / 2)}" y="${fmt(y0)}" width="${fmt(width)}" height="${fmt(y1 - y0)}" rx="${fmt(width / 2)}" fill="url(#h)"/>`;
  const cx = pad + bodyW / 2;
  // Middle of the top bezel's glass, below the metal band.
  const topMid = RIM + (g.top - RIM) / 2;
  switch (kind) {
    case 'phone':
      if (platform === 'ios') {
        parts.push(`<rect x="${fmt(cx - 90)}" y="${fmt(topMid - 16)}" width="180" height="32" rx="16" fill="#000"/>`);
        parts.push(lens(cx + 60, topMid, 10));
      } else {
        parts.push(lens(cx, topMid, 15));
      }
      break;
    case 'compact':
      parts.push(`<rect x="${fmt(cx - 80)}" y="${fmt(topMid - 8)}" width="160" height="16" rx="8" fill="#1d1e21" stroke="#34353a" stroke-width="2"/>`);
      parts.push(lens(cx - 150, topMid, 13));
      if (platform === 'ios') {
        const hy = sy + sh + g.bottom / 2;
        parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(hy)}" r="75" fill="#0c0c0e" stroke="url(#c)" stroke-width="4" stroke-opacity=".55"/>`);
      }
      break;
    case 'tablet':
      parts.push(lens(cx, topMid, 10));
      break;
    case 'foldable-outer':
      // The hinge spine down the left edge; camera centred in the top bezel.
      parts.push(groove(pad + 20, 18, g.bodyRadius * 0.6, bodyH - g.bodyRadius * 0.6));
      parts.push(lens(sx + sw / 2, topMid, 13));
      break;
    case 'foldable-inner':
      // The fold runs down the middle: grooves across the top and bottom bezels.
      parts.push(groove(cx, 10, 2, g.top - 4), groove(cx, 10, sy + sh + 4, bodyH - 2));
      parts.push(lens(sx + sw * 0.78, topMid, 10));
      break;
  }

  // Turned frames: draw upright, then turn counter-clockwise into a (h × w) box.
  const vbW = turned ? h : w;
  const vbH = turned ? w : h;
  const wrap = (body: string) => {
    const inner = turned ? `<g transform="translate(0 ${fmt(w)}) rotate(-90)">${body}</g>` : body;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(vbW)} ${fmt(vbH)}" preserveAspectRatio="none">${inner}</svg>`;
  };
  const uprightScreen: ScreenRect = { leftPct: sx / w, topPct: sy / h, widthPct: sw / w, heightPct: sh / h };
  const screen = turned ? turnCcw(uprightScreen) : uprightScreen;
  const frameAspect = vbW / vbH;
  const frame: DeviceFrame = {
    src: svgUri(wrap(parts.join(''))),
    mask: svgUri(wrap(`<path fill="#fff" d="${roundRect(sx, sy, sw, sh, g.screenRadius)}"/>`)),
    frameAspect,
    screen,
    screenAspect: rectAspect(screen, frameAspect),
    kind,
  };
  svgCache.set(key, frame);
  return frame;
}

// ─── Styles ───

/** Inline style positioning the content wrapper over the frame's screen window. */
export function screenWindowStyle(frame: DeviceFrame): Record<string, string> {
  const { screen } = frame;
  return {
    left: `${(screen.leftPct * 100).toFixed(3)}%`,
    top: `${(screen.topPct * 100).toFixed(3)}%`,
    width: `${(screen.widthPct * 100).toFixed(3)}%`,
    height: `${(screen.heightPct * 100).toFixed(3)}%`,
  };
}

/** Inline style for the full-frame masked layer (clips content to the opening). */
export function screenMaskStyle(frame: DeviceFrame): Record<string, string> {
  return { '--dm-mask': `url("${frame.mask}")` };
}

/** Class for the frame image: turned frames rotate a portrait image into the landscape box. */
export function frameImageClass(frame: DeviceFrame): string {
  return frame.turn === 'ccw' ? 'dm-frame-png dm-frame-png-ccw' : 'dm-frame-png';
}
