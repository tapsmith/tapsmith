import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadConfig,
  defineConfig,
  isConfigValidationError,
  ConfigValidationError,
} from '../config.js';

// PILOT-552: configs run through tsx without type-checking, so a typo'd key,
// a wrong type or a wrong-case enum used to be silently ignored or misread —
// `platform: 'iOS'` ran on Android. Like Playwright, the config is validated
// at load: the error names the file and the bad key or value, and the run
// stops before doing any work.

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-validate-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(body: string, name = 'tapsmith.config.mjs'): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/** Load a config whose default export is `literal` (JS source), returning the rejection. */
async function loadError(literal: string): Promise<ConfigValidationError> {
  writeConfig(`export default ${literal}\n`);
  const err = await loadConfig(root).then(
    () => { throw new Error('expected loadConfig to reject'); },
    (e: unknown) => e,
  );
  expect(isConfigValidationError(err)).toBe(true);
  return err as ConfigValidationError;
}

describe('config validation at load (PILOT-552)', () => {
  describe('the error', () => {
    it('names the config file and the bad key, without a "config:" prefix', async () => {
      const file = path.join(root, 'tapsmith.config.mjs');
      const err = await loadError('{ workers: "two" }');
      expect(err.message).toBe(`Invalid config file ${file}: workers must be a positive integer (got "two")`);
      expect(err.configPath).toBe(file);
      expect(err.code).toBe('TAPSMITH_INVALID_CONFIG');
    });

    it('lists every problem at once', async () => {
      const err = await loadError('{ apkk: "./a.apk", timeout: "5s", retries: -1 }');
      expect(err.message).toContain('\n  - unknown option \'apkk\' (did you mean \'apk\'?)');
      expect(err.message).toContain('\n  - timeout must be a positive number of milliseconds (got "5s")');
      expect(err.message).toContain('\n  - retries must be a non-negative integer (got -1)');
    });

    it('names an explicit --config file too', async () => {
      const file = writeConfig('export default { platform: "iOS" }\n', 'ci.config.mjs');
      await expect(loadConfig(root, 'ci.config.mjs')).rejects.toThrow(`Invalid config file ${file}: platform`);
    });

    it('carries the file for errors raised inside defineConfig while the config is imported', async () => {
      // defineConfig's own validators (trace modes, appReset, devices…) throw
      // during the import; they must read the same as the load-time ones.
      // Stand-in for `import { defineConfig } from 'tapsmith'`, which an OS
      // temp dir cannot resolve.
      const configModule = path.resolve(__dirname, '..', 'config.ts');
      const file = writeConfig(
        `import { defineConfig } from ${JSON.stringify(configModule)};\n`
        + 'export default defineConfig({ trace: "retain-on-falure" });\n',
      );
      const err = await loadConfig(root).catch((e: unknown) => e);
      expect(isConfigValidationError(err)).toBe(true);
      expect((err as Error).message).toMatch(
        new RegExp(`^Invalid config file ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: trace must be one of 'off'`),
      );
    });
  });

  describe('enum values', () => {
    it("accepts platform 'macos'", async () => {
      writeConfig('export default { platform: "macos", app: "./My.app", package: "com.example.mac" }\n');
      const config = await loadConfig(root);
      expect(config.platform).toBe('macos');
    });

    it("rejects platform 'iOS' and suggests the right case", async () => {
      const err = await loadError('{ platform: "iOS" }');
      expect(err.message).toContain(`platform must be one of 'android', 'ios', 'macos' (got "iOS"; did you mean 'ios'?)`);
    });

    it('rejects an unknown platform without a suggestion when nothing is close', async () => {
      const err = await loadError('{ platform: "windows" }');
      expect(err.message).toContain(`platform must be one of 'android', 'ios', 'macos' (got "windows")`);
      expect(err.message).not.toContain('did you mean');
    });

    it.each([
      ['screenshot', '"on-failure"', "screenshot must be one of 'always', 'only-on-failure', 'never'"],
      ['deviceStrategy', '"avd"', "deviceStrategy must be 'prefer-connected' or 'avd-only'"],
    ])('rejects an unknown %s', async (key, value, expected) => {
      expect((await loadError(`{ ${key}: ${value} }`)).message).toContain(expected);
    });
  });

  describe('unknown keys', () => {
    it.each([
      ['apkk', 'apk'],
      ['timout', 'timeout'],
      ['Timeout', 'timeout'],
      ['simulater', 'simulator'],
      ['retires', 'retries'],
    ])("rejects '%s' and suggests '%s'", async (key, suggestion) => {
      const err = await loadError(`{ ${key}: 1 }`);
      expect(err.message).toContain(`unknown option '${key}' (did you mean '${suggestion}'?)`);
    });

    it('rejects a key nothing is close to, without a suggestion', async () => {
      const err = await loadError('{ flibbertigibbet: 1 }');
      expect(err.message).toContain("unknown option 'flibbertigibbet'");
      expect(err.message).not.toContain('did you mean');
    });

    it("explains Playwright's root-level `use`", async () => {
      expect((await loadError('{ use: { timeout: 1 } }')).message).toContain(
        "unknown option 'use' (Tapsmith has no root-level `use`: set these options at the top level, or in a project's `use`)",
      );
    });

    // One config per test: the ESM loader caches a file by its URL.
    it("explains Playwright's `testDir`", async () => {
      expect((await loadError('{ testDir: "./e2e" }')).message).toContain(
        "unknown option 'testDir' (Tapsmith finds tests under `rootDir` with `testMatch`)",
      );
    });

    it('points a root-level appState at a project `use`', async () => {
      expect((await loadError('{ appState: "./auth.tar.gz" }')).message).toContain(
        "unknown option 'appState' (appState is set in a project's `use` or with test.use())",
      );
    });

    it('rejects unknown ui keys', async () => {
      expect((await loadError('{ ui: { prepareBetweenRun: false } }')).message).toContain(
        "unknown option 'ui.prepareBetweenRun' (did you mean 'ui.prepareBetweenRuns'?)",
      );
    });
  });

  describe('types', () => {
    it.each([
      ['workers', '"two"', 'workers must be a positive integer (got "two")'],
      ['workers', '0', 'workers must be a positive integer (got 0)'],
      ['workers', '1.5', 'workers must be a positive integer (got 1.5)'],
      ['timeout', '-1', 'timeout must be a positive number of milliseconds (got -1)'],
      ['timeout', '0', 'timeout must be a positive number of milliseconds (got 0)'],
      ['timeout', 'NaN', 'timeout must be a positive number of milliseconds (got NaN)'],
      ['timeout', 'null', 'timeout must be a positive number of milliseconds (got null)'],
      ['retries', '"2"', 'retries must be a non-negative integer (got "2")'],
      ['apk', '42', 'apk must be a string (got 42)'],
      ['launchEmulators', '"yes"', 'launchEmulators must be a boolean (got "yes")'],
      ['typingDelay', '-5', 'typingDelay must be a non-negative number of milliseconds (got -5)'],
      ['resetAppWaitMs', '"750"', 'resetAppWaitMs must be a non-negative number of milliseconds (got "750")'],
      ['doubleTapInterval', '0', 'doubleTapInterval must be a positive number of milliseconds (got 0)'],
      ['testMatch', '"**/*.test.ts"', "testMatch must be an array of glob strings (got \"**/*.test.ts\"; wrap it: ['**/*.test.ts'])"],
      ['testMatch', '[1]', 'testMatch must be an array of glob strings (got [1])'],
      ['grep', '"login"', 'grep must be a RegExp or an array of RegExps (got "login")'],
      ['grepInvert', '[/a/, "b"]', 'grepInvert must be a RegExp or an array of RegExps (got [/a/, "b"])'],
      ['extraHTTPHeaders', '{ "x-a": 1 }', 'extraHTTPHeaders must be an object of string header values (got {"x-a":1})'],
      ['shard', '{ current: 3, total: 2 }', 'shard must be { current, total } with 1 <= current <= total (got {"current":3,"total":2})'],
      ['reporter', '42', "reporter must be a reporter name, a [name, options] tuple, or an array of them (got 42)"],
      ['reporter', '[["json", "r.json"]]', "reporter must be a reporter name, a [name, options] tuple, or an array of them (got [[\"json\",\"r.json\"]])"],
      ['projects', '{ name: "a" }', 'projects must be an array of project objects (got {"name":"a"})'],
      ['ui', '"off"', 'ui must be an object (got "off")'],
    ])('rejects %s: %s', async (key, value, expected) => {
      expect((await loadError(`{ ${key}: ${value} }`)).message).toContain(expected);
    });

    it('reports a function value readably', async () => {
      expect((await loadError('{ timeout: () => 5000 }')).message).toContain(
        'timeout must be a positive number of milliseconds (got a function)',
      );
    });

    it('treats null as unset for an optional path, name or serial', async () => {
      // `device: process.env.DEVICE ?? null` has always meant "no pin".
      writeConfig('export default { device: null, avd: null, apk: null, simulator: null, platform: "ios" }\n');
      await expect(loadConfig(root)).resolves.toMatchObject({ platform: 'ios' });
    });

    // Their validators and defaults never accepted null: say so at load,
    // naming the file, rather than crash or throw later without it.
    it.each([
      ['ui', 'ui must be an object (got null)'],
      ['telemetry', 'telemetry must be a boolean (got null)'],
      ['appReset', "appReset must be one of 'auto'"],
      ['devices', 'devices must be a positive integer'],
      ['emulatorLaunchOptions', 'emulatorLaunchOptions must be an object (got null)'],
      ['platform', "platform must be one of 'android', 'ios', 'macos' (got null)"],
      ['timeout', 'timeout must be a positive number of milliseconds (got null)'],
    ])('rejects %s: null at load', async (key, expected) => {
      const err = await loadError(`{ ${key}: null }`);
      expect(err.message).toContain(expected);
      expect(err.configPath).toBe(path.join(root, 'tapsmith.config.mjs'));
    });

    it('rejects a null in a project `use` at load, not at project resolution', async () => {
      expect((await loadError('{ projects: [{ name: "p", use: { appReset: null, platform: null } }] }')).message)
        .toMatch(/projects\[0\]\.use\.appReset must be one of[\s\S]*projects\[0\]\.use\.platform must be one of 'android', 'ios', 'macos' \(got null\)/);
    });

    it('reads null, false and empty reporter and grep values as unset, as their consumers always have', async () => {
      writeConfig('export default { reporter: false, grep: null, grepInvert: "", projects: [{ name: "p", grep: false }] }\n');
      await expect(loadConfig(root)).resolves.toBeTruthy();
    });

    it('accepts a reporter tuple whose options are left undefined', async () => {
      // `['html', CI ? { open: 'never' } : undefined]`: every reporter defaults its options.
      writeConfig('export default { reporter: [["html", undefined]] }\n');
      await expect(loadConfig(root)).resolves.toBeTruthy();
    });

    it('rejects a reporter tuple whose options are null, which no reporter accepts', async () => {
      expect((await loadError('{ reporter: [["json", null]] }')).message).toContain('reporter must be a reporter name');
    });

    it('checks the keys of the trace and video object forms', async () => {
      const err = await loadError('{ trace: { mode: "on", screenshot: false }, video: { mode: "on", sizes: {} } }');
      expect(err.message).toContain("unknown option 'trace.screenshot' (did you mean 'trace.screenshots'?)");
      expect(err.message).toContain("unknown option 'video.sizes' (did you mean 'video.size'?)");
    });

    it('checks trace keys in a project `use` too', async () => {
      expect((await loadError('{ projects: [{ name: "p", use: { trace: { mode: "on", netwrok: true } } }] }')).message)
        .toContain("unknown option 'projects[0].use.trace.netwrok' (did you mean 'projects[0].use.trace.network'?)");
    });

    it('accepts every valid shape', async () => {
      writeConfig(`export default {
        platform: 'android', apk: './a.apk', activity: '.Main', timeout: 1, retries: 2,
        screenshot: 'never', testMatch: ['**/*.test.ts'], daemonAddress: 'localhost:1',
        daemonBin: '/bin/x', device: 'emulator-5554', devices: 2, deviceStrategy: 'avd-only',
        rootDir: '.', outputDir: 'out', package: 'com.x', agentApk: 'a', agentTestApk: 'b',
        iosXctestrun: 'x', resetAppDeepLink: 'x://reset', resetAppWaitMs: 500,
        appReset: 'warm', appResetScope: 'test', appResetColdEvery: 0,
        ui: { prepareBetweenRuns: false, prepareDelayMs: 10 }, telemetry: false,
        typingDelay: 10, doubleTapInterval: 50, simulator: 'iPhone 16',
        reporter: [['list'], ['json', { outputFile: 'r.json' }], 'dot'], workers: 3,
        shard: { current: 1, total: 2 }, launchEmulators: true, avd: 'Pixel',
        emulatorLaunchOptions: { headless: true, args: ['-no-audio'] },
        trace: { mode: 'on', screenshots: true }, video: 'off',
        baseURL: 'https://x', extraHTTPHeaders: { 'x-a': 'b' }, grep: /a/, grepInvert: [/b/],
        projects: [{
          name: 'p', testMatch: ['x'], testIgnore: ['y'], dependencies: [], workers: 1,
          grep: [/a/], grepInvert: /b/,
          use: { timeout: 1, appState: './s.tar.gz', platform: 'android', avd: 'Pixel' },
        }],
      }\n`);
      await expect(loadConfig(root)).resolves.toMatchObject({ platform: 'android', workers: 3 });
    });

    it('accepts a single reporter tuple', async () => {
      writeConfig('export default { reporter: ["json", { outputFile: "r.json" }] }\n');
      await expect(loadConfig(root)).resolves.toBeTruthy();
    });

    it('accepts a defineConfig result, whose markers are symbols', async () => {
      const configModule = path.resolve(__dirname, '..', 'config.ts');
      writeConfig(
        `import { defineConfig } from ${JSON.stringify(configModule)};\n`
        + 'export default defineConfig({ workers: 2, platform: "ios" });\n',
      );
      await expect(loadConfig(root)).resolves.toMatchObject({ workers: 2, platform: 'ios' });
    });
  });

  describe('projects', () => {
    it('validates project keys, naming the project by index', async () => {
      const err = await loadError('{ projects: [{ name: "a" }, { name: "b", testMatchh: ["x"], workers: "1" }] }');
      expect(err.message).toContain("unknown option 'projects[1].testMatchh' (did you mean 'projects[1].testMatch'?)");
      expect(err.message).toContain('projects[1].workers must be a positive integer (got "1")');
    });

    it('requires a project name', async () => {
      expect((await loadError('{ projects: [{ testMatch: ["x"] }] }')).message).toContain(
        'projects[0].name must be a non-empty string (got undefined)',
      );
    });

    it('rejects a non-object project', async () => {
      expect((await loadError('{ projects: ["ios"] }')).message).toContain(
        'projects[0] must be a project object (got "ios")',
      );
    });

    it('validates `use` values and keys the same way as the root', async () => {
      const err = await loadError('{ projects: [{ name: "ios", use: { platform: "iOS", simulater: "iPhone 16", timeout: "1" } }] }');
      expect(err.message).toContain("projects[0].use.platform must be one of 'android', 'ios', 'macos' (got \"iOS\"; did you mean 'ios'?)");
      expect(err.message).toContain("unknown option 'projects[0].use.simulater' (did you mean 'projects[0].use.simulator'?)");
      expect(err.message).toContain('projects[0].use.timeout must be a positive number of milliseconds (got "1")');
    });

    it('validates enum options a project `use` shares with the root', async () => {
      expect((await loadError('{ projects: [{ name: "a", use: { appReset: "cold", trace: "always" } }] }')).message)
        .toMatch(/projects\[0\]\.use\.appReset must be one of 'auto'.*\(got "cold"\)[\s\S]*projects\[0\]\.use\.trace must be one of 'off'/);
    });

    it('explains a project-level option put inside `use`', async () => {
      expect((await loadError('{ projects: [{ name: "a", use: { workers: 2 } }] }')).message).toContain(
        "projects[0].use.workers can't be set in `use`; set it on the project itself (projects[0].workers)",
      );
    });

    it('explains a root-only option put inside `use`', async () => {
      expect((await loadError('{ projects: [{ name: "a", use: { reporter: "dot" } }] }')).message).toContain(
        "projects[0].use.reporter can't be set per project; set it at the top level of the config",
      );
    });

    it('rejects a non-object `use`', async () => {
      expect((await loadError('{ projects: [{ name: "a", use: "ios" }] }')).message).toContain(
        'projects[0].use must be an object (got "ios")',
      );
    });
  });

  describe('the default export', () => {
    it('is required', async () => {
      const file = writeConfig('export const config = { platform: "ios" };\n');
      const err = await loadConfig(root).catch((e: unknown) => e);
      expect(isConfigValidationError(err)).toBe(true);
      expect((err as Error).message).toBe(
        `Invalid config file ${file}: it has no default export (found named export \`config\`). `
        + 'Export the config as the default: `export default defineConfig({ ... })`',
      );
    });

    it('is required when the file exports nothing', async () => {
      const file = writeConfig('const config = { platform: "ios" };\n');
      await expect(loadConfig(root)).rejects.toThrow(
        `Invalid config file ${file}: it has no default export. Export the config as the default: \`export default defineConfig({ ... })\``,
      );
    });

    it('must not be a promise', async () => {
      // An async config would otherwise pass as an empty object and run on the defaults.
      const file = writeConfig('export default Promise.resolve({ platform: "ios" });\n');
      await expect(loadConfig(root)).rejects.toThrow(
        `Invalid config file ${file}: the default export must be a config object (got {})`,
      );
    });

    it('must be an object', async () => {
      const file = writeConfig('export default () => ({ platform: "ios" });\n');
      await expect(loadConfig(root)).rejects.toThrow(
        `Invalid config file ${file}: the default export must be a config object (got a function)`,
      );
    });

    it('accepts a CommonJS module.exports config', async () => {
      writeConfig('module.exports = { platform: "ios" };\n', 'tapsmith.config.js');
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');
      await expect(loadConfig(root)).resolves.toMatchObject({ platform: 'ios' });
    });
  });
});

describe('defineConfig()', () => {
  it('reports every problem at once, as loadConfig does', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against untyped config files
    const err = (() => { try { defineConfig({ timout: 5, platform: 'iOS', appReset: 'cold' } as any); } catch (e) { return e; } })();
    expect(isConfigValidationError(err)).toBe(true);
    expect((err as ConfigValidationError).issues).toEqual([
      "unknown option 'timout' (did you mean 'timeout'?)",
      "platform must be one of 'android', 'ios', 'macos' (got \"iOS\"; did you mean 'ios'?)",
      "appReset must be one of 'auto', 'clear', 'restart', 'warm', 'none' (got \"cold\")",
    ]);
  });

  it('throws a ConfigValidationError for its own checks, keeping the "config:" message', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against untyped config files
    const err = (() => { try { defineConfig({ appReset: 'cold' as any }); } catch (e) { return e; } })();
    expect(isConfigValidationError(err)).toBe(true);
    expect((err as Error).message).toMatch(/^config: appReset must be one of/);
  });
});
