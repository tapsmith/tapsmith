import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appBundlesMatch } from '../app-bundle-match.js';

// Real directories on disk: the comparison is all filesystem behaviour
// (walking, lstat, chunked reads), which a mocked fs would only restate.

let root: string;
let installed: string;
let candidate: string;

/** Write `files` (relative path → contents) under `dir`, creating parents. */
function writeTree(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
}

/** The shape of an Xcode 15+ Debug simulator build (ENABLE_DEBUG_DYLIB=YES). */
const debugBuild = (dylib: string): Record<string, string> => ({
  'ShopNotes': 'stub executable that never changes',
  'ShopNotes.debug.dylib': dylib,
  '__preview.dylib': 'preview',
  'Info.plist': '<plist>1</plist>',
  'PkgInfo': 'APPL????',
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-bundle-match-'));
  installed = path.join(root, 'installed', 'ShopNotes.app');
  candidate = path.join(root, 'candidate', 'ShopNotes.app');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('appBundlesMatch', () => {
  it('matches a byte-identical bundle', async () => {
    const files = { ...debugBuild('code v1'), 'Frameworks/React.framework/React': 'react', 'empty.txt': '' };
    writeTree(installed, files);
    writeTree(candidate, files);
    expect(await appBundlesMatch(installed, candidate)).toBe(true);
  });

  it('matches bundles that each hold an empty directory at the same path', async () => {
    writeTree(installed, debugBuild('code v1'));
    writeTree(candidate, debugBuild('code v1'));
    fs.mkdirSync(path.join(installed, 'Plugins'));
    fs.mkdirSync(path.join(candidate, 'Plugins'));
    expect(await appBundlesMatch(installed, candidate)).toBe(true);
  });

  // PILOT-913: the Debug stub executable is identical across rebuilds; the
  // app's code is in <App>.debug.dylib.
  it('does not match a Debug rebuild whose only change is the debug dylib', async () => {
    writeTree(installed, debugBuild('code: Welcome'));
    writeTree(candidate, debugBuild('code: Welcome back'));
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('does not match when only Info.plist differs', async () => {
    writeTree(installed, debugBuild('code'));
    writeTree(candidate, { ...debugBuild('code'), 'Info.plist': '<plist>2</plist>' });
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('does not match when a file differs in content but not in size', async () => {
    writeTree(installed, { ...debugBuild('code'), 'main.jsbundle': 'aaaa' });
    writeTree(candidate, { ...debugBuild('code'), 'main.jsbundle': 'aaab' });
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('does not match when a large file differs only past the first read chunk', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    const changed = Buffer.from(big);
    changed[changed.length - 1] = 8;
    writeTree(installed, { ...debugBuild('code'), 'Frameworks/hermes.framework/hermes': big });
    writeTree(candidate, { ...debugBuild('code'), 'Frameworks/hermes.framework/hermes': changed });
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('matches large identical files read across several chunks', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    writeTree(installed, { ...debugBuild('code'), 'Frameworks/hermes.framework/hermes': big });
    writeTree(candidate, { ...debugBuild('code'), 'Frameworks/hermes.framework/hermes': Buffer.from(big) });
    expect(await appBundlesMatch(installed, candidate)).toBe(true);
  });

  it('does not match when the candidate adds a file, even a nested one', async () => {
    writeTree(installed, debugBuild('code'));
    writeTree(candidate, { ...debugBuild('code'), 'Frameworks/New.framework/New': 'new' });
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('does not match when the candidate drops a file the installed bundle has', async () => {
    writeTree(installed, { ...debugBuild('code'), 'assets/logo.png': 'png' });
    writeTree(candidate, debugBuild('code'));
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('does not match when a path is a file in one bundle and a directory in the other', async () => {
    writeTree(installed, { ...debugBuild('code'), 'Settings.bundle': 'file' });
    writeTree(candidate, { ...debugBuild('code'), 'Settings.bundle/Root.plist': 'file' });
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('compares symlinks by their target and never follows them', async () => {
    writeTree(installed, debugBuild('code'));
    writeTree(candidate, debugBuild('code'));
    // A link out of the bundle to content that differs: following it would
    // read outside the bundle; comparing the link itself says they match.
    writeTree(root, { 'outside-a/data': 'a', 'outside-b/data': 'b' });
    fs.symlinkSync('../../outside-a', path.join(installed, 'Linked'));
    fs.symlinkSync('../../outside-a', path.join(candidate, 'Linked'));
    expect(await appBundlesMatch(installed, candidate)).toBe(true);

    fs.unlinkSync(path.join(candidate, 'Linked'));
    fs.symlinkSync('../../outside-b', path.join(candidate, 'Linked'));
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
  });

  it('does not match when either bundle is missing or not a directory', async () => {
    writeTree(candidate, debugBuild('code'));
    expect(await appBundlesMatch(installed, candidate)).toBe(false);
    expect(await appBundlesMatch(candidate, installed)).toBe(false);

    const file = path.join(root, 'not-a-bundle');
    fs.writeFileSync(file, 'x');
    expect(await appBundlesMatch(file, file)).toBe(false);
  });
});
