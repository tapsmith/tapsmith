/**
 * `tapsmith test [args...] [--grep]` resolves its selection before any device
 * or daemon work (PILOT-553): a glob, directory or filter that matches nothing,
 * a missing file, or a grep that selects no test, fails with "No tests found"
 * at once instead of after a device boot.
 *
 * A selected test file that fails to load is reported the same way, before
 * any device work (PILOT-784), and so is a missing config.
 *
 * Drives the *built* CLI in a scratch project, with `adb` and the daemon
 * replaced by stand-ins that record being reached — so "before any device
 * work" is asserted, not inferred from timing. Rebuild (`npm run build`) after
 * changing the code these cover; a local run with no build skips them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PKG_DIR = path.resolve(__dirname, '..', '..');
const CLI = path.join(PKG_DIR, 'dist', 'cli.js');
const DIST_BUILT = fs.existsSync(CLI);

if (!DIST_BUILT && !process.env.CI) {
  console.warn('cli-test-selection.test.ts: skipped — dist/ is not built (run `npm run build`).');
}

const testFile = (describeName: string, tests: string[]): string =>
  'import { test, describe } from "tapsmith";\n'
  + `describe(${JSON.stringify(describeName)}, () => {\n`
  + tests.map((t) => `  test(${JSON.stringify(t)}, async () => {});\n`).join('')
  + '});\n';

describe.skipIf(!DIST_BUILT && !process.env.CI)('tapsmith test selection', { timeout: 60_000 }, () => {
  let root: string;
  let marker: string;
  let fakeBin: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-select-')));
    marker = path.join(root, 'device-work.log');
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "select-app", "private": true, "type": "module" }\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(PKG_DIR, path.join(root, 'node_modules', 'tapsmith'), 'dir');
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false };\n');
    fs.mkdirSync(path.join(root, 'tests', 'pw'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'login.test.ts'), testFile('login', ['signs in']));
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'signup.test.ts'), testFile('signup', ['creates an account']));
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'helper.ts'), 'export const x = 1;\n');

    // Stand-ins for everything device-side: each records that it was reached
    // and fails, so a run that gets past selection stops there.
    fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    for (const tool of ['adb', 'emulator', 'xcrun', 'tapsmith-core']) {
      const script = path.join(fakeBin, tool);
      fs.writeFileSync(script, `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(marker)}\nexit 1\n`);
      fs.chmodSync(script, 0o755);
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(...args: string[]): { status: number | null; output: string; reachedDevice: boolean } {
    const result = spawnSync(process.execPath, [CLI, 'test', ...args], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        ANDROID_HOME: path.join(root, 'no-sdk'),
        ANDROID_SDK_ROOT: path.join(root, 'no-sdk'),
        TAPSMITH_DAEMON_BIN: path.join(fakeBin, 'tapsmith-core'),
        TAPSMITH_TELEMETRY: '0',
        HOME: root,
        CI: '',
        GITHUB_ACTIONS: '',
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      reachedDevice: fs.existsSync(marker),
    };
  }

  it.each([
    ['a glob that matches no test file', ['tests/other/*.test.ts']],
    ['a directory with no test files', ['fake-bin']],
    ['a filter that matches no test file path', ['checkout']],
    ['a missing file', ['tests/nope.test.ts']],
  ])('fails with "No tests found" before any device work for %s', (_label, args) => {
    const { status, output, reachedDevice } = run(...args);
    expect(output).toContain('No tests found.');
    expect(output).toContain(`"${args[0]}" matched no test file`);
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('fails with "No tests found" before any device work when --grep selects no test', () => {
    const { status, output, reachedDevice } = run('--grep', 'zzzz');
    expect(output).toContain('No tests found: no test matches grep /zzzz/.');
    expect(output).toContain('  - login > signs in');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it.each([
    ['a glob', ['tests/pw/*.test.ts']],
    ['a directory', ['tests/pw']],
    ['a filter', ['login']],
    ['a matching --grep', ['--grep', 'creates']],
  ])('gets past selection for %s', (_label, args) => {
    const { output, reachedDevice } = run(...args);
    expect(output).not.toContain('No tests found');
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(reachedDevice).toBe(true);
  });

  it('warns once about an argument that matched nothing and runs the rest', () => {
    const { output, reachedDevice } = run('login', 'zzzz');
    // Once, though the CLI re-execs itself under tsx for a TypeScript suite.
    expect(output.split('Warning: "zzzz" matched no test file')).toHaveLength(2);
    expect(reachedDevice).toBe(true);
  });

  it('runs what a directory selects under a project whose testMatch starts with ./', () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["./tests/pw/**/*.test.ts"] }] };\n');
    const { output, reachedDevice } = run('tests/pw');
    expect(output).not.toContain('No tests found');
    expect(output).not.toContain('not matched by any project');
    expect(reachedDevice).toBe(true);
  });

  it('reads the test names for --grep in a child, never importing a test file in the CLI process', () => {
    // A test file's top-level code must not run in the process that later
    // imports it for the run: a second evaluation re-runs its side effects,
    // and a helper it imports stays cached with registrations made for the
    // throwaway discovery context.
    const log = path.join(root, 'imports.log');
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'login.test.ts'),
      'import * as fs from "node:fs";\n'
      + `fs.appendFileSync(${JSON.stringify(log)}, (typeof process.send) + "\\n");\n`
      + testFile('login', ['signs in']));
    const { reachedDevice } = run('--grep', 'signs in');
    expect(reachedDevice).toBe(true);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual(['function']);
  });

  it('names the projects\' testMatch when no argument matches in a projects config', () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"] }] };\n');
    const { status, output, reachedDevice } = run('typo');
    expect(output).toContain('"typo" matched no test file');
    expect(output).toContain('(tests/pw/**/*.test.ts)');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('reports, rather than runs, a named file no project covers', () => {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'x.test.ts'), testFile('x', ['y']));
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"] }] };\n');
    const { status, output, reachedDevice } = run('scripts/x.test.ts');
    expect(output).toContain('scripts/x.test.ts is not matched by any project\'s testMatch');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('notes a glob that globbed nothing and was read as a regular expression', () => {
    const { output, reachedDevice } = run('tests/*');
    expect(output).toContain('Note: "tests/*" matched no file as a glob, so it was read as a regular expression');
    expect(reachedDevice).toBe(true);
  });

  it('blames the --project choice for a file only an unselected project covers', () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, projects: ['
      + '{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"] }, { name: "other", testMatch: ["tests/other/**/*.test.ts"] }] };\n');
    const { status, output, reachedDevice } = run('--project', 'other', 'tests/pw/login.test.ts');
    expect(output).toContain('tests/pw/login.test.ts is not matched by any selected project\'s testMatch');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('names a project grep that filters out every test the root grep selects', () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"], grep: /@ios/ }] };\n');
    const { status, output, reachedDevice } = run('--grep', 'signs');
    expect(output).toContain('No tests found: no test matches grep /signs/ together with the projects\' grep / grepInvert');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('runs a dependency project in full when a filter also matches one of its files', () => {
    // Playwright runs dependency projects whole: a filter selects among the
    // projects that depend on them, so `auth` must not cut the setup project
    // down to auth.setup.ts and leave seed.setup.ts out.
    for (const f of ['tests/auth.setup.ts', 'tests/seed.setup.ts']) fs.writeFileSync(path.join(root, f), testFile('setup', ['s']));
    fs.mkdirSync(path.join(root, 'tests', 'auth'));
    fs.writeFileSync(path.join(root, 'tests', 'auth', 'flow.test.ts'), testFile('auth', ['logs in']));
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, projects: ['
      + '{ name: "setup", testMatch: ["**/*.setup.ts"] }, '
      + '{ name: "main", testMatch: ["tests/auth/**/*.test.ts"], dependencies: ["setup"] }] };\n');
    const { output, reachedDevice } = run('auth');
    expect(output).toContain('3 test files');
    expect(reachedDevice).toBe(true);
  });

  it('answers the grep check from the whole suite on every shard', () => {
    // --grep "creates" matches only signup.test.ts. With two files and two
    // shards, a shard holding only login.test.ts must still get past the
    // check: the suite has a match, whichever shard it falls on.
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"] }] };\n');
    for (const shard of ['1/2', '2/2']) {
      fs.rmSync(marker, { force: true });
      const { output, reachedDevice } = run('--grep', 'creates', `--shard=${shard}`);
      expect(output).not.toContain('No tests found');
      expect(reachedDevice).toBe(true);
    }
  });

  it('plans each shard from its own files in a config without projects (PILOT-596)', () => {
    // The run iterates the default project's list. Before the fix only a flat
    // copy was sharded, so every shard ran both files — visible here as a
    // worker per file of the whole suite rather than of the shard.
    for (const shard of ['1/2', '2/2']) {
      const { output, reachedDevice } = run(`--shard=${shard}`, '--workers', '2');
      expect(output).toContain(`Shard ${shard}: running 1 file(s)`);
      expect(output).toContain('Config: 1 worker | 1 test file');
      expect(reachedDevice).toBe(true);
    }
  });

  function writeChain(): void {
    for (const f of ['tests/auth.setup.ts', 'tests/seed.setup.ts']) fs.writeFileSync(path.join(root, f), testFile('setup', ['s']));
    fs.mkdirSync(path.join(root, 'tests', 'api'));
    fs.writeFileSync(path.join(root, 'tests', 'api', 'checkout.test.ts'), testFile('checkout', ['pays']));
    fs.writeFileSync(path.join(root, 'tests', 'api', 'orders.test.ts'), testFile('orders', ['lists']));
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, projects: ['
      + '{ name: "setup", testMatch: ["**/*.setup.ts"] }, '
      + '{ name: "api", testMatch: ["tests/api/**/*.test.ts"], dependencies: ["setup"] }, '
      + '{ name: "e2e", testMatch: ["tests/pw/**/*.test.ts"], dependencies: ["api"] }] };\n');
  }

  it('selects with a filter in a project that is both a dependency and a dependent', () => {
    // setup → api → e2e: `checkout` picks api's checkout.test.ts, which runs
    // with all of setup; nothing depends on api in this run, so it is cut down.
    writeChain();
    const { output, reachedDevice } = run('checkout');
    expect(output).not.toContain('No tests found');
    expect(output).toContain('3 test files');
    expect(reachedDevice).toBe(true);
  });

  it('runs a selected setup project whole when a selected project depends on it', () => {
    writeChain();
    const { output, reachedDevice } = run('--project', 'setup', '--project', 'api', 'auth', 'checkout');
    expect(output).toContain('3 test files');
    expect(reachedDevice).toBe(true);
  });

  it('runs just the setup file a filter names when nothing in the run depends on its project', () => {
    writeChain();
    const { output, reachedDevice } = run('auth.setup');
    expect(output).toContain('1 test file');
    expect(reachedDevice).toBe(true);
  });

  it('gets past the grep check when the only match is a skipped test, so the run reports the skip', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'later.test.ts'),
      'import { test } from "tapsmith";\n'
      + 'test.skip("parked feature", async () => {});\n'
      + 'test("runtime skipped", async () => { test.skip(); });\n');
    for (const pattern of ['parked', 'runtime skipped']) {
      fs.rmSync(marker, { force: true });
      const { output, reachedDevice } = run('--grep', pattern);
      expect(output).not.toContain('No tests found');
      expect(reachedDevice).toBe(true);
    }
  });

  it('selects within init\'s *.tapsmith.ts testMatch, never the project\'s unit tests', () => {
    // init's configs match only *.tapsmith.ts (PILOT-554), so a directory or
    // filter must not pull in a *.test.ts unit test sitting beside the tests.
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, testMatch: ["**/*.tapsmith.ts"] };\n');
    fs.writeFileSync(path.join(root, 'tests', 'example.tapsmith.ts'), testFile('example', ['opens the app']));
    const dir = run('tests');
    expect(dir.output).toContain('1 test file');
    expect(dir.reachedDevice).toBe(true);
    fs.rmSync(marker, { force: true });
    // `login` matches only tests/pw/login.test.ts, which this testMatch leaves out.
    const filter = run('login');
    expect(filter.output).toContain('"login" matched no test file');
    expect(filter.output).toContain('(**/*.tapsmith.ts)');
    expect(filter.reachedDevice).toBe(false);
    const grep = run('--grep', 'zzzz');
    expect(grep.output).toContain('No tests found: no test matches grep /zzzz/.');
    expect(grep.output).toContain('  - example > opens the app');
    expect(grep.reachedDevice).toBe(false);
  });
  // ─── Load failures before any device work (PILOT-784) ───

  const BROKEN = 'import { test } from "tapsmith";\ntest("bad", async () => {\n  const x = ;\n});\n';
  const plain = (output: string): string => output.replace(/\x1b\[\d+m/g, '');

  it('reports a test file with a syntax error, with a code frame, before any device work, and runs nothing', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'broken.test.ts'), BROKEN);
    const { status, output, reachedDevice } = run();
    expect(plain(output)).toContain('broken.test.ts — failed to load');
    expect(plain(output)).toMatch(/> 3 \|\s+const x = ;/);
    expect(plain(output)).toContain('No tests ran: 1 test file failed to load.');
    expect(output).not.toContain('Config:');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('points a missing import at its line, before any device work', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'login.test.ts'),
      'import { test } from "tapsmith";\nimport { helper } from "./helpers/nope.js";\ntest("m", async () => { helper(); });\n');
    const { status, output, reachedDevice } = run();
    expect(plain(output)).toContain('login.test.ts — failed to load');
    expect(plain(output)).toMatch(/> 2 \| import \{ helper \} from "\.\/helpers\/nope\.js";/);
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('reports a top-level throw and a describe body that throws, every file in one go', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'login.test.ts'), 'throw new Error("boom at load");\n');
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'signup.test.ts'),
      'import { describe } from "tapsmith";\ndescribe("s", () => { throw new Error("boom in describe"); });\n');
    const { status, output, reachedDevice } = run();
    expect(output).toContain('boom at load');
    expect(output).toContain('boom in describe');
    expect(plain(output)).toContain('No tests ran: 2 test files failed to load.');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('reports a load failure, not "no test matches", when a grep is active', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'broken.test.ts'), BROKEN);
    const { status, output, reachedDevice } = run('--grep', 'signs in');
    expect(output).not.toContain('No tests found');
    expect(plain(output)).toContain('broken.test.ts — failed to load');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('reports a load failure before any device work with --workers', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'broken.test.ts'), BROKEN);
    const { status, output, reachedDevice } = run('--workers', '2');
    expect(plain(output)).toContain('broken.test.ts — failed to load');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('reports a load failure in a dependency project\'s file, and gives it to the configured reporters', () => {
    fs.writeFileSync(path.join(root, 'tests', 'auth.setup.ts'), BROKEN);
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'reporter: [["list"], ["json", { outputFile: "report.json" }]], projects: ['
      + '{ name: "setup", testMatch: ["**/*.setup.ts"] }, '
      + '{ name: "e2e", testMatch: ["tests/pw/**/*.test.ts"], dependencies: ["setup"] }] };\n');
    const { status, output, reachedDevice } = run('login');
    expect(plain(output)).toContain('auth.setup.ts — failed to load');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf-8')) as { stats?: { failed?: number } };
    expect(JSON.stringify(report)).toContain('auth.setup.ts — failed to load');
  });

  it('checks only the files of its own shard', () => {
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'signup.test.ts'), BROKEN);
    const outcomes = ['1/2', '2/2'].map((shard) => {
      fs.rmSync(marker, { force: true });
      const { output, reachedDevice } = run(`--shard=${shard}`);
      return { failedToLoad: plain(output).includes('signup.test.ts — failed to load'), reachedDevice };
    });
    expect(outcomes).toEqual(expect.arrayContaining([
      { failedToLoad: true, reachedDevice: false },
      { failedToLoad: false, reachedDevice: true },
    ]));
  });

  // ─── No config (PILOT-784) ───

  it.each([[[] as string[]], [['--ui']], [['--watch']], [['tests/pw/login.test.ts']]])(
    'refuses to run without a config, naming init, before any device work (%j)',
    (args) => {
      fs.rmSync(path.join(root, 'tapsmith.config.mjs'));
      const { status, output, reachedDevice } = run(...args);
      expect(plain(output)).toContain(`No tapsmith.config.ts (or .js, .mjs) found in ${root}. To set Tapsmith up here, run: npx tapsmith init`);
      expect(output).not.toContain('Config:');
      expect(output).not.toContain('No tests found');
      expect(status).toBe(1);
      expect(reachedDevice).toBe(false);
    },
  );

  it('names the project\'s own runner in the init hint', () => {
    fs.rmSync(path.join(root, 'tapsmith.config.mjs'));
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    const { status, output } = run();
    expect(plain(output)).toContain('To set Tapsmith up here, run: pnpm exec tapsmith init');
    expect(status).toBe(1);
  });
});

