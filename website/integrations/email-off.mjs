// Keeps Cloudflare's Email Address Obfuscation away from the site's pages.
//
// Cloudflare rewrites anything that looks like an email address in the HTML it
// serves into a "[email protected]" link that only its JavaScript decodes. The
// site has no real addresses to protect, only code samples such as
// `type("user@example.com")`, and anything that reads the page without running
// that script (an AI agent, curl, reader mode) saw the placeholder instead of
// the sample. Cloudflare skips whatever sits between `<!--email_off-->` and
// `<!--/email_off-->`, so after the build every page's body is wrapped in them.
// This works whatever the zone's setting is.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OPEN = '<!--email_off-->'
const CLOSE = '<!--/email_off-->'

/** `html` with its body's content wrapped in Cloudflare's email_off markers. */
function wrapBodyEmailOff(html) {
  if (html.includes(OPEN)) return html
  const open = /<body\b[^>]*>/i.exec(html)
  const close = html.toLowerCase().lastIndexOf('</body>')
  if (!open || close < open.index) return html
  const start = open.index + open[0].length
  return html.slice(0, start) + OPEN + html.slice(start, close) + CLOSE + html.slice(close)
}

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => join(e.parentPath, e.name))
}

/** @returns {import('astro').AstroIntegration} */
export default function emailOff() {
  return {
    name: 'email-off',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const files = await htmlFiles(fileURLToPath(dir))
        let wrapped = 0
        for (const file of files) {
          const html = await readFile(file, 'utf8')
          const out = wrapBodyEmailOff(html)
          if (out !== html) {
            await writeFile(file, out)
            wrapped++
          }
        }
        logger.info(`Wrapped ${wrapped} of ${files.length} page(s) in email_off markers`)
      },
    },
  }
}
