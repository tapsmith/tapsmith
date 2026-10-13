import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTestFiles,
  isIgnoredDiscoveryWatchPath,
  isIgnoredWatchModePath,
  getTestDiscoveryWatchRoots,
  matchesTestIgnore,
  matchesTestFile,
  noTestFilesFoundMessage,
  relativeTestPath,
  resolveTestFileArgs,
} from '../test-file-discovery.js';

describe('test-file-discovery helpers', () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-discovery-'));
    rootDir = path.join(tempDir, 'repo');
    fs.mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches configured test files and applies default ignores', () => {
    expect(matchesTestFile(path.join(rootDir, 'tests', 'new.test.ts'), ['**/*.test.ts'], rootDir)).toBe(true);
    expect(matchesTestFile(path.join(rootDir, 'node_modules', 'pkg', 'new.test.ts'), ['**/*.test.ts'], rootDir)).toBe(false);
    expect(matchesTestFile(path.join(rootDir, 'dist', 'new.test.ts'), ['**/*.test.ts'], rootDir)).toBe(false);
  });

  it('applies project ignore patterns', () => {
    const filePath = path.join(rootDir, 'tests', 'smoke-login.test.ts');

    expect(matchesTestFile(filePath, ['tests/**/*.test.ts'], rootDir, ['**/smoke-*.test.ts'])).toBe(false);
  });

  it('resolves relative file paths from the configured rootDir', () => {
    expect(relativeTestPath('tests/new.test.ts', rootDir)).toBe('tests/new.test.ts');
    expect(matchesTestFile('tests/new.test.ts', ['tests/**/*.test.ts'], rootDir)).toBe(true);
  });

  it('matches default ignore patterns for directories and descendants', () => {
    expect(matchesTestIgnore('node_modules')).toBe(true);
    expect(matchesTestIgnore('node_modules/pkg/new.test.ts')).toBe(true);
    expect(matchesTestIgnore('dist')).toBe(true);
    expect(matchesTestIgnore('dist/new.test.ts')).toBe(true);
    expect(matchesTestIgnore('tests/dist.test.ts')).toBe(false);
  });

  // PILOT-713: an Expo/React Native project's native and generated trees hold
  // tens of thousands of files that are never tests.
  it('ignores native build, dependency and tooling directories', () => {
    for (const ignored of [
      'ios/Pods',
      'ios/Pods/Headers/Public/React-Core/React/RCTBridge.h',
      'ios/build',
      'ios/build/Build/Products/x.test.ts',
      'apps/mobile/ios/build',
      'android/build',
      'android/app/build',
      'android/app/build/generated/x.test.ts',
      'android/app/.cxx',
      'android/.gradle',
      '.gradle',
      '.expo',
      '.expo/types/x.test.ts',
      'ios/DerivedData',
      'DerivedData/App/Build',
    ]) {
      expect(matchesTestIgnore(ignored), ignored).toBe(true);
    }
    for (const kept of [
      'build',
      'build/login.test.ts',
      'e2e/build.test.ts',
      'e2e/ios/login.test.ts',
      'e2e/android/login.test.ts',
      'src/Pods.test.ts',
      'ios/AppTests/login.test.ts',
    ]) {
      expect(matchesTestIgnore(kept), kept).toBe(false);
    }
  });

  describe('isIgnoredDiscoveryWatchPath', () => {
    it('ignores paths outside rootDir, .git, the output dir and default-ignored directories', () => {
      const outputDir = path.join(rootDir, 'tapsmith-results');
      const ignored = (rel: string): boolean => isIgnoredDiscoveryWatchPath(path.join(rootDir, rel), rootDir, outputDir);

      expect(isIgnoredDiscoveryWatchPath(tempDir, rootDir, outputDir)).toBe(true);
      expect(ignored('.git')).toBe(true);
      expect(ignored('.git/objects')).toBe(true);
      expect(ignored('tapsmith-results')).toBe(true);
      expect(ignored('tapsmith-results/trace.zip')).toBe(true);
      expect(ignored('ios/Pods')).toBe(true);
      expect(ignored('node_modules/react-native')).toBe(true);
      expect(ignored('')).toBe(false);
      expect(ignored('e2e/login.test.ts')).toBe(false);
      expect(ignored('ios')).toBe(false);
    });

    it('in watch mode, keeps files watched by name and anything outside rootDir', () => {
      const outputDir = path.join(rootDir, 'tapsmith-results');
      const pinned = path.join(rootDir, 'dist', 'pinned.test.ts');
      const byName = new Set([pinned]);
      const ignored = (p: string): boolean => isIgnoredWatchModePath(p, rootDir, outputDir, byName);

      expect(ignored(pinned)).toBe(false);
      expect(ignored(path.join(rootDir, 'dist', 'other.test.ts'))).toBe(true);
      expect(ignored(path.join(rootDir, 'ios', 'Pods'))).toBe(true);
      expect(ignored(path.join(rootDir, 'node_modules'))).toBe(true);
      expect(ignored(path.join(rootDir, '.git'))).toBe(true);
      expect(ignored(outputDir)).toBe(true);
      expect(ignored(path.join(rootDir, 'e2e', 'login.test.ts'))).toBe(false);
      expect(ignored(path.join(tempDir, 'elsewhere', 'node_modules'))).toBe(false);
    });

    it('keeps chokidar out of an Expo project\'s native trees, including symlinks into node_modules', async () => {
      const touch = (rel: string): void => {
        const file = path.join(rootDir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      };
      touch('e2e/login.test.ts');
      touch('node_modules/react-native/React/RCTBridge.h');
      touch('ios/Pods/RCT-Folly/folly/Format.h');
      touch('ios/build/Build/Products/Release-iphonesimulator/App.app/main.jsbundle');
      touch('android/app/build/outputs/apk/app.apk');
      touch('android/.gradle/8.0/checksums.bin');
      touch('.expo/devices.json');
      fs.mkdirSync(path.join(rootDir, 'ios/Pods/Headers/Public'), { recursive: true });
      // CocoaPods links headers back into node_modules; chokidar follows symlinks.
      fs.symlinkSync(path.join(rootDir, 'node_modules/react-native/React'), path.join(rootDir, 'ios/Pods/Headers/Public/React-Core'));

      const outputDir = path.join(rootDir, 'tapsmith-results');
      const watcher = chokidarWatch([rootDir], {
        ignoreInitial: true,
        ignored: (candidate) => isIgnoredDiscoveryWatchPath(candidate.toString(), rootDir, outputDir),
      });
      try {
        await new Promise<void>((resolve, reject) => {
          watcher.once('ready', resolve);
          watcher.once('error', reject);
        });
        const watchedDirs = Object.keys(watcher.getWatched())
          .map((dir) => relativeTestPath(dir, rootDir))
          .filter((rel) => !rel.startsWith('..'))
          .sort();
        expect(watchedDirs).toEqual(['', 'android', 'android/app', 'e2e', 'ios']);
      } finally {
        await watcher.close();
      }
    });
  });

  it('derives watch roots from the static part of glob patterns', () => {
    fs.mkdirSync(path.join(rootDir, 'e2e', 'tests'), { recursive: true });

    expect(getTestDiscoveryWatchRoots(['e2e/tests/**/*.test.ts', '**/*.spec.ts'], rootDir)).toEqual([
      rootDir,
      path.join(rootDir, 'e2e', 'tests'),
    ]);
  });

  it('falls back to the nearest existing parent for missing test directories', () => {
    fs.mkdirSync(path.join(rootDir, 'e2e'), { recursive: true });

    expect(getTestDiscoveryWatchRoots(['e2e/missing/**/*.test.ts'], rootDir)).toEqual([
      path.join(rootDir, 'e2e'),
    ]);
  });

  describe('discoverTestFiles', () => {
    const touch = (rel: string): void => {
      const file = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    };

    beforeEach(() => {
      for (const rel of [
        'tests/b.test.ts',
        'tests/a.test.ts',
        'tests/nested/deep/c.test.ts',
        'tests/smoke-login.test.ts',
        'tests/helper.ts',
        'top.test.ts',
        '.hidden/dot.test.ts',
        'tests/.cache/dot.test.ts',
        'node_modules/pkg/dep.test.ts',
        'dist/built.test.ts',
        'packages/app/node_modules/pkg/nested-dep.test.ts',
      ]) {
        touch(rel);
      }
    });

    it('returns sorted absolute paths and skips dot-dirs, node_modules and dist', async () => {
      await expect(discoverTestFiles(['**/*.test.ts'], rootDir)).resolves.toEqual([
        path.join(rootDir, 'tests', 'a.test.ts'),
        path.join(rootDir, 'tests', 'b.test.ts'),
        path.join(rootDir, 'tests', 'nested', 'deep', 'c.test.ts'),
        path.join(rootDir, 'tests', 'smoke-login.test.ts'),
        path.join(rootDir, 'top.test.ts'),
      ]);
    });

    it('dedupes files matched by several patterns and applies project ignores', async () => {
      await expect(
        discoverTestFiles(['tests/**/*.test.ts', 'tests/*.test.ts', './top.test.ts'], rootDir, ['**/smoke-*.test.ts']),
      ).resolves.toEqual([
        path.join(rootDir, 'tests', 'a.test.ts'),
        path.join(rootDir, 'tests', 'b.test.ts'),
        path.join(rootDir, 'tests', 'nested', 'deep', 'c.test.ts'),
        path.join(rootDir, 'top.test.ts'),
      ]);
    });

    it('returns nothing when no file matches', async () => {
      await expect(discoverTestFiles(['missing/**/*.test.ts'], rootDir)).resolves.toEqual([]);
    });

  });

  describe('resolveTestFileArgs', () => {
    const touch = (rel: string): string => {
      const file = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      return file;
    };
    let candidates: string[];

    beforeEach(() => {
      candidates = [
        touch('tests/pw/login.test.ts'),
        touch('tests/pw/signup.test.ts'),
        touch('tests/other/Checkout.test.ts'),
        touch('top.test.ts'),
      ].sort();
      touch('tests/pw/helper.ts');
      touch('scripts/standalone.test.ts');
    });

    const resolve = (args: string[], roots = [rootDir]) => resolveTestFileArgs(args, candidates, roots);

    it('keeps an existing file, even one outside testMatch, and dedupes', () => {
      expect(resolve(['tests/pw/login.test.ts', 'scripts/standalone.test.ts', './tests/pw/login.test.ts'])).toMatchObject({
        files: [path.join(rootDir, 'tests/pw/login.test.ts'), path.join(rootDir, 'scripts/standalone.test.ts')],
        unmatched: [],
      });
    });

    it('accepts an absolute file path', () => {
      const file = path.join(rootDir, 'top.test.ts');
      expect(resolve([file]).files).toEqual([file]);
    });

    it('resolves a relative file from a later root (the working directory) when rootDir lacks it', () => {
      const cwd = path.join(rootDir, 'tests');
      expect(resolve(['pw/signup.test.ts'], [rootDir, cwd]).files).toEqual([path.join(rootDir, 'tests/pw/signup.test.ts')]);
    });

    it('expands a directory to the discovered test files under it, never its helpers', () => {
      expect(resolve(['tests/pw']).files).toEqual([
        path.join(rootDir, 'tests/pw/login.test.ts'),
        path.join(rootDir, 'tests/pw/signup.test.ts'),
      ]);
      expect(resolve(['tests/pw/']).files).toHaveLength(2);
    });

    it('reports a directory that holds no test file as unmatched', () => {
      expect(resolve(['scripts'])).toMatchObject({ files: [], unmatched: ['scripts'] });
    });

    it('reads a test-free directory\'s name as a filter, like any other word', () => {
      // An app's own `login/` source directory must not hide tests/pw/login.test.ts.
      fs.mkdirSync(path.join(rootDir, 'login'));
      expect(resolve(['login']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
    });

    it('tries the next root when the directory under rootDir holds no test file', () => {
      const cwd = path.join(rootDir, 'tests');
      fs.mkdirSync(path.join(rootDir, 'pw-empty'));
      fs.mkdirSync(path.join(cwd, 'pw-empty'));
      touch('tests/pw-empty/x.test.ts');
      candidates.push(path.join(rootDir, 'tests/pw-empty/x.test.ts'));
      expect(resolveTestFileArgs(['pw-empty'], candidates, [rootDir, cwd]).files)
        .toEqual([path.join(rootDir, 'tests/pw-empty/x.test.ts')]);
    });

    it('names a glob it had to read as a regular expression', () => {
      // Nothing sits directly in tests/, so the glob selects nothing — and
      // read as a regex, `tests/*` selects every file under tests/.
      expect(resolve(['tests/*'])).toMatchObject({ files: expect.arrayContaining([path.join(rootDir, 'tests/pw/login.test.ts')]), readAsRegex: ['tests/*'] });
      expect(resolve(['tests/pw/*.test.ts']).readAsRegex).toEqual([]);
      expect(resolve(['login']).readAsRegex).toEqual([]);
    });

    it('expands a glob over the discovered test files', () => {
      expect(resolve(['tests/pw/*.test.ts']).files).toEqual([
        path.join(rootDir, 'tests/pw/login.test.ts'),
        path.join(rootDir, 'tests/pw/signup.test.ts'),
      ]);
      expect(resolve(['./tests/**/*.test.ts']).files).toHaveLength(3);
      expect(resolve([path.join(rootDir, 'tests/other/*.ts')]).files).toEqual([path.join(rootDir, 'tests/other/Checkout.test.ts')]);
    });

    it('does not let a glob pull in helpers or files outside testMatch', () => {
      expect(resolve(['tests/pw/*']).files).toEqual([
        path.join(rootDir, 'tests/pw/login.test.ts'),
        path.join(rootDir, 'tests/pw/signup.test.ts'),
      ]);
      expect(resolve(['scripts/*.test.ts'])).toMatchObject({ files: [], unmatched: ['scripts/*.test.ts'] });
    });

    it('treats any other argument as a case-insensitive filter over the test file paths', () => {
      expect(resolve(['login']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['checkout']).files).toEqual([path.join(rootDir, 'tests/other/Checkout.test.ts')]);
      expect(resolve(['pw/']).files).toHaveLength(2);
    });

    it('reads the filter as a regular expression, like Playwright', () => {
      expect(resolve(['(login|signup)\\.test']).files).toHaveLength(2);
      expect(resolve(['/^top\\./']).files).toEqual([path.join(rootDir, 'top.test.ts')]);
    });

    it('reads a regular expression with glob-like characters as a filter when it globs nothing', () => {
      expect(resolve(['login.*test']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['/log.*in/']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['sign(up)?']).files).toEqual([path.join(rootDir, 'tests/pw/signup.test.ts')]);
      expect(resolve(['[ls]\\w+\\.test']).files).toHaveLength(2);
      expect(resolve(['/^tests\\/pw\\/(login|signup)/']).files).toHaveLength(2);
    });

    it('ignores a sticky or global flag, which would carry state from one file to the next', () => {
      expect(resolve(['/login/y']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['/test/gy']).files).toHaveLength(4);
    });

    it('falls back to a literal substring when the filter is not a valid regular expression', () => {
      expect(resolve(['login(']).unmatched).toEqual(['login(']);
    });

    it('matches the filter against the path relative to rootDir, not the rootDir name', () => {
      // rootDir is .../repo: an absolute-path match would select every file.
      expect(resolve(['repo'])).toMatchObject({ files: [], unmatched: ['repo'] });
    });

    it('reports a missing file as unmatched rather than resolving it literally', () => {
      expect(resolve(['tests/nope.test.ts'])).toMatchObject({ files: [], unmatched: ['tests/nope.test.ts'] });
    });

    it('keeps the matches of each argument and names only the ones that matched nothing', () => {
      expect(resolve(['signup', 'zzzz', 'login'])).toMatchObject({
        files: [path.join(rootDir, 'tests/pw/signup.test.ts'), path.join(rootDir, 'tests/pw/login.test.ts')],
        unmatched: ['zzzz'],
      });
    });
  });

  describe('noTestFilesFoundMessage', () => {
    it('says no file matched testMatch when no argument was given', () => {
      const message = noTestFilesFoundMessage({
        args: [], unmatched: [], outsideProjects: [], testMatch: ['**/*.test.ts'], rootDir: '/proj', configFound: true,
      });
      expect(message).toMatch(/^No tests found\./);
      expect(message).toContain('No file under /proj matches testMatch **/*.test.ts');
    });

    it('names every argument that matched nothing and how arguments are read', () => {
      const message = noTestFilesFoundMessage({
        args: ['login', 'tests/nope.test.ts'],
        unmatched: ['login', 'tests/nope.test.ts'],
        outsideProjects: [],
        testMatch: ['tests/**/*.test.ts'],
        rootDir: '/proj',
        configFound: true,
      });
      expect(message).toMatch(/^No tests found\./);
      expect(message).toContain('"login" matched no test file');
      expect(message).toContain('"tests/nope.test.ts" matched no test file');
      expect(message).toContain('a file, a directory, a glob, or a regular expression matched against the test file paths');
      expect(message).toContain('tests/**/*.test.ts');
    });

    it('names a file no project runs', () => {
      const message = noTestFilesFoundMessage({
        args: ['scripts/x.test.ts'], unmatched: [], outsideProjects: ['scripts/x.test.ts'], testMatch: ['tests/**'], rootDir: '/proj', configFound: true,
      });
      expect(message).toContain('scripts/x.test.ts is not matched by any project\'s testMatch');
    });

    it('blames the --project choice for a file only an unselected project runs', () => {
      const message = noTestFilesFoundMessage({
        args: ['a.test.ts'], unmatched: [], outsideProjects: ['a.test.ts'], testMatch: ['ios/**'], rootDir: '/proj', projectsSelected: true, configFound: true,
      });
      expect(message).toContain('a.test.ts is not matched by any selected project\'s testMatch');
    });

    // `verify` and `doctor` point a project with no config at `init`; so
    // does `test` now (PILOT-569).
    it('points a project with no config file at tapsmith init', () => {
      const message = noTestFilesFoundMessage({
        args: [], unmatched: [], outsideProjects: [], testMatch: ['**/*.test.ts'], rootDir: '/proj', configFound: false,
      });
      expect(message).toMatch(/^No tests found\./);
      expect(message).toContain('No tapsmith.config.ts (or .js, .mjs) found in /proj. To set Tapsmith up here, run: npx tapsmith init');
    });

    it('does not mention init when there is a config', () => {
      const message = noTestFilesFoundMessage({
        args: ['nope'], unmatched: ['nope'], outsideProjects: [], testMatch: ['**/*.test.ts'], rootDir: '/proj', configFound: true,
      });
      expect(message).not.toContain('init');
    });
  });
});
