#!/usr/bin/env node
/**
 * rotate-bezels.mjs — derive the landscape screen-opening masks from the
 * portrait ones that scripts/fetch-bezels.mjs extracted from bezel.fit.
 *
 * A landscape phone uses its portrait photographic frame turned 90°
 * counter-clockwise (the camera on the left, as a phone turned to the left
 * shows it). The frame PNG itself is turned in CSS (`.dm-frame-png-ccw`), so
 * no second copy of it is inlined into the single-file builds. A CSS
 * `mask-image` cannot be turned, though, so the masks (a few KB each) are
 * rotated here, once, and committed beside the portrait ones. The landscape
 * screen rect is derived from the portrait one in frames.ts (`turnCcw`).
 *
 * Same source and licence as the portrait assets (see frames.ts).
 *
 * Requirements: ImageMagick (`magick`) on PATH.
 * Usage: node scripts/rotate-bezels.mjs
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui-mode', 'assets', 'bezels');

for (const name of ['iphone', 'android']) {
  const src = join(DIR, `${name}-mask.png`);
  const out = join(DIR, `${name}-mask-landscape.png`);
  // -rotate -90 turns counter-clockwise: the portrait top edge becomes the left.
  execFileSync('magick', [src, '-rotate', '-90', '-strip', '-define', 'png:compression-level=9', out]);
  console.log(`${name}-mask.png → ${name}-mask-landscape.png`);
}
