import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { strToU8, zipSync } from 'fflate';
import {
  appSourceRoot,
  buildTime,
  checkStaleBuild,
  findSourceChangedAfterBuild,
  resetStaleBuildChecks,
  staleBuildMessage,
  unchangedSinceBuild,
} from '../stale-build.js';

// PILOT-1398: a run says so when the app's source is newer than the build it
// tests, since Tapsmith tests the installed build, never the source.

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-stale-build-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const BUILT = new Date('2026-01-01T10:00:00Z');
const BEFORE = new Date('2026-01-01T09:00:00Z');
const AFTER = new Date('2026-01-01T11:00:00Z');

let n = 0;
function project(): string {
  const dir = path.join(TMP, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file: string, time: Date, content = 'x'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, time, time);
  return file;
}

/** An Expo-shaped app: package.json, src/, and a Release APK (embedding JS unless `debug`). */
function expoApp(opts: { debug?: boolean } = {}): { root: string; apk: string } {
  const root = project();
  write(path.join(root, 'package.json'), BEFORE, '{}');
  write(path.join(root, 'android', 'settings.gradle'), BEFORE);
  write(path.join(root, 'src', 'app', 'todos.tsx'), BEFORE);
  const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  fs.mkdirSync(path.dirname(apk), { recursive: true });
  const files: Record<string, Uint8Array> = { 'AndroidManifest.xml': strToU8('manifest') };
  if (!opts.debug) files['assets/index.android.bundle'] = strToU8('bundle');
  fs.writeFileSync(apk, zipSync(files));
  fs.utimesSync(apk, BUILT, BUILT);
  return { root, apk };
}

function config(root: string, apk: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: 'android' as const,
    apk,
    rootDir: root,
    outputDir: 'tapsmith-results',
    testMatch: ['**/*.test.ts'],
    ...overrides,
  };
}

function makeFullConfig() {
  return { timeout: 30_000, retries: 0, screenshot: 'never' as const, daemonAddress: 'localhost:50051', workers: 1, launchEmulators: false };
}

beforeEach(() => resetStaleBuildChecks());

describe('appSourceRoot', () => {
  it('maps an Expo or React Native android/ folder to the app above it', () => {
    const { root, apk } = expoApp();
    expect(appSourceRoot(apk)).toBe(root);
  });

  it('takes a native project folder as it is', () => {
    const root = project();
    write(path.join(root, 'settings.gradle.kts'), BEFORE);
    const apk = write(path.join(root, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), BUILT);
    expect(appSourceRoot(apk)).toBe(root);
  });

  it('finds an Xcode project beside the build folder', () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'MyApp.xcodeproj'));
    const app = path.join(root, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app');
    fs.mkdirSync(app, { recursive: true });
    expect(appSourceRoot(app)).toBe(root);
  });

  it('has no answer for a build outside any project', () => {
    const home = project();
    const apk = write(path.join(home, 'Downloads', 'app.apk'), BUILT);
    expect(appSourceRoot(apk, home)).toBeUndefined();
  });
});

describe('buildTime', () => {
  it('dates a .app bundle by its newest top-level entry', () => {
    const app = path.join(project(), 'MyApp.app');
    write(path.join(app, 'Info.plist'), BEFORE);
    write(path.join(app, 'MyApp'), BUILT);
    fs.utimesSync(app, BEFORE, BEFORE);
    expect(buildTime(app)).toBe(BUILT.getTime());
  });

  it('is undefined for a build that is not there', () => {
    expect(buildTime(path.join(TMP, 'missing.apk'))).toBeUndefined();
  });
});

describe('findSourceChangedAfterBuild', () => {
  it('says nothing when every source file is older than the build', async () => {
    const { apk } = expoApp();
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toBeUndefined();
  });

  it('names the newest app file edited after the build, and counts the others', async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'src', 'app', 'todos.tsx'), AFTER);
    write(path.join(root, 'src', 'lib', 'api.ts'), new Date(AFTER.getTime() - 1000));
    const stale = await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true });
    expect(stale).toMatchObject({ newestRelative: 'src/app/todos.tsx', count: 2, buildMtimeMs: BUILT.getTime() });
    expect(staleBuildMessage(stale!)).toBe(
      'src/app/todos.tsx (and 1 other app file) changed after app-release.apk was built. '
      + 'Tapsmith tests the installed build, not your source: rebuild the app to test the change. '
      + 'https://tapsmith.dev/getting-started/#after-you-change-the-app',
    );
  });

  it('ignores JavaScript when the build loads it from Metro, but not native code', async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: false })).toBeUndefined();
    write(path.join(root, 'android', 'app', 'src', 'main', 'java', 'MainActivity.kt'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: false })).toMatchObject({
      newestRelative: 'android/app/src/main/java/MainActivity.kt', count: 1,
    });
  });

  it('leaves out Xcode test targets but not app folders whose names merely start with "test"', async () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'MyApp.xcodeproj'));
    const app = path.join(root, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app');
    write(path.join(app, 'MyApp'), BUILT);
    fs.utimesSync(app, BUILT, BUILT);
    write(path.join(root, 'MyAppTests', 'FooTests.swift'), AFTER);
    write(path.join(root, 'MyAppUITests', 'UITests.swift'), AFTER);
    expect(await findSourceChangedAfterBuild(app, { platform: 'ios', countJs: false })).toBeUndefined();
    write(path.join(root, 'MyApp', 'Testimonials', 'View.swift'), AFTER);
    expect(await findSourceChangedAfterBuild(app, { platform: 'ios', countJs: false })).toMatchObject({ newestRelative: 'MyApp/Testimonials/View.swift' });
  });

  it("leaves out the other platform's native code", async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'ios', 'MyApp', 'AppDelegate.swift'), AFTER);
    write(path.join(root, 'ios', 'MyApp', 'Bridge.m'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toBeUndefined();
    write(path.join(root, 'android', 'app', 'src', 'main', 'java', 'MainActivity.kt'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toMatchObject({ count: 1 });
  });

  it('skips dependency, build and tooling trees, dot folders, unit tests and tool configs', async () => {
    const { root, apk } = expoApp();
    for (const rel of [
      'node_modules/lib/index.js', 'ios/Pods/X/x.m', 'android/app/build/generated/R.java', '.expo/types.ts',
      '.git/hooks/x.js', 'dist/index.js', 'src/__tests__/a.ts', 'src/a.test.tsx', 'src/types.d.ts',
      'tapsmith.config.ts', 'eslint.config.mjs', 'README.md', 'package.json',
      // Native and Flutter test sources: never in the build.
      'android/app/src/test/java/FooTest.kt', 'android/app/src/testRelease/java/BarTest.java',
      'android/app/src/androidTest/java/UiTest.kt', 'android/app/src/sharedTest/java/Shared.kt',
      'test/widget_test.dart', 'integration_test/app_test.dart', 'test_driver/driver.dart', 'lib/foo_test.dart',
    ]) write(path.join(root, rel), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toBeUndefined();
  });

  it('counts app.json, which a build reads, even for a build that loads its JavaScript from Metro', async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'app.json'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: false })).toMatchObject({ newestRelative: 'app.json' });
  });

  it('leaves out what the caller says is test code, and asks only when something is newer', async () => {
    const { root, apk } = expoApp();
    let asked = 0;
    const isTestCode = async () => {
      asked++;
      return new Set([path.join(root, 'e2e', 'screens', 'todos.ts')]);
    };
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true, isTestCode })).toBeUndefined();
    expect(asked).toBe(0);
    write(path.join(root, 'e2e', 'screens', 'todos.ts'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true, isTestCode })).toBeUndefined();
    expect(asked).toBe(1);
  });

  it('gives up past its bounds rather than stall a run', async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true, limits: { maxEntries: 2, maxMs: 10_000 } })).toBeUndefined();
  });
});

describe('checkStaleBuild', () => {
  it('reads the build type from the APK: a Release build counts JavaScript, a Debug one does not', async () => {
    const release = expoApp();
    write(path.join(release.root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await checkStaleBuild(config(release.root, release.apk), { ci: false })).toMatchObject({ newestRelative: 'src/app/todos.tsx' });

    const debug = expoApp({ debug: true });
    write(path.join(debug.root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await checkStaleBuild(config(debug.root, debug.apk), { ci: false })).toBeUndefined();
  });

  it('leaves out test files and the modules they import, but not the app code beside them', async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'e2e', 'todos.test.ts'), AFTER, "import { open } from './screens/todos';\nopen();\n");
    write(path.join(root, 'e2e', 'screens', 'todos.ts'), AFTER, 'export function open() {}\n');
    expect(await checkStaleBuild(config(root, apk), { ci: false })).toBeUndefined();

    resetStaleBuildChecks();
    write(path.join(root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await checkStaleBuild(config(root, apk), { ci: false })).toMatchObject({ newestRelative: 'src/app/todos.tsx', count: 1 });
  });

  it("leaves out every project's tests, and a worker's serialized config keeps them all", async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'flows', 'auth.setup.ts'), AFTER, "import { login } from './login';\nlogin();\n");
    write(path.join(root, 'flows', 'login.ts'), AFTER, 'export function login() {}\n');
    const withProjects = config(root, apk, { projects: [{ name: 'setup', testMatch: ['flows/*.setup.ts'] }] });
    expect(await checkStaleBuild(withProjects, { ci: false })).toBeUndefined();
    // What a worker, UI worker or watch/MCP child runs with.
    const { configFromSerialized, serializeConfig } = await import('../worker-protocol.js');
    const worker = configFromSerialized(serializeConfig({ ...makeFullConfig(), ...withProjects }), 'localhost:1');
    expect(worker.testMatch).toEqual(['**/*.test.ts', 'flows/*.setup.ts']);
    resetStaleBuildChecks();
    expect(await checkStaleBuild(worker, { ci: false })).toBeUndefined();
  });

  it('leaves out a Tapsmith project in a subfolder of the app', async () => {
    const { root, apk } = expoApp();
    const e2e = path.join(root, 'e2e');
    write(path.join(e2e, 'scripts', 'seed.ts'), AFTER);
    expect(await checkStaleBuild(config(e2e, path.relative(e2e, apk)), { ci: false })).toBeUndefined();
  });

  it('says nothing in CI or without a configured build', async () => {
    const { root, apk } = expoApp();
    write(path.join(root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await checkStaleBuild(config(root, apk), { ci: true })).toBeUndefined();
    expect(await checkStaleBuild(config(root, apk, { apk: undefined }), { ci: false })).toBeUndefined();
    expect(await checkStaleBuild(config(root, path.join(root, 'nope.apk')), { ci: false })).toBeUndefined();
  });

  it('reuses an answer for 30 s, and looks again once the app is rebuilt', async () => {
    const { root, apk } = expoApp();
    let now = 1_000_000;
    const deps = { ci: false, now: () => now };
    write(path.join(root, 'src', 'app', 'todos.tsx'), AFTER);
    expect(await checkStaleBuild(config(root, apk), deps)).toBeDefined();
    // Rebuilt: the build's time is part of the key.
    const rebuilt = new Date(AFTER.getTime() + 60_000);
    fs.utimesSync(apk, rebuilt, rebuilt);
    expect(await checkStaleBuild(config(root, apk), deps)).toBeUndefined();
    // Edited again within the 30 s: the remembered answer stands until it expires.
    write(path.join(root, 'src', 'app', 'todos.tsx'), new Date(rebuilt.getTime() + 1000));
    expect(await checkStaleBuild(config(root, apk), deps)).toBeUndefined();
    now += 30_000;
    expect(await checkStaleBuild(config(root, apk), deps)).toMatchObject({ newestRelative: 'src/app/todos.tsx' });
  });
});

describe('unchangedSinceBuild', () => {
  // Reflog times come from GIT_COMMITTER_DATE, so each step gets its own second.
  const T0 = 1_780_000_000; // main committed
  const T_BUILD = T0 + 100; // the APK is built
  const T1 = T0 + 200; // later checkouts

  function git(cwd: string, at: number, ...args: string[]): void {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000`,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  }

  function repo(): { root: string; apk: string; file: string } {
    const { root, apk } = expoApp();
    const file = path.join(root, 'src', 'app', 'todos.tsx');
    fs.writeFileSync(file, 'v1');
    git(root, T0, 'init', '-q', '-b', 'main');
    git(root, T0, 'add', '-A');
    git(root, T0, 'commit', '-q', '-m', 'main');
    git(root, T0, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(file, 'v2');
    git(root, T0, 'commit', '-q', '-am', 'feature');
    git(root, T0 + 1, 'checkout', '-q', 'main');
    fs.utimesSync(apk, T_BUILD, T_BUILD);
    return { root, apk, file };
  }

  it('treats a file that only moved in time (a branch round trip) as unchanged, so a rebuild is not asked for', async () => {
    const { root, apk, file } = repo();
    git(root, T1, 'checkout', '-q', 'feature');
    git(root, T1, 'checkout', '-q', 'main');
    fs.utimesSync(file, T1, T1);
    expect(await unchangedSinceBuild(root, [file], T_BUILD * 1000)).toEqual(new Set([file]));
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toBeUndefined();
  });

  it('still reports an edit, and a branch switched to after the build', async () => {
    const { root, apk, file } = repo();
    fs.writeFileSync(file, 'v1 edited');
    fs.utimesSync(file, T1, T1);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toMatchObject({ newestRelative: 'src/app/todos.tsx' });
    fs.writeFileSync(file, 'v1');
    git(root, T1, 'checkout', '-q', 'feature');
    fs.utimesSync(file, T1, T1);
    expect(await findSourceChangedAfterBuild(apk, { platform: 'android', countJs: true })).toMatchObject({ newestRelative: 'src/app/todos.tsx' });
  });

  it('decides nothing outside a repository or before the reflog begins', async () => {
    const { root } = expoApp();
    expect(await unchangedSinceBuild(root, [path.join(root, 'src', 'app', 'todos.tsx')], Date.now())).toEqual(new Set());
    const r = repo();
    expect(await unchangedSinceBuild(r.root, [r.file], (T0 - 10) * 1000)).toEqual(new Set());
  });
});
