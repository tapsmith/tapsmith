// The docs pages the tapsmith package ships in docs/, so a coding agent reads
// the docs of the installed version from node_modules/tapsmith/docs/ without
// web access. Each page is the repo's docs/<page>.md, the file the website is
// built from, with one change: images are not shipped (they are most of the
// docs' size), so a link to one points at the copy the website serves instead.
//
// `npm run build` runs this file; the unit tests import its helpers.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the website serves docs/images/<file> (website/scripts/sync-docs.mjs copies them to its root). */
export const IMAGE_BASE_URL = 'https://tapsmith.dev/';

/**
 * A docs page as the package ships it: inline `](images/x.png)` and
 * reference-style `]: images/x.png` links become website URLs, matching how
 * the website's sync rewrites them.
 */
export function bundledPage(markdown) {
  return markdown
    .replace(/\]\((?:\.\/)?images\//g, `](${IMAGE_BASE_URL}`)
    .replace(/\]:\s*(?:\.\/)?images\//g, `]: ${IMAGE_BASE_URL}`);
}

/** The pages to ship: every markdown file directly in `docsDir`, sorted. */
export function docPages(docsDir) {
  return fs
    .readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/** Replace `outDir` with the bundled copy of every page in `docsDir`. Returns the page names. */
export function bundleDocs(docsDir, outDir) {
  const pages = docPages(docsDir);
  if (pages.length === 0) throw new Error(`bundle-docs: no markdown pages in ${docsDir}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const page of pages) {
    fs.writeFileSync(path.join(outDir, page), bundledPage(fs.readFileSync(path.join(docsDir, page), 'utf8')));
  }
  return pages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pages = bundleDocs(path.resolve(packageDir, '../../docs'), path.join(packageDir, 'docs'));
  console.log(`bundle-docs: ${pages.length} pages written to docs/`);
}
