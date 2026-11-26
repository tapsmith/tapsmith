import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { pnpmAllowBuildsMessage, pnpmRoot, pnpmUndecidedBuilds, writePnpmAllowBuilds } from '../init-pnpm-builds.js';

// PILOT-930: pnpm 11+ exits 1 after installing Tapsmith over esbuild's and
// protobufjs's build scripts, which only the project can approve or deny,
// so init denies them in the project's pnpm-workspace.yaml.

let dir: string;
let asked: number;
const pnpm = (major: number | undefined) => ({ agent: 'pnpm', pnpmMajor: () => { asked++; return major; } });
const ws = (d = dir): string => path.join(d, 'pnpm-workspace.yaml');
const read = (d = dir): string => fs.readFileSync(ws(d), 'utf8');

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-pnpm-builds-')));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "app" }\n');
  asked = 0;
});

afterEach(() => {
  try { fs.chmodSync(dir, 0o755); } catch { /* removed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writePnpmAllowBuilds()', () => {
  it('leaves a project that does not use pnpm alone', () => {
    expect(writePnpmAllowBuilds(dir, { agent: 'npm', pnpmMajor: () => 12 })).toEqual({ status: 'not-pnpm' });
    expect(writePnpmAllowBuilds(dir, { agent: 'yarn@berry', pnpmMajor: () => 12 })).toEqual({ status: 'not-pnpm' });
    expect(fs.existsSync(ws())).toBe(false);
  });

  it('creates pnpm-workspace.yaml denying both builds on pnpm 11 and later', () => {
    const outcome = writePnpmAllowBuilds(dir, pnpm(11));
    expect(outcome).toEqual({ status: 'written', file: 'pnpm-workspace.yaml', created: true, names: ['esbuild', 'protobufjs'] });
    expect(read()).toBe('allowBuilds:\n  esbuild: false\n  protobufjs: false\n');
  });

  // pnpm 9.15 and 10.0 reject a pnpm-workspace.yaml without `packages`
  // ("packages field missing or empty"); pnpm 10 only warns about the scripts.
  it.each([[10], [9], [undefined]])('creates no file when pnpm is %s', (major) => {
    expect(writePnpmAllowBuilds(dir, pnpm(major))).toEqual({ status: 'skipped' });
    expect(fs.existsSync(ws())).toBe(false);
  });

  it('adds the entries to an existing workspace file, keeping its comments and settings', () => {
    fs.writeFileSync(ws(), '# workspace\npackages:\n  - apps/*   # the apps\n\nallowBuilds:\n  sharp: true\n');
    const outcome = writePnpmAllowBuilds(dir, pnpm(11));
    expect(outcome).toMatchObject({ status: 'written', created: false, names: ['esbuild', 'protobufjs'] });
    const text = read();
    expect(text).toContain('# workspace');
    expect(text).toContain('# the apps');
    expect(parse(text)).toEqual({ packages: ['apps/*'], allowBuilds: { sharp: true, esbuild: false, protobufjs: false } });
  });

  // pnpm 10 still reads onlyBuiltDependencies, which allowBuilds overrides.
  it.each([[10], [undefined]])('leaves an existing workspace file alone when pnpm is %s', (major) => {
    const text = 'onlyBuiltDependencies:\n  - esbuild\n';
    fs.writeFileSync(ws(), text);
    expect(writePnpmAllowBuilds(dir, pnpm(major))).toEqual({ status: 'skipped' });
    expect(read()).toBe(text);
  });

  it("asks pnpm's version only when there is something to write", () => {
    fs.writeFileSync(ws(), 'allowBuilds:\n  esbuild: false\n  protobufjs: false\n');
    expect(writePnpmAllowBuilds(dir, pnpm(10))).toEqual({ status: 'present' });
    expect(asked).toBe(0);
  });

  it('adds an allowBuilds mapping to a workspace file without one, or with an empty one', () => {
    fs.writeFileSync(ws(), 'packages:\n  - "."\n');
    writePnpmAllowBuilds(dir, pnpm(12));
    expect(parse(read())).toEqual({ packages: ['.'], allowBuilds: { esbuild: false, protobufjs: false } });

    fs.writeFileSync(ws(), 'allowBuilds:\n');
    writePnpmAllowBuilds(dir, pnpm(12));
    expect(parse(read())).toEqual({ allowBuilds: { esbuild: false, protobufjs: false } });
  });

  it('fills an empty workspace file', () => {
    fs.writeFileSync(ws(), '');
    expect(writePnpmAllowBuilds(dir, pnpm(12))).toMatchObject({ status: 'written', created: false });
    expect(parse(read())).toEqual({ allowBuilds: { esbuild: false, protobufjs: false } });
  });

  // pnpm 11.11 writes these itself after an install it failed.
  it("replaces pnpm's own placeholders instead of adding a second allowBuilds", () => {
    fs.writeFileSync(ws(), 'allowBuilds:\n  esbuild: set this to true or false\n  protobufjs: set this to true or false\n');
    expect(writePnpmAllowBuilds(dir, pnpm(11))).toMatchObject({ status: 'written', names: ['esbuild', 'protobufjs'] });
    expect(read()).toBe('allowBuilds:\n  esbuild: false\n  protobufjs: false\n');
  });

  it("keeps the project's own decisions", () => {
    fs.writeFileSync(ws(), 'allowBuilds:\n  esbuild: true\n');
    expect(writePnpmAllowBuilds(dir, pnpm(12))).toMatchObject({ status: 'written', names: ['protobufjs'] });
    expect(parse(read())).toEqual({ allowBuilds: { esbuild: true, protobufjs: false } });
  });

  it('writes nothing when both are decided already', () => {
    const text = '# mine\nallowBuilds:\n  esbuild: false\n  "protobufjs@7.6.6": true\n';
    fs.writeFileSync(ws(), text);
    expect(writePnpmAllowBuilds(dir, pnpm(12))).toEqual({ status: 'present' });
    expect(read()).toBe(text);
  });

  it('writes nothing when the project allows every build', () => {
    fs.writeFileSync(ws(), 'dangerouslyAllowAllBuilds: true\n');
    expect(writePnpmAllowBuilds(dir, pnpm(12))).toEqual({ status: 'present' });
  });

  // pnpm 11+ reads build decisions only from allowBuilds (and
  // dangerouslyAllowAllBuilds) in pnpm-workspace.yaml.
  it("does not count pnpm 10's build lists or package.json's pnpm field as decisions", () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "pnpm": { "onlyBuiltDependencies": ["esbuild"], "dangerouslyAllowAllBuilds": true } }\n');
    fs.writeFileSync(ws(), 'onlyBuiltDependencies:\n  - esbuild\nignoredBuiltDependencies: [protobufjs]\n');
    expect(writePnpmAllowBuilds(dir, pnpm(12))).toMatchObject({ status: 'written', names: ['esbuild', 'protobufjs'] });
  });

  it.each([
    ['allowBuilds: [esbuild]\n', 'allowBuilds` in it is not a mapping'],
    ['- a\n- b\n', 'its top level is not a mapping'],
    ['allowBuilds:\n  esbuild: false\n   bad: [\n', 'it is not valid YAML'],
  ])('leaves a file it cannot safely edit unchanged, with a warning: %j', (text, reason) => {
    fs.writeFileSync(ws(), text);
    const outcome = writePnpmAllowBuilds(dir, pnpm(12));
    expect(outcome.status).toBe('failed');
    const warning = (outcome as { warning: string }).warning;
    expect(warning).toContain('Left pnpm-workspace.yaml unchanged');
    expect(warning).toContain(reason);
    expect(warning).toContain('set esbuild and protobufjs to false under allowBuilds');
    expect(read()).toBe(text);
  });

  it("edits the workspace root's file from a workspace package, and names it from there", () => {
    fs.writeFileSync(ws(), 'packages:\n  - packages/*\n');
    const pkg = path.join(dir, 'packages', 'e2e');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}\n');
    const outcome = writePnpmAllowBuilds(pkg, pnpm(12));
    expect(outcome).toMatchObject({ status: 'written', file: path.join('..', '..', 'pnpm-workspace.yaml'), created: false });
    expect(fs.existsSync(ws(pkg))).toBe(false);
    expect(parse(read())).toMatchObject({ allowBuilds: { esbuild: false, protobufjs: false } });
  });

  it('creates the file beside pnpm-lock.yaml in a parent directory', () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const sub = path.join(dir, 'mobile');
    fs.mkdirSync(sub);
    expect(pnpmRoot(sub)).toBe(dir);
    expect(writePnpmAllowBuilds(sub, pnpm(12))).toMatchObject({ status: 'written', file: path.join('..', 'pnpm-workspace.yaml'), created: true });
  });

  // pnpm roots a project at its nearest package.json unless a
  // pnpm-workspace.yaml above makes it a workspace package.
  it("writes beside the project's own package.json, not beside another project's lockfile above it", () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const app = path.join(dir, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package.json'), '{}\n');
    expect(pnpmRoot(app)).toBe(app);
    expect(writePnpmAllowBuilds(app, pnpm(12))).toEqual({ status: 'written', file: 'pnpm-workspace.yaml', created: true, names: ['esbuild', 'protobufjs'] });
    expect(fs.existsSync(ws())).toBe(false);
  });

  it("uses the workspace root's file from a package that keeps its own lockfile", () => {
    fs.writeFileSync(ws(), 'packages:\n  - app\n');
    const app = path.join(dir, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(app, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    expect(pnpmRoot(app)).toBe(dir);
  });

  it('does nothing without a project', () => {
    fs.rmSync(path.join(dir, 'package.json'));
    expect(writePnpmAllowBuilds(dir, pnpm(12))).toEqual({ status: 'not-pnpm' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('turns a write failure into a warning', () => {
    fs.chmodSync(dir, 0o555);
    const outcome = writePnpmAllowBuilds(dir, pnpm(12));
    expect(outcome.status).toBe('failed');
    expect((outcome as { warning: string }).warning).toMatch(/^Could not write pnpm-workspace\.yaml \(.+\)\. pnpm 11 and later exit 1/);
  });
});

describe('pnpmUndecidedBuilds()', () => {
  it('lists what the project has still to decide', () => {
    expect(pnpmUndecidedBuilds(dir)).toEqual(['esbuild', 'protobufjs']);
    fs.writeFileSync(ws(), 'allowBuilds:\n  esbuild: false\n  protobufjs: set this to true or false\n');
    expect(pnpmUndecidedBuilds(dir)).toEqual(['protobufjs']);
    fs.writeFileSync(ws(), 'allowBuilds:\n  esbuild: false\n  protobufjs: false\n');
    expect(pnpmUndecidedBuilds(dir)).toEqual([]);
  });
});

describe('pnpmAllowBuildsMessage()', () => {
  it('says what changed, why, and to commit it', () => {
    expect(pnpmAllowBuildsMessage({ file: 'pnpm-workspace.yaml', created: true, names: ['esbuild', 'protobufjs'] }))
      .toBe("pnpm-workspace.yaml created: esbuild and protobufjs set to false under allowBuilds (Tapsmith doesn't need their build scripts; without this, pnpm 11+ installs exit 1). Commit it so CI installs pass too");
  });
});
