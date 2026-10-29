import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TSCONFIG_JSON, writeTsconfig, writeTsconfigOrWarn } from '../init-tsconfig.js';
import { fencedBlocksIn, REPO } from './doc-samples.js';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-tsconfig-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const read = (dir: string, name = 'tsconfig.json'): string => fs.readFileSync(path.join(dir, name), 'utf8');

describe('writeTsconfig() (PILOT-838)', () => {
  it('writes a tsconfig.json covering the config and the tests when the project has none', () => {
    const dir = tmp();
    expect(writeTsconfig(dir)).toBe('created');
    const written = read(dir);
    expect(written).toBe(TSCONFIG_JSON);
    // Plain JSON, so any tool can read it.
    const parsed = JSON.parse(written) as { compilerOptions: Record<string, unknown>; include: string[] };
    expect(parsed.include).toEqual(['tapsmith.config.ts', 'tests', '**/*.tapsmith.ts']);
    expect(parsed.compilerOptions).toMatchObject({ noEmit: true, strict: true, moduleResolution: 'Bundler' });
  });

  it('leaves an existing tsconfig.json untouched', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "extends": "expo/tsconfig.base" }\n');
    expect(writeTsconfig(dir)).toBe('present');
    expect(read(dir)).toBe('{ "extends": "expo/tsconfig.base" }\n');
  });

  it('writes none beside a jsconfig.json, which a new tsconfig.json would shadow', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'jsconfig.json'), '{}\n');
    expect(writeTsconfig(dir)).toBe('present');
    expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(false);
  });

  it('leaves anything else named tsconfig.json alone', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'tsconfig.json'));
    expect(writeTsconfig(dir)).toBe('present');
  });

  it('throws when tsconfig.json cannot be written', () => {
    expect(() => writeTsconfig(path.join(tmp(), 'no-such-dir'))).toThrow(/ENOENT/);
  });
});

describe('writeTsconfigOrWarn() (PILOT-838)', () => {
  it('turns a write failure into a warning naming what the file is for', () => {
    const result = writeTsconfigOrWarn(path.join(tmp(), 'no-such-dir'));
    expect(result).toEqual({ warning: expect.stringMatching(/^Could not write tsconfig\.json \(.+\): type-aware tools such as typescript-eslint need one that includes your tests/) });
  });

  it('passes through created and present', () => {
    const dir = tmp();
    expect(writeTsconfigOrWarn(dir)).toBe('created');
    expect(writeTsconfigOrWarn(dir)).toBe('present');
  });
});

describe('the tsconfig.json in the ESLint docs (PILOT-838)', () => {
  it('is the one init writes', () => {
    const rel = 'docs/locators.md';
    const json = fencedBlocksIn(rel, fs.readFileSync(path.join(REPO, rel), 'utf8')).filter((b) => b.lang === 'json');
    expect(json.map((b) => JSON.parse(b.code) as unknown)).toContainEqual(JSON.parse(TSCONFIG_JSON));
  });
});
