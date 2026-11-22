import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// PILOT-1397: the cheap stamps that let a long-lived session skip the full
// installed-build comparison when nothing changed. A stamp must change with
// any rebuild or reinstall, and be `undefined` whenever it cannot be read.

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[] }>,
  answer: (_file: string, _args: string[]): { err?: Error; stdout?: string } => ({ stdout: '' }),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    mocks.calls.push({ file, args });
    const { err, stdout } = mocks.answer(file, args);
    cb(err ?? null, stdout ?? '');
  }),
}));

const { localBuildStamp, installedApkStamp, installedSimulatorAppStamp } = await import('../build-stamp.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-build-stamp-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.answer = () => ({ stdout: '' });
});

function makeBundle(dir: string): void {
  fs.mkdirSync(path.join(dir, 'Frameworks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Info.plist'), 'plist');
  fs.writeFileSync(path.join(dir, 'main.jsbundle'), 'bundle v1');
  fs.writeFileSync(path.join(dir, 'Frameworks', 'lib.dylib'), 'lib');
}

describe('localBuildStamp', () => {
  it('changes when an APK is rebuilt, and not otherwise', async () => {
    const apk = path.join(ROOT, 'app.apk');
    fs.writeFileSync(apk, 'apk v1');
    const first = await localBuildStamp(apk);
    expect(first).toMatch(/^file:/);
    expect(await localBuildStamp(apk)).toBe(first);
  });

  it('changes when an APK is replaced by a same-size file with the same mtime (gradle writes a new file)', async () => {
    const apk = path.join(ROOT, 'replaced.apk');
    // Whole seconds: exactly representable, so the mtime alone cannot differ.
    const mtime = new Date(1_700_000_000_000);
    fs.writeFileSync(apk, 'apk v1');
    fs.utimesSync(apk, mtime, mtime);
    const first = await localBuildStamp(apk);
    // Written beside the original while it still exists (no inode reuse),
    // then renamed over it.
    const next = path.join(ROOT, 'replaced.apk.tmp');
    fs.writeFileSync(next, 'apk v2');
    fs.utimesSync(next, mtime, mtime);
    fs.renameSync(next, apk);
    expect(fs.statSync(apk).mtimeMs).toBe(mtime.getTime());
    expect(await localBuildStamp(apk)).not.toBe(first);
  });

  it('changes when an APK is rewritten in place with its size and mtime restored', async () => {
    const apk = path.join(ROOT, 'in-place.apk');
    const mtime = new Date(1_700_000_000_000);
    fs.writeFileSync(apk, 'apk v1');
    fs.utimesSync(apk, mtime, mtime);
    const first = await localBuildStamp(apk);
    const ino = fs.statSync(apk).ino;
    // The change time has a clock tick to move by.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(apk, 'apk v2');
    fs.utimesSync(apk, mtime, mtime);
    expect(fs.statSync(apk).ino).toBe(ino);
    expect(await localBuildStamp(apk)).not.toBe(first);
  });

  it('changes when any file of an .app bundle changes', async () => {
    const app = path.join(ROOT, 'Built.app');
    makeBundle(app);
    const first = await localBuildStamp(app);
    expect(first).toMatch(/^tree:/);
    expect(await localBuildStamp(app)).toBe(first);
    fs.writeFileSync(path.join(app, 'Frameworks', 'lib.dylib'), 'lib, rebuilt');
    const second = await localBuildStamp(app);
    expect(second).not.toBe(first);
    fs.writeFileSync(path.join(app, 'Frameworks', 'new.dylib'), 'x');
    expect(await localBuildStamp(app)).not.toBe(second);
  });

  it('changes when a rebuild keeps every size and mtime (a tool that normalises timestamps)', async () => {
    const app = path.join(ROOT, 'Normalised.app');
    makeBundle(app);
    const fixed = new Date('2000-01-01T00:00:00Z');
    for (const f of ['Info.plist', 'main.jsbundle', 'Frameworks/lib.dylib']) fs.utimesSync(path.join(app, f), fixed, fixed);
    const first = await localBuildStamp(app);
    // Same length, same mtime, different bytes, written in place.
    fs.writeFileSync(path.join(app, 'main.jsbundle'), 'bundle v9');
    fs.utimesSync(path.join(app, 'main.jsbundle'), fixed, fixed);
    expect(await localBuildStamp(app)).not.toBe(first);
  });

  it('is undefined for a build that is not there', async () => {
    expect(await localBuildStamp(path.join(ROOT, 'gone.apk'))).toBeUndefined();
  });
});

describe('installedApkStamp', () => {
  it('stamps every installed APK of the package from one device shell', async () => {
    mocks.answer = () => ({ stdout: '/data/app/~~a==/com.example-b==/base.apk 102389413 1795269625\n/data/app/~~a==/com.example-b==/split_config.arm64_v8a.apk 2048 1795269625\n' });
    expect(await installedApkStamp('emulator-5554', 'com.example')).toBe(
      'apk:/data/app/~~a==/com.example-b==/base.apk 102389413 1795269625|/data/app/~~a==/com.example-b==/split_config.arm64_v8a.apk 2048 1795269625',
    );
    expect(mocks.calls).toEqual([{ file: 'adb', args: ['-s', 'emulator-5554', 'shell', expect.stringContaining('pm path com.example')] }]);
  });

  it('is undefined when the package is not installed, the query fails, or the name is not a package name', async () => {
    mocks.answer = () => ({ stdout: 'stat: missing operand\n' });
    expect(await installedApkStamp('emulator-5554', 'com.example')).toBeUndefined();
    mocks.answer = () => ({ err: new Error('device offline') });
    expect(await installedApkStamp('emulator-5554', 'com.example')).toBeUndefined();
    mocks.calls.length = 0;
    expect(await installedApkStamp('emulator-5554', 'com.example; reboot')).toBeUndefined();
    expect(mocks.calls).toEqual([]);
  });
});

describe('installedSimulatorAppStamp', () => {
  it('stamps the installed bundle, which a reinstall writes anew', async () => {
    const container = path.join(ROOT, 'Containers', 'UUID-1', 'App.app');
    makeBundle(container);
    mocks.answer = () => ({ stdout: `${container}\n` });
    const first = await installedSimulatorAppStamp('SIM-1', 'com.example');
    expect(first).toContain(`app:${container}:`);
    expect(await installedSimulatorAppStamp('SIM-1', 'com.example')).toBe(first);
    fs.writeFileSync(path.join(container, 'main.jsbundle'), 'bundle v2, reinstalled');
    expect(await installedSimulatorAppStamp('SIM-1', 'com.example')).not.toBe(first);
    expect(mocks.calls[0]).toEqual({ file: 'xcrun', args: ['simctl', 'get_app_container', 'SIM-1', 'com.example', 'app'] });
  });

  it('is undefined when the app is not installed or its container cannot be read', async () => {
    mocks.answer = () => ({ err: new Error('No such file or directory') });
    expect(await installedSimulatorAppStamp('SIM-2', 'com.example')).toBeUndefined();
    mocks.answer = () => ({ stdout: path.join(ROOT, 'nowhere.app') });
    expect(await installedSimulatorAppStamp('SIM-2', 'com.example')).toBeUndefined();
  });

  it('takes a container an earlier process found, while it exists', async () => {
    const known = path.join(ROOT, 'Containers', 'UUID-K', 'App.app');
    makeBundle(known);
    mocks.answer = () => ({ err: new Error('should not be asked') });
    expect(await installedSimulatorAppStamp('SIM-4', 'com.example', known)).toContain(`app:${known}:`);
    expect(mocks.calls).toEqual([]);
    // Gone: simctl is asked after all.
    mocks.answer = () => ({ err: new Error('not installed') });
    expect(await installedSimulatorAppStamp('SIM-5', 'com.example', path.join(ROOT, 'gone.app'))).toBeUndefined();
    expect(mocks.calls).toHaveLength(1);
  });

  it('asks simctl once, and again only when the bundle it named has gone', async () => {
    const first = path.join(ROOT, 'Containers', 'UUID-A', 'App.app');
    makeBundle(first);
    mocks.answer = () => ({ stdout: `${first}\n` });
    const stamp = await installedSimulatorAppStamp('SIM-3', 'com.example');
    expect(await installedSimulatorAppStamp('SIM-3', 'com.example')).toBe(stamp);
    expect(mocks.calls).toHaveLength(1);
    // A reinstall wrote the bundle to a new container and removed the old one.
    const second = path.join(ROOT, 'Containers', 'UUID-B', 'App.app');
    makeBundle(second);
    fs.rmSync(path.dirname(first), { recursive: true });
    mocks.answer = () => ({ stdout: `${second}\n` });
    const after = await installedSimulatorAppStamp('SIM-3', 'com.example');
    expect(after).toContain(`app:${second}:`);
    expect(mocks.calls).toHaveLength(2);
  });
});
