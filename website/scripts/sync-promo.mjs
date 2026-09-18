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

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'

const REPO = 'tapsmith/tapsmith'
const URL = `https://github.com/${REPO}/releases/download/promo-video/promo.mp4`
const OUT = join(resolve(import.meta.dirname, '..', 'public'), 'promo.mp4')

// The page references the video as /promo.mp4?v=<hash of the file>, so a new
// cut gets a URL no browser or CDN has cached (the asset is served with a
// four-hour max-age). Written for every outcome so the page can always import it.
const VERSION_FILE = join(resolve(import.meta.dirname, '..', 'src'), 'promo-version.json')
function writeVersion() {
  const v =
    existsSync(OUT) && statSync(OUT).size > 0
      ? createHash('md5').update(readFileSync(OUT)).digest('hex').slice(0, 10)
      : null
  writeFileSync(VERSION_FILE, JSON.stringify({ v }) + '\n')
  if (v) console.log(`[sync-promo] promo.mp4 version ${v}.`)
}

// A previous download (or local render) is good enough for dev builds; CI
// always starts from a clean checkout so deploys pick up the latest asset.
if (existsSync(OUT) && statSync(OUT).size > 0) {
  console.log('[sync-promo] public/promo.mp4 already present, skipping fetch.')
  writeVersion()
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
writeVersion()
