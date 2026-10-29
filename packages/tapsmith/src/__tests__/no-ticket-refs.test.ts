/**
 * Internal tracker keys (`PILOT-123`) mean nothing to users, so none may reach
 * what they read: the published type declarations (an editor shows their JSDoc
 * on hover) and the public docs, website and READMEs. Source comments that do
 * not ship (plain `//` comments, tests) may keep them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';
import { REPO } from './doc-samples.js';

const TICKET_REF = /\bPILOT-\d+\b/g;

/** `file:line: text` for every ticket ref in `files` (paths relative to `root`). */
function refsIn(root: string, files: string[]): string[] {
  return files.flatMap((rel) => fs.readFileSync(path.join(root, rel), 'utf8').split('\n').flatMap((line, i) =>
    line.match(TICKET_REF) ? [`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`] : []));
}

const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');

// The unit-test CI job builds dist first (tsc only); locally, run `npx tsc -p
// tsconfig.build.json` (or `npm run build`) to check it.
describe.skipIf(!fs.existsSync(path.join(DIST, 'index.d.ts')) && !process.env.CI)('published type declarations', () => {
  it('carry no internal ticket refs', () => {
    const files = glob.sync('**/*.d.ts', { cwd: DIST, nodir: true }).sort();
    expect(files.length).toBeGreaterThan(50);
    expect(refsIn(DIST, files)).toEqual([]);
  });
});

describe('public docs', () => {
  it('carry no internal ticket refs', () => {
    const files = glob.sync(
      ['docs/**/*.md', 'README.md', 'packages/*/README.md', 'website/src/**/*.{astro,md,mdx,ts,css}', 'website/astro.config.mjs'],
      { cwd: REPO, nodir: true, ignore: ['**/node_modules/**', 'website/src/content/docs/**'] },
    ).sort();
    expect(files).toContain('docs/getting-started.md');
    expect(files).toContain('website/src/pages/index.astro');
    expect(refsIn(REPO, files)).toEqual([]);
  });
});
