import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  devDependencyInstallCommand,
  isMissingTapsmithError,
  isTapsmithResolvableFrom,
  projectPackageManager,
  tapsmithExecCommand,
  tapsmithInstallCommand,
} from '../config.js';

// `npx tapsmith init` and a global install run Tapsmith from outside the
// project, so the config and tests it writes import a package the project
// does not have (PILOT-551).

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-install-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function hasProjectAbove(start: string): boolean {
  for (let d = fs.realpathSync(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json')) || fs.existsSync(path.join(d, 'node_modules'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

function installTapsmithStub(at: string): void {
  write(path.join(at, 'node_modules/tapsmith/package.json'), '{ "name": "tapsmith", "exports": { ".": { "default": "./index.js" } } }\n');
  write(path.join(at, 'node_modules/tapsmith/index.js'), 'export {};\n');
}

describe('isTapsmithResolvableFrom()', () => {
  it('is false for a project without tapsmith', () => {
    write('package.json', '{}\n');
    expect(isTapsmithResolvableFrom(dir)).toBe(false);
  });

  it('is true when tapsmith is in the project\'s node_modules', () => {
    installTapsmithStub('.');
    expect(isTapsmithResolvableFrom(dir)).toBe(true);
  });

  it('is true from a subdirectory when an ancestor has it (a monorepo root)', () => {
    installTapsmithStub('.');
    fs.mkdirSync(path.join(dir, 'apps/mobile'), { recursive: true });
    expect(isTapsmithResolvableFrom(path.join(dir, 'apps/mobile'))).toBe(true);
  });
});

describe('tapsmithInstallCommand()', () => {
  it('defaults to npm when nothing names a package manager', async () => {
    write('package.json', '{}\n');
    expect(await tapsmithInstallCommand(dir)).toEqual({ command: 'npm', args: ['i', '-D', 'tapsmith'], display: 'npm i -D tapsmith' });
  });

  it.each([
    ['package-lock.json', 'npm i -D tapsmith'],
    ['yarn.lock', 'yarn add -D tapsmith'],
    ['pnpm-lock.yaml', 'pnpm add -D tapsmith'],
    ['bun.lock', 'bun add -D tapsmith'],
  ])('follows the lockfile %s', async (lockfile, display) => {
    write('package.json', '{}\n');
    write(lockfile, '');
    expect((await tapsmithInstallCommand(dir)).display).toBe(display);
  });

  it('follows the packageManager field', async () => {
    write('package.json', '{ "packageManager": "pnpm@9.1.0" }\n');
    expect((await tapsmithInstallCommand(dir)).display).toBe('pnpm add -D tapsmith');
  });

  it('finds a workspace root\'s lockfile from a subdirectory', async () => {
    write('yarn.lock', '');
    write('apps/mobile/package.json', '{}\n');
    expect((await tapsmithInstallCommand(path.join(dir, 'apps/mobile'))).display).toBe('yarn add -D tapsmith');
  });
});

// In a directory without package.json, a bare `npm i -D tapsmith` installs
// into the nearest ancestor project — a monorepo root, the home directory —
// and the config written here still cannot import it (PILOT-631).
describe('tapsmithInstallCommand() without a package.json in the directory', () => {
  const app = (): string => path.join(dir, 'apps/mobile');

  it('creates the package.json first and names the ancestor the bare command would change', async () => {
    write('package.json', '{}\n');
    fs.mkdirSync(app(), { recursive: true });
    const install = await tapsmithInstallCommand(app());
    expect(install.display).toBe('npm init -y && npm i -D tapsmith');
    // What init runs in place is still the bare add (only where a package.json exists).
    expect(install.command).toBe('npm');
    expect(install.args).toEqual(['i', '-D', 'tapsmith']);
    expect(install.note).toBe(`There's no package.json in ${app()}: on its own, \`npm i -D tapsmith\` would add Tapsmith to ${dir} instead. If that is this project's root, run it there; otherwise create a package.json here first.`);
  });

  it.each([
    ['yarn.lock', 'yarn init -y && yarn add -D tapsmith'],
    ['pnpm-lock.yaml', 'pnpm init && pnpm add -D tapsmith'],
    // `bun init -y` scaffolds an index.ts and tsconfig too; npm only writes package.json.
    ['bun.lock', 'npm init -y && bun add -D tapsmith'],
  ])("uses the package manager's init for the ancestor's %s", async (lockfile, display) => {
    write('package.json', '{}\n');
    write(lockfile, '');
    fs.mkdirSync(app(), { recursive: true });
    const install = await tapsmithInstallCommand(app());
    expect(install.display).toBe(display);
    expect(install.note).toContain(`would add Tapsmith to ${dir} instead.`);
  });

  // npm's prefix is the nearest directory with a package.json or a node_modules.
  it('names an ancestor that npm would use for its node_modules alone', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.mkdirSync(app(), { recursive: true });
    expect((await tapsmithInstallCommand(app())).note).toContain(`would add Tapsmith to ${dir} instead.`);
  });

  it('names no ancestor when npm would use this directory\'s own node_modules', async () => {
    write('package.json', '{}\n');
    fs.mkdirSync(path.join(app(), 'node_modules'), { recursive: true });
    const install = await tapsmithInstallCommand(app());
    expect(install.display).toBe('npm init -y && npm i -D tapsmith');
    expect(install.note).toBe(`There's no package.json in ${app()}: create one before installing Tapsmith.`);
  });

  it('names the nearest ancestor, not a further one', async () => {
    write('package.json', '{}\n');
    write('apps/package.json', '{}\n');
    fs.mkdirSync(app(), { recursive: true });
    expect((await tapsmithInstallCommand(app())).note).toContain(`would add Tapsmith to ${path.join(dir, 'apps')} instead.`);
  });

  // The temp dir's own ancestors are outside the test's control: skipped,
  // not passed, on a host with a project above it.
  it.skipIf(hasProjectAbove(os.tmpdir()))('still says to create one when no ancestor has a project', async () => {
    const install = await tapsmithInstallCommand(dir);
    expect(install.display).toBe('npm init -y && npm i -D tapsmith');
    expect(install.note).toBe(`There's no package.json in ${dir}: create one before installing Tapsmith.`);
  });

  it('adds no note where the package.json is', async () => {
    write('package.json', '{}\n');
    expect((await tapsmithInstallCommand(dir)).note).toBeUndefined();
  });
});

describe('isMissingTapsmithError()', () => {
  const missing = (message: string, code: string): Error => Object.assign(new Error(message), { code });

  it('recognises the CommonJS error', () => {
    expect(isMissingTapsmithError(missing("Cannot find module 'tapsmith'\nRequire stack:\n- /p/tapsmith.config.ts", 'MODULE_NOT_FOUND'))).toBe(true);
  });

  it('recognises the ESM error', () => {
    expect(isMissingTapsmithError(missing("Cannot find package 'tapsmith' imported from /p/tapsmith.config.ts", 'ERR_MODULE_NOT_FOUND'))).toBe(true);
  });

  it('recognises a tapsmith subpath', () => {
    expect(isMissingTapsmithError(missing("Cannot find module 'tapsmith/trace-format.schema.json'", 'MODULE_NOT_FOUND'))).toBe(true);
  });

  it.each([
    ["Cannot find module 'tapsmith-helpers'", 'MODULE_NOT_FOUND'],
    ["Cannot find package '@acme/tapsmith' imported from /p/x.ts", 'ERR_MODULE_NOT_FOUND'],
    ["Cannot find module './tapsmith'", 'MODULE_NOT_FOUND'],
    ["Cannot find module 'tapsmith'", 'SOME_OTHER_CODE'],
  ])('does not mistake %s (%s) for it', (message, code) => {
    expect(isMissingTapsmithError(missing(message, code))).toBe(false);
  });

  it('is false for non-errors', () => {
    expect(isMissingTapsmithError(undefined)).toBe(false);
    expect(isMissingTapsmithError("Cannot find module 'tapsmith'")).toBe(false);
  });
});

// The same detection, for any package and for hints that need to know the
// manager itself (PILOT-709: the Android agent package's install hint).
describe('projectPackageManager()', () => {
  it('is npm when nothing names one', async () => {
    write('package.json', '{}\n');
    expect(await projectPackageManager(dir)).toBe('npm');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
  ])('follows the lockfile %s', async (lockfile, agent) => {
    write('package.json', '{}\n');
    write(lockfile, '');
    expect(await projectPackageManager(dir)).toBe(agent);
  });

  it('finds a workspace root\'s lockfile from a subdirectory', async () => {
    write('pnpm-lock.yaml', '');
    write('apps/mobile/package.json', '{}\n');
    expect(await projectPackageManager(path.join(dir, 'apps/mobile'))).toBe('pnpm');
  });
});

describe('tapsmithExecCommand() (PILOT-721)', () => {
  it.each([
    [undefined, 'npx tapsmith'],
    ['pnpm-lock.yaml', 'pnpm exec tapsmith'],
    ['yarn.lock', 'yarn tapsmith'],
    ['bun.lock', 'bunx tapsmith'],
  ])('with lockfile %s runs Tapsmith as `%s`', async (lockfile, expected) => {
    write('package.json', '{}\n');
    if (lockfile) write(lockfile, '');
    expect(await tapsmithExecCommand(dir)).toBe(expected);
  });

  it('runs yarn berry projects through yarn too', async () => {
    write('package.json', JSON.stringify({ packageManager: 'yarn@4.5.0' }));
    expect(await tapsmithExecCommand(dir)).toBe('yarn tapsmith');
  });
});

describe('devDependencyInstallCommand()', () => {
  it('adds the named packages with the project\'s package manager', async () => {
    write('package.json', '{}\n');
    write('pnpm-lock.yaml', '');
    expect(await devDependencyInstallCommand(dir, ['@tapsmith/agent-android'], 'the Android agent')).toEqual({
      command: 'pnpm',
      args: ['add', '-D', '@tapsmith/agent-android'],
      display: 'pnpm add -D @tapsmith/agent-android',
    });
  });

  it('names what it installs in the note for a directory without a package.json', async () => {
    write('package.json', '{}\n');
    fs.mkdirSync(path.join(dir, 'apps/mobile'), { recursive: true });
    const install = await devDependencyInstallCommand(path.join(dir, 'apps/mobile'), ['@tapsmith/agent-android'], 'the Android agent');
    expect(install.display).toBe('npm init -y && npm i -D @tapsmith/agent-android');
    expect(install.note).toContain(`would add the Android agent to ${dir} instead.`);
  });
});
