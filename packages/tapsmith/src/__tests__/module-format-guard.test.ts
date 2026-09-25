import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleFormatError } from '../module-format-guard.js';

describe('moduleFormatError', () => {
  it('accepts a module that has import.meta.dirname', () => {
    expect(moduleFormatError('/app/node_modules/tapsmith/dist')).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['not a string', 42],
  ])('explains the cause and the fix when import.meta.dirname is %s', (_label, url) => {
    const message = moduleFormatError(url);
    expect(message).toMatch(/loaded without `import\.meta\.dirname`/);
    expect(message).toMatch(/tsx .*4\.23/);
    expect(message).toContain('npx tapsmith test');
    expect(message).toContain('"type": "module"');
  });
});

// The wiring: the check has to run before any other SDK module reads
// import.meta at load time (grpc-client.js resolves its proto path on import),
// or the user sees that module's `paths[0]` TypeError instead. A load hook
// blanks import.meta.dirname/filename in the built SDK the way an older
// CommonJS transform does (tsx 4.21 fills in only import.meta.url), then
// imports the package entry point. (Code only: the lookbehind spares the
// backticked mention inside the guard's own message.)
const DIST_INDEX = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

// `registerHooks` arrived in Node 22.15; the package supports all of 22.
const HAS_REGISTER_HOOKS = typeof (Module as { registerHooks?: unknown }).registerHooks === 'function';

describe.skipIf((!fs.existsSync(DIST_INDEX) && !process.env.CI) || !HAS_REGISTER_HOOKS)('the built SDK loaded without import.meta.dirname', () => {
  it('fails with the explanation, not a TypeError from whichever module needed it first', () => {
    const distUrl = pathToFileURL(path.dirname(DIST_INDEX)).href;
    const script = 'import { registerHooks } from "node:module";\n'
      + 'registerHooks({ load(url, context, next) {\n'
      + '  const result = next(url, context);\n'
      + `  if (!url.startsWith(${JSON.stringify(distUrl)}) || !url.endsWith(".js")) return result;\n`
      + '  return { ...result, source: String(result.source).replace(/(?<!`)import\\.meta\\.(dirname|filename)/g, "undefined") };\n'
      + '} });\n'
      + `try { await import(${JSON.stringify(pathToFileURL(DIST_INDEX).href)}); console.log("loaded"); }\n`
      + 'catch (err) { console.log(err.message); }\n';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, TAPSMITH_TELEMETRY: '0' },
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('paths[0]');
    expect(result.stdout).toMatch(/loaded without `import\.meta\.dirname`/);
  });
});
