#!/usr/bin/env node
/**
 * fetch-bezels.mjs — one-time extraction of device-frame overlay assets from
 * the bezel.fit HTTP API (https://bezel.fit).
 *
 * UI mode draws a device "bezel" around the live mirror. Instead of the
 * hand-drawn CSS bezels, the phone buckets use real photographic frames from
 * bezel.fit. bezel.fit is a compositing API (POST a screenshot → framed PNG),
 * not an asset library, so we extract a reusable *overlay* once and commit it:
 *
 *   1. POST a solid-magenta screenshot at the device's exact viewport.
 *   2. In the returned frame, the magenta region marks the screen window. Its
 *      bounding box (via ImageMagick -trim) gives the screen rect; making
 *      magenta transparent yields the overlay PNG (frame with a see-through
 *      screen). One request per device covers both.
 *   3. Downscale + compress (the mirror renders small) and write to
 *      src/ui-mode/assets/bezels/.
 *
 * The committed assets mean the API is NEVER called at runtime. Re-run this
 * script only to regenerate frames; then paste the printed metadata into
 * src/ui-mode/assets/bezels/frames.ts.
 *
 * Licence: bezel.fit's terms (https://bezel.fit/terms, last updated
 * 2026-05-07, checked 2026-11-17) say "You keep all rights to the screenshots
 * you upload and to the framed PNGs the API returns" and that the service is
 * "free for personal and commercial use"; the frames "depict third-party
 * hardware", and using them within each manufacturer's trademark guidelines
 * is the user's responsibility. No attribution is required. Re-check the
 * terms before regenerating. (Also recorded in frames.ts.)
 *
 * Requirements: ImageMagick (`magick`) on PATH. Node 18+ (global fetch).
 * Usage: node scripts/fetch-bezels.mjs
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://bezel.fit';
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, '..', 'src', 'ui-mode', 'assets', 'bezels');

/** Phone buckets only — bezel.fit has no tablet frames (tablets fall back to CSS).
 * maskCornerPct: screen-opening corner radius as a fraction of the screen width,
 * used to trim the magenta probe's square-corner artifact from the mask while
 * preserving the true rounded opening (iPhone corners are rounder than Pixel). */
const TARGETS = [
  { bucket: 'ios-phone', device: 'iphone-17-pro', file: 'iphone.png', maskCornerPct: 0.136 },
  { bucket: 'android-phone', device: 'pixel-10-pro', file: 'android.png', maskCornerPct: 0.086 },
];

/** Downscaled overlay width (px). The mirror is displayed small; keep assets light. */
const TARGET_WIDTH = 640;
/** Fuzz tolerance for isolating the (anti-aliased) magenta screen region. */
const FUZZ = '18%';
const MAGENTA = '#ff00ff';

const magick = (args) => execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDevices() {
  const res = await fetch(`${API}/v1/devices`);
  if (!res.ok) throw new Error(`GET /v1/devices → ${res.status}`);
  return (await res.json()).devices;
}

async function frame(device, pngPath) {
  const body = readFileSync(pngPath);
  const res = await fetch(`${API}/v1/devices/${device}/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body,
  });
  if (!res.ok) {
    throw new Error(`POST /v1/devices/${device}/frame → ${res.status}: ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Bounding box "WxH+X+Y" of the magenta screen region within the framed PNG. */
function measureScreenRect(framedPath, work) {
  const mask = join(work, 'mask.png');
  // Binary mask: magenta → white, everything else → black. Match magenta with a
  // little fuzz (anti-aliased screen edge) but separate non-white at fuzz 0 so
  // the achromatic silver/black bezel never counts as screen.
  magick([framedPath, '-fuzz', FUZZ, '-fill', 'white', '-opaque', MAGENTA, '-fuzz', '0%', '-fill', 'black', '+opaque', 'white', mask]);
  // The screen is the largest white blob. Connected-components ignores the
  // stray anti-aliasing specks at the frame edges that defeat a plain -trim.
  const cc = execSync(
    `magick ${JSON.stringify(mask)} -define connected-components:verbose=true ` +
      `-define connected-components:area-threshold=50000 -connected-components 8 null: 2>&1`,
    { encoding: 'utf8' },
  );
  let best = null;
  for (const line of cc.split('\n')) {
    // "  81: 1280x2856+59+60 698.5,1487.5 3.6e+06 gray(255)"
    const m = /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+[\d.,]+\s+([\d.e+]+)\s+gray\(255\)/.exec(line);
    if (!m) continue;
    const rect = { w: +m[1], h: +m[2], x: +m[3], y: +m[4], area: +m[5] };
    if (!best || rect.area > best.area) best = rect;
  }
  if (!best) throw new Error(`no magenta screen region found:\n${cc}`);
  return best;
}

function round(n, d = 4) {
  return Number(n.toFixed(d));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'bezels-'));
  const devices = await fetchDevices();
  const meta = {};

  for (const [i, target] of TARGETS.entries()) {
    const dev = devices.find((d) => d.id === target.device);
    if (!dev) throw new Error(`device ${target.device} not in /v1/devices`);
    const { w: vw, h: vh } = dev.viewport;
    const { w: fw, h: fh } = dev.frame.size;
    console.log(`\n[${target.bucket}] ${dev.name} — viewport ${vw}×${vh}, frame ${fw}×${fh}`);

    // 1. Solid-magenta screenshot at the exact viewport (8-bit RGBA, no palette).
    const probe = join(work, `${target.device}-magenta.png`);
    magick(['-size', `${vw}x${vh}`, `xc:${MAGENTA}`, '-depth', '8', `PNG32:${probe}`]);

    // 2. Frame it.
    const framedBuf = await frame(target.device, probe);
    const framed = join(work, `${target.device}-framed.png`);
    writeFileSync(framed, framedBuf);

    // 3. Screen rect from the magenta bbox, as fractions of the frame.
    const r = measureScreenRect(framed, work);
    meta[target.bucket] = {
      file: target.file,
      frameAspect: round(fw / fh),
      screen: {
        leftPct: round(r.x / fw),
        topPct: round(r.y / fh),
        widthPct: round(r.w / fw),
        heightPct: round(r.h / fh),
      },
    };

    // 4. Overlay asset: make the magenta screen transparent, downscale, strip.
    const out = join(OUT_DIR, target.file);
    magick([
      framed,
      '-fuzz', FUZZ, '-transparent', MAGENTA,
      '-resize', `${TARGET_WIDTH}x`,
      '-strip', '-define', 'png:compression-level=9',
      `PNG32:${out}`,
    ]);
    const size = (readFileSync(out).length / 1024).toFixed(0);
    console.log(`  screen bbox ${r.w}x${r.h}+${r.x}+${r.y}  →  ${target.file} (${size} KB)`);

    // 5. Full-frame screen-opening mask. Crop the overlay to the screen window
    //    and invert its alpha (opening → opaque, corners → transparent), then
    //    composite back onto a transparent canvas the size of the frame. The
    //    mask is applied to a layer that fills the frame — identically to the
    //    frame PNG — so the two align exactly and the content is clipped to the
    //    real (squircle) opening with no edge seam.
    const maskFile = target.file.replace(/\.png$/, '-mask.png');
    const maskOut = join(OUT_DIR, maskFile);
    const [ow, oh] = magick([out, '-format', '%wx%h', 'info:']).toString().trim().split('x').map(Number);
    const s = meta[target.bucket].screen;
    const cw = Math.round(s.widthPct * ow), ch = Math.round(s.heightPct * oh);
    const cx = Math.round(s.leftPct * ow), cy = Math.round(s.topPct * oh);
    const rad = Math.round((target.maskCornerPct ?? 0.1) * cw);
    const opening = join(work, `${target.device}-opening.png`);
    const roundrect = join(work, `${target.device}-rr.png`);
    // Opening (white on black) from the overlay's transparent screen region.
    magick([out, '-crop', `${cw}x${ch}+${cx}+${cy}`, '+repage', '-alpha', 'extract', '-threshold', '50%', '-negate', opening]);
    // Rounded rect at the opening's corner radius; intersect to drop the square
    // magenta-probe artifact at the corners while keeping the true opening.
    magick(['-size', `${cw}x${ch}`, 'xc:black', '-fill', 'white', '-draw', `roundrectangle 0,0 ${cw - 1},${ch - 1} ${rad},${rad}`, roundrect]);
    const cropMask = join(work, `${target.device}-cropmask.png`);
    magick([opening, roundrect, '-compose', 'multiply', '-composite', '-threshold', '50%', '-blur', '0x0.6', '-transparent', 'black', cropMask]);
    magick(['-size', `${ow}x${oh}`, 'xc:transparent', cropMask, '-geometry', `+${cx}+${cy}`, '-compose', 'over', '-composite', '-strip', maskOut]);
    console.log(`  mask (full ${ow}x${oh}, r=${rad})  →  ${maskFile}`);

    // Stay under the documented 3 req / 60 s rate limit.
    if (i < TARGETS.length - 1) await sleep(25_000);
  }

  console.log('\n// ─── paste into src/ui-mode/assets/bezels/frames.ts ───');
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
