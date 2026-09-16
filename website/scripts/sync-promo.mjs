#!/usr/bin/env node

// Fetches the promo video into public/ at build time. The video is a build
// artifact of tools/promo (11MB+ per version), so it lives as an asset on the
// rolling `promo-video` GitHub release rather than in git history.
//
// To publish a new version:
//   gh release upload promo-video promo.mp4 --clobber
// then re-run the Deploy Website workflow.
//
// Failures never break the build: the page keeps its poster frame and the
// player 404s until the next successful deploy, which beats failing docs
// deploys over a marketing asset.

import { createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'

const REPO = 'tapsmith/tapsmith'
const URL = `https://github.com/${REPO}/releases/download/promo-video/promo.mp4`
const OUT = join(resolve(import.meta.dirname, '..', 'public'), 'promo.mp4')

// A previous download (or local render) is good enough for dev builds; CI
// always starts from a clean checkout so deploys pick up the latest asset.
if (existsSync(OUT) && statSync(OUT).size > 0) {
  console.log('[sync-promo] public/promo.mp4 already present, skipping fetch.')
  process.exit(0)
}

try {
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(OUT))
  console.log(`[sync-promo] Downloaded promo.mp4 (${(statSync(OUT).size / 1e6).toFixed(1)}MB).`)
} catch (err) {
  if (existsSync(OUT)) unlinkSync(OUT)
  console.warn(`[sync-promo] Could not fetch promo video (${err.message}). Building without it.`)
}
