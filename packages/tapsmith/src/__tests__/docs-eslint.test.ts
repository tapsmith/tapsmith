/**
 * Docs guard (PILOT-776): every `eslint.config.*` sample in the docs and
 * READMEs is run as written, by real ESLint and typescript-eslint, against a
 * TypeScript test with a missing `await` and a test-id locator, in a scratch
 * CommonJS project (no `"type": "module"`, the npm default) that imports the
 * built `tapsmith` package. The sample passes only if ESLint parses the test
 * and reports both problems: a config with no `files` lints nothing in a
 * TypeScript project, and one with no parser fails on the first type
 * annotation, and neither shows up anywhere else in CI.
 *
 * It tests `dist/`, so rebuild (`npx tsc -p tsconfig.build.json`) after
 * changing the plugin. CI compiles dist/ before the unit tests; a local run
 * with no build skips them.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docFiles, fencedBlocksIn, REPO, type FencedBlock } from './doc-samples.js';

const PKG_DIR = path.resolve(import.meta.dirname, '..', '..');
const DIST_BUILT = fs.existsSync(path.join(PKG_DIR, 'dist', 'index.js'));

if (!DIST_BUILT && !process.env.CI) {
  console.warn('docs-eslint.test.ts: skipped — dist/ is not built (run `npx tsc -p tsconfig.build.json`).');
}

const JS_LANGS = new Set(['javascript', 'js', 'mjs']);

/** A sample's first line names its file: `// eslint.config.mjs`, `// eslint.config.js`, … */
const CONFIG_HEADER = /^\/\/\s*(eslint\.config\.[cm]?js)\b/;

/** The docs' ESLint config samples: JavaScript blocks headed with a config file name. */
function configSamples(): FencedBlock[] {
  return docFiles()
    .flatMap((rel) => fencedBlocksIn(rel, fs.readFileSync(path.join(REPO, rel), 'utf8')))
    .filter((block) => JS_LANGS.has(block.lang) && CONFIG_HEADER.test(block.code));
}

/** A test with one problem for typescript-eslint and one for the tapsmith plugin. */
const BAD_TEST = `import { test, expect } from "tapsmith"

test("logs in", async ({ device }) => {
  const greeting: string = "Welcome"
  expect(device.getByText(greeting)).toBeVisible()
  await device.getByTestId("submit").tap()
})
`;

interface LintResult {
  filePath: string;
  messages: Array<{ ruleId: string | null; line: number; message: string; fatal?: boolean }>;
}

describe.skipIf(!DIST_BUILT && !process.env.CI)('ESLint config samples in the docs', { timeout: 60_000 }, () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('has a built dist/ to test', () => {
    expect(DIST_BUILT, 'dist/index.js is missing — run `npx tsc -p tsconfig.build.json` before these tests').toBe(true);
  });

  const samples = configSamples();

  it('finds the setup sample in the Locators Guide', () => {
    expect(samples.map((s) => s.file)).toContain('docs/locators.md');
  });

  it.each(samples.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s reports a missing await and a test-id locator in a TypeScript test',
    (_where, sample) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-eslint-')));
      root = dir;
      fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "app", "private": true }\n');
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true },
      }));
      // Under the name the sample gives, so a `.js` sample loads as CommonJS.
      fs.writeFileSync(path.join(dir, CONFIG_HEADER.exec(sample.code)![1]!), sample.code);
      fs.mkdirSync(path.join(dir, 'tests'));
      fs.writeFileSync(path.join(dir, 'tests', 'login.tapsmith.ts'), BAD_TEST);
      // What `npm install --save-dev eslint typescript-eslint` and an installed
      // tapsmith give the project: links to this package and its own copies.
      const modules = path.join(dir, 'node_modules');
      fs.mkdirSync(modules);
      fs.symlinkSync(PKG_DIR, path.join(modules, 'tapsmith'), 'dir');
      for (const dep of ['eslint', 'typescript-eslint', 'typescript']) {
        fs.symlinkSync(path.join(PKG_DIR, 'node_modules', dep), path.join(modules, dep), 'dir');
      }

      const run = spawnSync(
        process.execPath,
        [path.join(modules, 'eslint', 'bin', 'eslint.js'), '--format', 'json', 'tests/'],
        { cwd: dir, encoding: 'utf8' },
      );
      // ESLint exits 1 when it reports an error (the missing await) and 2 when
      // the config itself fails to load.
      expect(run.status, `eslint exited ${run.status}:\n${run.stderr}${run.stdout}`).toBe(1);
      const results = JSON.parse(run.stdout) as LintResult[];
      expect(results.map((r) => path.relative(dir, r.filePath))).toEqual([path.join('tests', 'login.tapsmith.ts')]);
      const messages = results[0]!.messages;
      expect(messages.filter((m) => m.fatal), JSON.stringify(messages)).toEqual([]);
      expect(messages.map((m) => [m.ruleId, m.line])).toEqual([
        ['@typescript-eslint/no-floating-promises', 5],
        ['tapsmith/prefer-accessible-locators', 6],
      ]);
    },
  );
});
