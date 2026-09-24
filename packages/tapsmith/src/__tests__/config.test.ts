import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `defineConfig` merges DEFAULT_CONFIG, whose `rootDir` is the *loading*
// process's cwd, so `raw.rootDir ?? root` always kept cwd and silently
// overrode the root the caller asked for — an MCP server started in a repo
// root swept the whole repo through a config describing one subdirectory.
// The root must follow the caller's argument; re-anchoring to the config
// file's own directory instead would break `tapsmith test -c sub/config.ts`,
// which has always discovered tests relative to the working directory.
describe('loadConfig rootDir anchoring', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-root-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(dir: string, body: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'tapsmith.config.mjs');
    fs.writeFileSync(file, body, 'utf-8');
    return file;
  }

  it('uses the directory it was asked to load from', async () => {
    const projectDir = path.join(root, 'e2e');
    writeConfig(projectDir, 'export default { platform: "ios" }\n');
    expect((await loadConfig(projectDir)).rootDir).toBe(projectDir);
  });

  it("keeps the caller's directory for `-c <subdir>/config` (regression guard)", async () => {
    // `tapsmith test -c configs/ci.config.ts` from the repo root must keep
    // discovering tests relative to the repo root, not to configs/.
    const projectDir = path.join(root, 'configs');
    const file = writeConfig(projectDir, 'export default { platform: "ios" }\n');
    expect((await loadConfig(root, path.relative(root, file))).rootDir).toBe(root);
  });

  it('does not mistake defineConfig\'s default rootDir for a user-pinned one', async () => {
    const projectDir = path.join(root, 'e2e');
    // What defineConfig produces: a concrete rootDir from the *loading*
    // process's cwd, plus the symbol saying the author did not ask for it.
    // Stamped by hand rather than imported — a config in an OS temp dir cannot
    // resolve the bare specifier "tapsmith", so `import { defineConfig } from
    // "tapsmith"` throws ERR_MODULE_NOT_FOUND, loadConfig swallows it and
    // returns defaults, and the assertion below would pass without ever
    // reaching the symbol branch this test exists to cover.
    writeConfig(
      projectDir,
      'const config = { platform: "ios", rootDir: process.cwd() }\n'
      + 'Object.defineProperty(config, Symbol.for("tapsmith.explicitRootDir"), '
      + '{ value: false, enumerable: false })\n'
      + 'export default config\n',
    );
    const loaded = await loadConfig(projectDir);
    // Proves the file was read: falling back to defaults would leave this unset
    // and make the rootDir assertion pass for the wrong reason.
    expect(loaded.platform).toBe('ios');
    expect(loaded.rootDir).toBe(projectDir);
  });

  it('keeps a rootDir the config itself pins, resolved against the root', async () => {
    const projectDir = path.join(root, 'e2e');
    writeConfig(projectDir, 'export default { rootDir: "../suites" }\n');
    expect((await loadConfig(projectDir)).rootDir).toBe(path.join(root, 'suites'));
  });

  it('falls back to the given directory when no config file exists', async () => {
    expect((await loadConfig(root)).rootDir).toBe(root);
  });

  // A config loaded here has a concrete rootDir but, without the symbol, no
  // record of whether the file pinned it. Re-resolving such an object would
  // fall back to "rootDir is set" and re-pin the previous caller's root — the
  // ambiguity the symbol exists to remove. Every result carries it.
  it('records whether the file pinned rootDir, not merely that one is set', async () => {
    const pinned = path.join(root, 'pinned');
    writeConfig(pinned, 'export default { rootDir: "../suites" }\n');
    const inherited = path.join(root, 'inherited');
    writeConfig(inherited, 'export default { platform: "ios" }\n');

    const explicit = (config: object): unknown =>
      (config as Record<symbol, unknown>)[EXPLICIT_ROOT_DIR];

    expect(explicit(await loadConfig(pinned))).toBe(true);
    expect(explicit(await loadConfig(inherited))).toBe(false);
    expect(explicit(await loadConfig(root))).toBe(false);
  });

  // `loadConfig` returns the merged config and nothing about where it came
  // from, so UI mode reported "Config: none — using built-in defaults" over
  // MCP even when launched with `-c`. Naming the file is the whole point of
  // that line, so it has to be resolved the same way loadConfig resolves it.
  describe('configPathOf', () => {
    it('names the explicitly requested config file', async () => {
      const file = writeConfig(path.join(root, 'configs'), 'export default {}\n');
      expect(configPathOf(await loadConfig(root, path.relative(root, file)))).toBe(file);
    });

    it('names the config it discovers in the directory', async () => {
      const file = writeConfig(root, 'export default {}\n');
      expect(configPathOf(await loadConfig(root))).toBe(file);
    });

    it('reports no config when there is none to read', async () => {
      expect(configPathOf(await loadConfig(root))).toBeUndefined();
    });

  });

  // A config that exists but cannot be imported used to be warned about and
  // replaced by the defaults, so `tapsmith test` ran with the default
  // testMatch, no app and no device pin, and failed later in ways that never
  // mentioned the config (PILOT-262). Defaults are only for "no config file".
  describe('a config file that exists but cannot be loaded', () => {
    it('rejects a discovered config that throws on import, naming the file and the error', async () => {
      const file = writeConfig(root, 'throw new Error("boom")\n');
      await expect(loadConfig(root)).rejects.toThrow(
        `Failed to load config file ${file}: boom`,
      );
    });

    it('keeps the import error as the cause, and its trace in the stack', async () => {
      // The CLI prints `stack`, never `cause`; the config's line must be in it.
      const file = writeConfig(root, 'function explode() { throw new Error("boom"); }\nexplode();\n');
      const err = await loadConfig(root).catch((e: unknown) => e);
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect(((err as Error).cause as Error).message).toBe('boom');
      expect((err as Error).stack).toContain('Caused by: Error: boom');
      expect((err as Error).stack).toContain(`${path.basename(file)}:1`);
    });

    it('rejects a discovered config whose own import cannot be resolved', async () => {
      const file = writeConfig(root, 'import "./does-not-exist.mjs"\nexport default {}\n');
      await expect(loadConfig(root)).rejects.toThrow(`Failed to load config file ${file}:`);
      await expect(loadConfig(root)).rejects.toThrow(/does-not-exist\.mjs/);
    });

    it('does not fall through to a lower-precedence candidate', async () => {
      // tapsmith.config.ts outranks .mjs; reading the .mjs instead would run
      // the session under a config the user is not editing.
      const broken = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(broken, 'throw new Error("boom")\n', 'utf-8');
      writeConfig(root, 'export default { platform: "ios" }\n');
      await expect(loadConfig(root)).rejects.toThrow(`Failed to load config file ${broken}: boom`);
    });

    it('rejects an explicit --config file that throws on import the same way', async () => {
      const file = writeConfig(path.join(root, 'configs'), 'throw new Error("boom")\n');
      await expect(loadConfig(root, path.relative(root, file))).rejects.toThrow(
        `Failed to load config file ${file}: boom`,
      );
    });

    it('still falls back to defaults when no config file exists', async () => {
      const config = await loadConfig(root);
      expect(configPathOf(config)).toBeUndefined();
      expect(config.rootDir).toBe(root);
    });
  });

  // The CLI loads the config before it re-execs under tsx, so a config bare
  // Node cannot import (a `.js` specifier for a `.ts` helper, an enum) must
  // still load — it used to be masked by the silent fallback, and would now
  // be a hard error. Vitest transforms dynamic imports itself, so these run
  // the source in a bare `node` child to see what the CLI's parent sees.
  describe('in a process not running under tsx', () => {
    const configModule = path.resolve(__dirname, '..', 'config.ts');

    /** Runs `body` in a bare node child with `loadConfig`, `configPathOf` and `ext` (require.extensions) in scope. */
    function inBareNode<T>(body: string): T {
      const script = `const { loadConfig, configPathOf } = await import(${JSON.stringify(configModule)});\n`
        + 'const { createRequire } = await import("node:module");\n'
        + 'const ext = createRequire(import.meta.url).extensions;\n'
        + 'const emit = (v) => process.stdout.write(JSON.stringify(v));\n'
        + body;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return JSON.parse(out) as T;
    }

    function loadInBareNode(dir: string): { path?: string; platform?: string; retries?: number } {
      return inBareNode(`const c = await loadConfig(${JSON.stringify(dir)});\n`
        + 'emit({ path: configPathOf(c), platform: c.platform, retries: c.retries });\n');
    }

    function writeHelper(dir: string): void {
      fs.writeFileSync(path.join(dir, 'helpers.ts'), 'export const platform: string = "ios";\n', 'utf-8');
    }

    function writePackage(dir: string, type: 'module' | 'commonjs'): void {
      fs.writeFileSync(path.join(dir, 'package.json'), type === 'module' ? '{ "type": "module" }\n' : '{}\n', 'utf-8');
    }

    const TS_CONFIG = 'import { platform } from "./helpers.js";\n'
      + 'enum Retries { None = 0, Some = 2 }\n'
      + 'export default { platform, retries: Retries.Some };\n';

    it('loads a TypeScript config in a package without "type": "module"', () => {
      // tsx compiles it to CommonJS here, so this also covers unwrapping the
      // `__esModule` default.
      writePackage(root, 'commonjs');
      writeHelper(root);
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, TS_CONFIG, 'utf-8');
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    it('loads a TypeScript config in a "type": "module" package', () => {
      writePackage(root, 'module');
      writeHelper(root);
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, TS_CONFIG, 'utf-8');
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    it('loads a JavaScript config that imports a TypeScript helper', () => {
      writePackage(root, 'module');
      writeHelper(root);
      const file = path.join(root, 'tapsmith.config.js');
      fs.writeFileSync(file, 'import { platform } from "./helpers.js";\nexport default { platform, retries: 2 };\n', 'utf-8');
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    // The documented config shape, in a package without "type": "module" (an
    // Expo/RN app root). Node imports it natively; tsx would compile it, and
    // the ESM package it imports, to CommonJS, where `import.meta.dirname` —
    // which the SDK reads at module level — is undefined. A stand-in package
    // does the same, so this needs no build of the SDK.
    it('loads a config that imports an ESM package reading import.meta.dirname, in a package without "type": "module"', () => {
      writePackage(root, 'commonjs');
      const pkg = path.join(root, 'node_modules', 'esm-sdk');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), '{ "name": "esm-sdk", "type": "module", "exports": "./index.js" }\n', 'utf-8');
      fs.writeFileSync(
        path.join(pkg, 'index.js'),
        'import * as path from "node:path";\nconst here = path.resolve(import.meta.dirname);\n'
        + 'export const defineConfig = (c) => ({ ...c, here });\n',
        'utf-8',
      );
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, 'import { defineConfig } from "esm-sdk";\nexport default defineConfig({ platform: "ios", retries: 2 });\n', 'utf-8');
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    // The rejection path under the real loader.
    it('rejects a TypeScript config that throws, naming it, without running it twice', () => {
      writePackage(root, 'module');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(
        file,
        'globalThis.__runs = (globalThis.__runs ?? 0) + 1;\nconst x: number = 1;\nthrow new Error("boom " + x);\n',
        'utf-8',
      );
      const out = inBareNode<{ error?: string; cause?: string; runs?: number }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); }\n`
        + 'catch (e) { emit({ error: e.message, cause: e.cause?.message, runs: globalThis.__runs }); }\n',
      );
      expect(out).toEqual({ error: `Failed to load config file ${file}: boom 1`, cause: 'boom 1', runs: 1 });
    });

    // A SyntaxError the config raised while running is its own error, not a
    // parse failure for tsx to retry: retrying would run it twice.
    it('rejects a config that throws a SyntaxError while running, without running it twice', () => {
      writePackage(root, 'module');
      const file = path.join(root, 'tapsmith.config.mjs');
      fs.writeFileSync(file, 'globalThis.__runs = (globalThis.__runs ?? 0) + 1;\nJSON.parse("{bad");\nexport default {};\n', 'utf-8');
      const out = inBareNode<{ error?: string; runs?: number }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); }\n`
        + 'catch (e) { emit({ error: e.message, runs: globalThis.__runs }); }\n',
      );
      expect(out.error).toContain(`Failed to load config file ${file}:`);
      expect(out.error).toMatch(/JSON/);
      expect(out.runs).toBe(1);
    });

    // A CommonJS config's top-level frame is `Object.<anonymous> (<path>)`,
    // which must read as the config's own code, not as a builtin.
    it('rejects a CommonJS config that throws a SyntaxError while running, without running it twice', () => {
      writePackage(root, 'commonjs');
      const file = path.join(root, 'tapsmith.config.js');
      fs.writeFileSync(file, 'globalThis.__runs = (globalThis.__runs ?? 0) + 1;\nJSON.parse("{bad");\nmodule.exports = {};\n', 'utf-8');
      const out = inBareNode<{ error?: string; runs?: number }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); }\n`
        + 'catch (e) { emit({ error: e.message, runs: globalThis.__runs }); }\n',
      );
      expect(out.error).toContain(`Failed to load config file ${file}:`);
      expect(out.runs).toBe(1);
    });

    it('rejects a config that requires a malformed JSON file, without running it twice', () => {
      writePackage(root, 'module');
      fs.writeFileSync(path.join(root, 'data.json'), '{bad\n', 'utf-8');
      const file = path.join(root, 'tapsmith.config.mjs');
      fs.writeFileSync(
        file,
        'import { createRequire } from "node:module";\nglobalThis.__runs = (globalThis.__runs ?? 0) + 1;\n'
        + 'const data = createRequire(import.meta.url)("./data.json");\nexport default { data };\n',
        'utf-8',
      );
      const out = inBareNode<{ error?: string; runs?: number }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); }\n`
        + 'catch (e) { emit({ error: e.message, runs: globalThis.__runs }); }\n',
      );
      expect(out.error).toContain(`Failed to load config file ${file}:`);
      expect(out.runs).toBe(1);
    });

    // Node runs a stripped `.ts` config as ESM when it sees `import`, even in
    // a package without "type": "module"; tsx compiles it to CommonJS there,
    // where `__dirname` exists.
    it('loads a TypeScript config using __dirname in a package without "type": "module"', () => {
      writePackage(root, 'commonjs');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(
        file,
        'import * as path from "node:path";\nexport default { platform: path.basename(__dirname) ? "ios" : "android", retries: 2 };\n',
        'utf-8',
      );
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    // Why tsx was needed ("enum not supported") is not the config's error,
    // and beside the config's own throw it would point at the wrong cause.
    it('reports only the config\'s own error when it throws under tsx', () => {
      writePackage(root, 'module');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, 'enum Mode { A }\nthrow new Error("Set APK_PATH " + Mode.A);\n', 'utf-8');
      const out = inBareNode<{ error?: string }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); } catch (e) { emit({ error: e.message }); }\n`,
      );
      expect(out.error).toBe(`Failed to load config file ${file}: Set APK_PATH 0`);
    });

    // Errors tsx cannot get past either: retrying would only run the
    // config's side effects a second time.
    it('does not retry through tsx a missing module with no TypeScript source, or __dirname in an .mjs config', () => {
      writePackage(root, 'commonjs');
      const cjsFile = path.join(root, 'tapsmith.config.js');
      fs.writeFileSync(cjsFile, 'globalThis.__runs = (globalThis.__runs ?? 0) + 1;\nrequire("./local-missing");\nmodule.exports = {};\n', 'utf-8');
      const esmDir = path.join(root, 'esm');
      fs.mkdirSync(esmDir);
      const esmFile = path.join(esmDir, 'tapsmith.config.mjs');
      fs.writeFileSync(esmFile, 'globalThis.__runs = (globalThis.__runs ?? 0) + 1;\nexport default { here: __dirname };\n', 'utf-8');
      const out = inBareNode<{ cjs: [string, number]; esm: [string, number] }>(
        'const attempt = async (d) => { globalThis.__runs = 0; try { await loadConfig(d); return ["", globalThis.__runs]; } catch (e) { return [e.message, globalThis.__runs]; } };\n'
        + `emit({ cjs: await attempt(${JSON.stringify(root)}), esm: await attempt(${JSON.stringify(esmDir)}) });\n`,
      );
      expect(out.cjs[0]).toContain(`Failed to load config file ${cjsFile}:`);
      expect(out.cjs[1]).toBe(1);
      expect(out.esm[0]).toContain(`Failed to load config file ${esmFile}:`);
      expect(out.esm[1]).toBe(1);
    });

    // A type-only named import reached through require(esm) is rejected by
    // Node's synchronous linker; tsx elides it.
    it('loads a CommonJS config requiring a TypeScript helper with a type-only named import', () => {
      writePackage(root, 'commonjs');
      fs.writeFileSync(path.join(root, 'types.ts'), 'export type P = "ios";\nexport const platform: P = "ios";\n', 'utf-8');
      fs.writeFileSync(path.join(root, 'helpers.ts'), 'import { P, platform } from "./types.ts";\nexport const p: P = platform;\n', 'utf-8');
      const file = path.join(root, 'tapsmith.config.js');
      fs.writeFileSync(file, 'const { p } = require("./helpers.ts");\nmodule.exports = { platform: p, retries: 2 };\n', 'utf-8');
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    // Loader failures bare Node raises and tsx does not, beyond the common
    // ones above: each must fall back rather than stop the CLI's parent.
    it('loads a TypeScript config with a directory import and an attribute-less JSON import', () => {
      writePackage(root, 'module');
      fs.mkdirSync(path.join(root, 'shared'));
      fs.writeFileSync(path.join(root, 'shared', 'index.ts'), 'export const platform: string = "ios";\n', 'utf-8');
      fs.writeFileSync(path.join(root, 'settings.json'), '{ "retries": 2 }\n', 'utf-8');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(
        file,
        'import { platform } from "./shared";\nimport settings from "./settings.json";\n'
        + 'export default { platform, retries: settings.retries };\n',
        'utf-8',
      );
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    // Node's linker rejects a named import of a type-only export; tsx elides
    // the import, so it must fall back rather than fail.
    it('loads a TypeScript config with a type-only named import', () => {
      writePackage(root, 'module');
      fs.writeFileSync(path.join(root, 'types.ts'), 'export type Platform = "ios";\nexport const platform: Platform = "ios";\n', 'utf-8');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, 'import { Platform, platform } from "./types.ts";\nconst p: Platform = platform;\nexport default { platform: p, retries: 2 };\n', 'utf-8');
      expect(loadInBareNode(root)).toEqual({ path: file, platform: 'ios', retries: 2 });
    });

    it('rejects a config bare Node and tsx both fail on with the import error', () => {
      writePackage(root, 'module');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, 'import { x } from "./missing.js";\nexport default { x };\n', 'utf-8');
      const out = inBareNode<{ error?: string }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); } catch (e) { emit({ error: e.message }); }\n`,
      );
      expect(out.error).toContain(`Failed to load config file ${file}:`);
      expect(out.error).toMatch(/missing/);
    });

    // When tsx fails on something else, Node's own error — here the actual
    // typo — must still reach the user.
    it('keeps Node\'s error when the tsx retry fails differently', () => {
      writePackage(root, 'commonjs');
      const pkg = path.join(root, 'node_modules', 'esm-sdk');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), '{ "name": "esm-sdk", "type": "module", "exports": "./index.js" }\n', 'utf-8');
      fs.writeFileSync(path.join(pkg, 'index.js'), 'import * as path from "node:path";\nconst here = path.resolve(import.meta.dirname);\nexport const x = here;\n', 'utf-8');
      const file = path.join(root, 'tapsmith.config.ts');
      fs.writeFileSync(file, 'import { x } from "esm-sdk";\nimport { y } from "./helpr.js";\nexport default { x, y };\n', 'utf-8');
      const out = inBareNode<{ error?: string }>(
        `try { await loadConfig(${JSON.stringify(root)}); emit({}); } catch (e) { emit({ error: e.message }); }\n`,
      );
      expect(out.error).toContain(`Failed to load config file ${file}:`);
      expect(out.error).toMatch(/helpr\.js/);
    });

    // tsx's CJS unregister deletes the extension handlers it replaced rather
    // than restoring them, which in a tsx process strips tsx's own `.ts`
    // handler. The loader must undo only what the registration did.
    it('restores require.extensions after a tsx load, and keeps handlers the config installed', () => {
      writePackage(root, 'commonjs');
      writeHelper(root);
      fs.writeFileSync(
        path.join(root, 'tapsmith.config.ts'),
        'require.extensions[".yaml"] = () => undefined;\n' + TS_CONFIG,
        'utf-8',
      );
      const out = inBareNode<{ tsKept: boolean; keys: string[] }>(
        'const sentinel = () => undefined;\next[".ts"] = sentinel;\n'
        + `await loadConfig(${JSON.stringify(root)});\n`
        + 'emit({ tsKept: ext[".ts"] === sentinel, keys: Object.keys(ext) });\n',
      );
      expect(out.tsKept).toBe(true);
      expect(out.keys).toContain('.yaml');
      expect(out.keys).not.toContain('.tsx');
    });

    // The require hooks are process-global, so overlapping loads (an MCP
    // server's discovery and session setup) must not interleave: each would
    // restore the other's half-registered state and leave tsx's handlers
    // installed for good.
    it('leaves require.extensions untouched after overlapping tsx loads', () => {
      const dirs = ['a', 'b', 'c'].map((name) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        writePackage(dir, 'commonjs');
        writeHelper(dir);
        fs.writeFileSync(path.join(dir, 'tapsmith.config.ts'), TS_CONFIG.replace('retries: Retries.Some', `retries: Retries.Some, testMatch: ["${name}"]`), 'utf-8');
        return dir;
      });
      const out = inBareNode<{ matches: string[][]; same: boolean }>(
        'const before = Object.keys(ext).join();\n'
        + `const cs = await Promise.all(${JSON.stringify(dirs)}.map((d) => loadConfig(d)));\n`
        + 'emit({ matches: cs.map((c) => c.testMatch), same: Object.keys(ext).join() === before });\n',
      );
      expect(out).toEqual({ matches: [['a'], ['b'], ['c']], same: true });
    });
  });
});
import {
  defineConfig,
  resolveDeviceStrategy,
  isExplicitWorkers,
  loadConfig,
  configPathOf,
  normalizeGrep,
  EXPLICIT_ROOT_DIR,
} from '../config.js';

describe('defineConfig()', () => {
  it('accepts ui-mode preparation defaults and rejects malformed values', () => {
    const config = defineConfig({ ui: { prepareBetweenRuns: false, prepareDelayMs: 2_000 } });
    expect(config.ui).toEqual({ prepareBetweenRuns: false, prepareDelayMs: 2_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against untyped config files
    expect(() => defineConfig({ ui: { prepareBetweenRuns: 'no' as any } })).toThrow(/ui\.prepareBetweenRuns must be a boolean/);
    expect(() => defineConfig({ ui: { prepareDelayMs: -5 } })).toThrow(/ui\.prepareDelayMs must be a non-negative integer/);
    expect(() => defineConfig({ ui: { prepareDelayMs: 1.5 } })).toThrow(/ui\.prepareDelayMs must be a non-negative integer/);
  });

  it('accepts the telemetry opt-out and rejects a non-boolean', () => {
    expect(defineConfig({ telemetry: false }).telemetry).toBe(false);
    // Unset means opted in; the runtime treats anything but `false` as on.
    expect(defineConfig().telemetry).toBeUndefined();
    // A string 'false' would silently read as opted IN — refuse it instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against untyped config files
    expect(() => defineConfig({ telemetry: 'false' as any })).toThrow(/telemetry must be a boolean/);
  });

  it('returns defaults when called with no arguments', () => {
    const config = defineConfig();
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
    expect(config.testMatch).toEqual(['**/*.test.ts', '**/*.spec.ts']);
    expect(config.daemonAddress).toBe('localhost:50051');
    expect(config.rootDir).toBe(process.cwd());
    expect(config.outputDir).toBe('tapsmith-results');
    expect(config.apk).toBeUndefined();
    expect(config.activity).toBeUndefined();
    expect(config.device).toBeUndefined();
    expect(config.deviceStrategy).toBeUndefined();
    expect(config.daemonBin).toBeUndefined();
    expect(config.workers).toBe(1);
    expect(config.shard).toBeUndefined();
    expect(config.launchEmulators).toBe(false);
    expect(config.avd).toBeUndefined();
  });

  it('returns defaults when called with empty object', () => {
    const config = defineConfig({});
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
  });

  it('defaults launchEmulators to true when avd is set', () => {
    const config = defineConfig({ avd: 'Pixel_9_API_35' });
    expect(config.launchEmulators).toBe(true);
  });

  it('respects explicit launchEmulators: false when avd is set', () => {
    const config = defineConfig({ avd: 'Pixel_9_API_35', launchEmulators: false });
    expect(config.launchEmulators).toBe(false);
  });

  it('overrides timeout while keeping other defaults', () => {
    const config = defineConfig({ timeout: 15_000 });
    expect(config.timeout).toBe(15_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
  });

  it('ignores keys passed as explicit undefined instead of clobbering defaults', () => {
    const config = defineConfig({
      retries: undefined,
      timeout: undefined,
      workers: undefined,
    });
    expect(config.retries).toBe(0);
    expect(config.timeout).toBe(30_000);
    expect(config.workers).toBe(1);
    expect(isExplicitWorkers(config)).toBe(false);
  });

  it('overrides retries', () => {
    const config = defineConfig({ retries: 3 });
    expect(config.retries).toBe(3);
    expect(config.timeout).toBe(30_000);
  });

  it('overrides screenshot mode', () => {
    const config = defineConfig({ screenshot: 'always' });
    expect(config.screenshot).toBe('always');
  });

  it('overrides screenshot mode to never', () => {
    const config = defineConfig({ screenshot: 'never' });
    expect(config.screenshot).toBe('never');
  });

  it('overrides testMatch', () => {
    const config = defineConfig({ testMatch: ['**/*.tapsmith.ts'] });
    expect(config.testMatch).toEqual(['**/*.tapsmith.ts']);
  });

  it('overrides daemonAddress', () => {
    const config = defineConfig({ daemonAddress: 'remote:9090' });
    expect(config.daemonAddress).toBe('remote:9090');
  });

  it('overrides rootDir', () => {
    const config = defineConfig({ rootDir: '/custom/path' });
    expect(config.rootDir).toBe('/custom/path');
  });

  it('overrides outputDir', () => {
    const config = defineConfig({ outputDir: 'my-results' });
    expect(config.outputDir).toBe('my-results');
  });

  it('sets optional apk', () => {
    const config = defineConfig({ apk: '/path/to/app.apk' });
    expect(config.apk).toBe('/path/to/app.apk');
  });

  it('sets optional activity', () => {
    const config = defineConfig({ activity: 'com.example.app.MainActivity' });
    expect(config.activity).toBe('com.example.app.MainActivity');
  });

  it('sets optional device', () => {
    const config = defineConfig({ device: 'emulator-5554' });
    expect(config.device).toBe('emulator-5554');
  });

  it('sets optional daemonBin', () => {
    const config = defineConfig({ daemonBin: '/usr/local/bin/tapsmith-core' });
    expect(config.daemonBin).toBe('/usr/local/bin/tapsmith-core');
  });

  it('overrides multiple fields at once', () => {
    const config = defineConfig({
      timeout: 10_000,
      retries: 2,
      screenshot: 'always',
      apk: 'app.apk',
      activity: 'com.example.app.MainActivity',
      device: 'pixel6',
      daemonAddress: 'host:1234',
      rootDir: '/src',
      outputDir: 'out',
      testMatch: ['*.test.ts'],
    });
    expect(config.timeout).toBe(10_000);
    expect(config.retries).toBe(2);
    expect(config.screenshot).toBe('always');
    expect(config.apk).toBe('app.apk');
    expect(config.activity).toBe('com.example.app.MainActivity');
    expect(config.device).toBe('pixel6');
    expect(config.daemonAddress).toBe('host:1234');
    expect(config.rootDir).toBe('/src');
    expect(config.outputDir).toBe('out');
    expect(config.testMatch).toEqual(['*.test.ts']);
  });

  it('overrides workers', () => {
    const config = defineConfig({ workers: 4 });
    expect(config.workers).toBe(4);
  });

  it('overrides shard', () => {
    const config = defineConfig({ shard: { current: 2, total: 4 } });
    expect(config.shard).toEqual({ current: 2, total: 4 });
  });

  it('returns a plain object (not frozen or sealed)', () => {
    const config = defineConfig();
    config.timeout = 999;
    expect(config.timeout).toBe(999);
  });

  it('does not share references between calls', () => {
    const a = defineConfig();
    const b = defineConfig();
    a.timeout = 1;
    expect(b.timeout).toBe(30_000);
  });

  it('allows explicit deviceStrategy override', () => {
    const config = defineConfig({ deviceStrategy: 'prefer-connected' });
    expect(config.deviceStrategy).toBe('prefer-connected');
  });
});

describe('isExplicitWorkers() / loadConfig()', () => {
  it('defineConfig({}) is not explicit about workers', () => {
    expect(isExplicitWorkers(defineConfig())).toBe(false);
  });

  it('defineConfig({ workers: 2 }) is explicit about workers', () => {
    expect(isExplicitWorkers(defineConfig({ workers: 2 }))).toBe(true);
  });

  async function withTempConfig<T>(
    contents: string,
    fileName: string,
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'tapsmith-config-test-'));
    try {
      writeFileSync(join(dir, fileName), contents);
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('loadConfig flags a raw object-literal config with workers as explicit', async () => {
    // Catches the regression where users who export a plain object literal
    // (not via defineConfig) lose explicit-workers detection because the
    // Symbol-based flag is only stamped inside defineConfig.
    const contents = 'export default { workers: 3 };\n';
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.workers).toBe(3);
      expect(isExplicitWorkers(config)).toBe(true);
    });
  });

  it('loadConfig does not flag a raw object-literal config without workers', async () => {
    const contents = 'export default { timeout: 5000 };\n';
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.timeout).toBe(5000);
      expect(isExplicitWorkers(config)).toBe(false);
    });
  });

  it('loadConfig ignores explicit-undefined keys instead of clobbering defaults', async () => {
    const contents = 'export default { retries: undefined, timeout: undefined, workers: undefined };\n';
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.retries).toBe(0);
      expect(config.timeout).toBe(30_000);
      expect(config.workers).toBe(1);
      expect(isExplicitWorkers(config)).toBe(false);
    });
  });

  it('loadConfig propagates a validation error from a discovered config instead of swallowing it (PILOT-330 review)', async () => {
    // Regression: a malformed value used to throw inside the discovery loop's
    // catch, which warned and fell back to DEFAULT_CONFIG — turning
    // `telemetry: 'false'` (invalid) into a run that reports (opted IN).
    const contents = 'export default { telemetry: "false" };\n';
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      await expect(loadConfig(dir)).rejects.toThrow(/telemetry must be a boolean/);
    });
  });

  // The fixtures below simulate what `defineConfig` produces without
  // actually importing it — the dynamic import in loadConfig can't resolve
  // the tapsmith package's .ts source from a temp-dir .mjs fixture. Since
  // EXPLICIT_WORKERS is `Symbol.for('tapsmith.explicitWorkers')`, any module
  // can stamp it via Symbol.for and loadConfig's check will see the same
  // symbol. This tests the whole path that matters: "symbol survives the
  // loadConfig spread, rawHasExplicitWorkers trusts it when present".

  it('loadConfig preserves explicit-workers=true when defineConfig stamped the symbol', async () => {
    const contents = `
      const EXPLICIT_WORKERS = Symbol.for('tapsmith.explicitWorkers');
      const config = { workers: 4 };
      Object.defineProperty(config, EXPLICIT_WORKERS, { value: true, enumerable: false });
      export default config;
    `;
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.workers).toBe(4);
      expect(isExplicitWorkers(config)).toBe(true);
    });
  });

  it('loadConfig reports NOT explicit when defineConfig was called without a workers override', async () => {
    // Regression: defineConfig({}) stamps the symbol to false AND populates
    // workers=1 from the default merge. A naive "workers !== undefined"
    // fallback would misclassify this as explicit and fire the spurious
    // budget warning on every config that relies on per-project `workers:`
    // overrides instead of a top-level one.
    const contents = `
      const EXPLICIT_WORKERS = Symbol.for('tapsmith.explicitWorkers');
      // Simulate defineConfig({ timeout: 5000 }) — defaults merged in,
      // symbol stamped to false because the user didn't set workers.
      const config = { timeout: 5000, workers: 1 };
      Object.defineProperty(config, EXPLICIT_WORKERS, { value: false, enumerable: false });
      export default config;
    `;
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.timeout).toBe(5000);
      expect(config.workers).toBe(1);
      expect(isExplicitWorkers(config)).toBe(false);
    });
  });
});

describe('resolveDeviceStrategy()', () => {
  it('defaults to prefer-connected when avd is not set', () => {
    expect(resolveDeviceStrategy(defineConfig())).toBe('prefer-connected');
  });

  it('defaults to avd-only when avd is set', () => {
    expect(resolveDeviceStrategy(defineConfig({ avd: 'Pixel_9_API_35' }))).toBe('avd-only');
  });

  it('respects explicit override when avd is set', () => {
    expect(
      resolveDeviceStrategy(
        defineConfig({ avd: 'Pixel_9_API_35', deviceStrategy: 'prefer-connected' }),
      ),
    ).toBe('prefer-connected');
  });
});

describe('normalizeGrep()', () => {
  it('returns [] for undefined', () => {
    expect(normalizeGrep(undefined)).toEqual([]);
  });

  it('wraps a single RegExp in an array', () => {
    const re = /foo/;
    expect(normalizeGrep(re)).toEqual([re]);
  });

  it('passes through arrays as-is', () => {
    const arr = [/foo/, /bar/i];
    expect(normalizeGrep(arr)).toBe(arr);
  });
});
