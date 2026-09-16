#!/usr/bin/env node

// Generates the Changelog page (src/content/docs/changelog.md) from the repo's
// published GitHub Releases at build time. Must run AFTER sync-docs.mjs, which
// wipes and recreates src/content/docs.
//
// Release bodies are already markdown (the auto-generated notes from
// `gh release create --generate-notes`, grouped per .github/release.yml). We
// demote their headings one level so each version sits under a `##` heading.
//
// Network/API failures never break the build: we fall back to a placeholder so
// the page (and its sidebar link) always exist. Set GITHUB_TOKEN to avoid the
// low unauthenticated API rate limit.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Matches the GitHub link in astro.config.mjs.
const REPO = 'tapsmith/tapsmith'
const OUT_DIR = resolve(import.meta.dirname, '..', 'src', 'content', 'docs')
const OUT_FILE = join(OUT_DIR, 'changelog.md')

const FRONTMATTER = `---
title: "Changelog"
description: "Release notes for every published version of Tapsmith."
---

`

function write(body) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, FRONTMATTER + body)
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // timeZone: UTC keeps the rendered date identical regardless of where the
  // build runs (local dev vs. CI).
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

// Escape raw HTML in release notes so a PR title/body containing markup can't
// reach the public changelog unsanitized (Starlight renders raw HTML from
// markdown). Only < and > are escaped — enough to neutralise tags without
// touching markdown syntax or URL query strings (&) — and inline code spans and
// fenced code blocks are left intact.
function escapeHtml(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtmlPreservingCode(md) {
  let inFence = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      // Odd-indexed segments are inline code spans (`...`); leave them as-is.
      return line
        .split(/(`[^`]*`)/)
        .map((seg, i) => (i % 2 === 1 ? seg : escapeHtml(seg)))
        .join('')
    })
    .join('\n')
}

// Tidy GitHub's auto-generated notes into a flat bullet list for the docs page.
// This project doesn't label PRs, so category headings are just noise — we drop
// every section heading and render each release as a plain list of its PRs:
//   - drop the HTML comment GitHub prepends when .github/release.yml is present
//   - drop all section headings (What's Changed / categories / New Contributors)
//   - drop version-bump PRs ("Bump version to X.Y.Z")
//   - drop "first contribution" credits (they duplicate PRs already listed)
//   - strip the "by @user in <pr-url>" attribution from each item
function cleanBody(md) {
  const kept = md
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^#{1,6}\s/.test(line))
    .filter((line) => !/^\s*[*-]\s+bump version\b/i.test(line))
    .filter((line) => !/made their first contribution/i.test(line))
    .map((line) => line.replace(/\s+by @[\w-]+ in https?:\/\/\S+\s*$/i, ''))
  return escapeHtmlPreservingCode(kept.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderRelease(r) {
  const heading = `## [${escapeHtml(r.name || r.tag_name)}](${r.html_url})`
  const date = formatDate(r.published_at)
  const meta = date ? `\n\n_Released ${date}${r.prerelease ? ' · pre-release' : ''}_` : ''
  const body = cleanBody((r.body || '').trim())
  const notes = body ? `\n\n${body}` : '\n\n_No notes for this release._'
  return `${heading}${meta}${notes}`
}

async function main() {
  const headers = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  let releases
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers,
      // Bound the request so a hung API response aborts into the catch below
      // (a placeholder page) instead of stalling the whole build.
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`)
    releases = await res.json()
  } catch (err) {
    console.warn(`[sync-releases] Could not fetch releases (${err.message}). Writing placeholder.`)
    write('Release notes will appear here once the first version is published.\n')
    return
  }

  // `promo-video` is a rolling asset-hosting release (see sync-promo.mjs), not a version.
  const published = (Array.isArray(releases) ? releases : []).filter(
    (r) => !r.draft && r.tag_name !== 'promo-video',
  )
  if (published.length === 0) {
    write('Release notes will appear here once the first version is published.\n')
    console.log('[sync-releases] No published releases yet; wrote placeholder.')
    return
  }

  const intro =
    'Release notes for Tapsmith, generated from ' +
    `[GitHub Releases](https://github.com/${REPO}/releases).\n\n`
  write(intro + published.map(renderRelease).join('\n\n') + '\n')
  console.log(`[sync-releases] Wrote ${published.length} release(s) to changelog.md`)
}

main()
