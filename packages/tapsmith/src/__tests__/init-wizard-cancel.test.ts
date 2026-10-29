import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvScan } from '../env-scan.js';
import type { InitCommandOptions } from '../cli-program.js';
import { stripAnsi } from '../cli-json.js';

// The interactive wizard, end to end, when the user cancels a prompt with
// Ctrl-C or Esc (PILOT-518): it says "Setup cancelled." and exits 130, and
// every prompt carries the guard that keeps Ctrl-C from crashing enquirer on
// Node 24 (prompt-cancel.test.ts covers the guard on real prompts).

// ─── Mocks ───

interface Question { type: string; message: string; choices?: Array<{ name: string }>; onRun?: unknown }
let cancelAt: RegExp | undefined;
const guards: unknown[] = [];
const answers = new Map<RegExp, unknown>();
const questions: string[] = [];
vi.mock('enquirer', () => ({
  default: class {
    prompt(question: Question): Promise<Record<string, unknown>> {
      questions.push(question.message);
      guards.push(question.onRun);
      // enquirer rejects a cancelled prompt with an empty reason.
      if (cancelAt?.test(question.message)) return Promise.reject('');
      for (const [pattern, answer] of answers) {
        if (pattern.test(question.message)) return Promise.resolve({ _: answer });
      }
      return Promise.reject(new Error(`unexpected prompt: ${question.message}`));
    }
  },
}));

const env: EnvScan = {
  nodeVersion: '22.0.0',
  rosettaWarning: undefined,
  daemonBin: undefined,
  agentApk: false,
  agentTestApk: false,
  adbVersion: '1.0.41',
  androidHome: undefined,
  xcodeVersion: undefined,
  simulators: [],
  avds: ['Pixel_API_36'],
  avdImages: [{ name: 'Pixel_API_36', tagId: 'google_apis' }],
  isMacOS: false,
};
const androidOnly = { ...env };
vi.mock('../env-scan.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../env-scan.js')>(),
  scanEnvironment: () => env,
}));

const APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
const IOS_APP = 'ios/build/Build/Products/Debug-iphonesimulator/App.app';
vi.mock('../init-detect.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../init-detect.js')>(),
  findApkCandidates: () => [APK],
  detectAndroidPackage: () => 'com.acme.app',
  detectExpoProject: () => undefined,
  findIosAppCandidates: () => [IOS_APP],
  detectIosBundleId: () => 'com.acme.app',
}));
// No simulator agent built yet, so the wizard offers to build one.
vi.mock('../ios-device-resolve.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ios-device-resolve.js')>(),
  findSimulatorXctestrun: () => undefined,
}));

const { runInit } = await import('../init.js');
const { tolerateClosedReadline } = await import('../prompt-cancel.js');

// ─── Harness ───

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const startCwd = process.cwd();
let dir: string;
let out: string[];

async function wizard(): Promise<{ exit: unknown; output: string }> {
  const opts: InitCommandOptions = { yes: false, json: false, force: false, exampleTest: true, agentsMd: true };
  const exit = await runInit(opts).then(() => undefined, (err: unknown) => (err as Error).message);
  return { exit, output: out.join('\n') };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-wizard-write-')));
  process.chdir(dir);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  out = [];
  questions.length = 0;
  guards.length = 0;
  cancelAt = undefined;
  answers.clear();
  answers.set(/Which platform/, 'android');
  answers.set(/Where is your Android APK/, APK);
  answers.set(/How will you run Android tests/, 'emulators');
  answers.set(/Which AVD/, 'Pixel_API_36');
  answers.set(/Enable network trace capture/, false);
  answers.set(/Generate example test file/, true);
  answers.set(/AGENTS\.md/, true);
  answers.set(/Install/, false);
  const record = (...args: unknown[]): void => { out.push(stripAnsi(args.join(' '))); };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(env, androidOnly);
  process.chdir(startCwd);
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Tests ───

describe('init wizard cancelled at a prompt (PILOT-518)', () => {
  it('guards every prompt it asks against the Node 24 Ctrl-C crash', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    const { exit } = await wizard();
    expect(exit).toBeUndefined();
    expect(questions.length).toBeGreaterThan(5);
    expect(guards).toEqual(questions.map(() => tolerateClosedReadline));
  });

  for (const [prompt, pattern] of [
    ['the platform select', /Which platform/],
    ['the APK path prompt', /Where is your Android APK/],
    ['the AVD select', /Which AVD/],
    ['the last question before writing', /AGENTS\.md/],
  ] as const) {
    it(`at ${prompt}: says "Setup cancelled.", writes nothing and exits 130`, async () => {
      cancelAt = pattern;
      const { exit, output } = await wizard();
      expect(exit).toBe('exit 130');
      // The last thing it prints: no error line after it.
      expect(output.trimEnd().split('\n').at(-1)).toBe('  Setup cancelled.');
      expect(output).not.toContain('Next steps');
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  }

  it('at the install offer, after the files are written: says they are written and how to install', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    cancelAt = /Install/;
    const { exit, output } = await wizard();
    expect(exit).toBe('exit 130');
    expect(output).toContain('✓ tapsmith.config.ts created');
    expect(output).toMatch(/Setup cancelled\. The files above are written, but Tapsmith is not installed: run \S.* tapsmith$/m);
    expect(output).not.toContain('Next steps');
    expect(fs.readdirSync(dir).sort()).toEqual(['.gitignore', 'AGENTS.md', 'package.json', 'tapsmith.config.ts', 'tests', 'tsconfig.json']);
  });

  it('at the iOS simulator agent build offer: stops there instead of carrying on', async () => {
    Object.assign(env, { isMacOS: true, xcodeVersion: '27.0', simulators: [{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26.0' }] });
    for (const pattern of answers.keys()) if (pattern.source === 'Which platform') answers.delete(pattern);
    answers.set(/Which platform/, 'ios');
    answers.set(/How will you run iOS tests/, 'simulators');
    answers.set(/Where is your iOS \.app/, IOS_APP);
    answers.set(/Which simulator/, 'iPhone 17');
    cancelAt = /Build it now/;
    const { exit, output } = await wizard();
    expect(questions.at(-1)).toMatch(/Build it now/);
    expect(exit).toBe('exit 130');
    expect(output.trimEnd().split('\n').at(-1)).toBe('  Setup cancelled.');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
