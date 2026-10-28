import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvScan } from '../env-scan.js';
import type { InitCommandOptions } from '../cli-program.js';
import { stripAnsi } from '../cli-json.js';

// The interactive wizard, end to end, when a file it writes cannot be
// written (PILOT-624): it used to print "Failed to write tapsmith.config.ts",
// then write the rest, print Next steps and exit 0.

// ─── Mocks ───

interface Question { type: string; message: string; choices?: Array<{ name: string }> }
const answers = new Map<RegExp, unknown>();
const questions: string[] = [];
vi.mock('enquirer', () => ({
  default: class {
    prompt(question: Question): Promise<Record<string, unknown>> {
      questions.push(question.message);
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
vi.mock('../env-scan.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../env-scan.js')>(),
  scanEnvironment: () => env,
}));

const APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
vi.mock('../init-detect.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../init-detect.js')>(),
  findApkCandidates: () => [APK],
  detectAndroidPackage: () => 'com.acme.app',
  detectExpoProject: () => undefined,
}));

const { runInit } = await import('../init.js');

// ─── Harness ───

const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const startCwd = process.cwd();
let dir: string;
let out: string[];
const locked: string[] = [];

function lock(p: string): void {
  fs.chmodSync(p, 0o555);
  locked.push(p);
}

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
  process.chdir(startCwd);
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const p of locked.splice(0)) fs.chmodSync(p, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Tests ───

describe('init wizard when a file cannot be written (PILOT-624)', () => {
  it('writes the config, example test, AGENTS.md and .gitignore when it can', async () => {
    const { exit, output } = await wizard();
    expect(exit).toBeUndefined();
    expect(fs.readdirSync(dir).sort()).toEqual(['.gitignore', 'AGENTS.md', 'tapsmith.config.ts', 'tests']);
    expect(output).toContain('✓ tapsmith.config.ts created');
    expect(output).toContain('✓ tests/example.tapsmith.ts created');
    expect(output).toContain('✓ AGENTS.md updated');
    expect(output).toContain('Next steps');
  });

  it.skipIf(!canDenyWrites)('stops at an unwritable config path: writes nothing, prints the fix, exits 1', async () => {
    lock(dir);
    const { exit, output } = await wizard();
    expect(exit).toBe('exit 1');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(output).toMatch(/✗ Could not write tapsmith\.config\.ts: .* is not writable\. Nothing was written\./);
    expect(output).toContain(`→ Give yourself write access to ${dir} (check its permissions and owner, or whether the filesystem is read-only), then run init again`);
    expect(output).not.toContain('Next steps');
    expect(output).not.toContain('created');
    // Found before the first question, not after the user has answered them all.
    expect(questions).toEqual([]);
  });

  it.skipIf(!canDenyWrites)('stops at an unwritable tests/ before writing the config', async () => {
    fs.mkdirSync(path.join(dir, 'tests'));
    lock(path.join(dir, 'tests'));
    const { exit, output } = await wizard();
    expect(exit).toBe('exit 1');
    expect(fs.readdirSync(dir)).toEqual(['tests']);
    expect(output).toContain('✗ Could not write tests/example.tapsmith.ts');
    expect(output).toContain('answer no to the example test');
    expect(output).not.toContain('Next steps');
  });

  // Declining needs no write access, so a read-only project that already
  // has a config keeps its old answer: "Keeping existing config", exit 0.
  it.skipIf(!canDenyWrites)('asks about an existing config before checking the project can be written', async () => {
    fs.writeFileSync(path.join(dir, 'tapsmith.config.ts'), '// existing');
    lock(dir);
    answers.set(/Overwrite it/, false);
    const { exit, output } = await wizard();
    expect(exit).toBeUndefined();
    expect(output).toContain('Keeping existing config');
    expect(fs.readFileSync(path.join(dir, 'tapsmith.config.ts'), 'utf8')).toBe('// existing');
  });

  it.skipIf(!canDenyWrites)('keeps the config it was told to overwrite when the new one cannot be written', async () => {
    fs.writeFileSync(path.join(dir, 'tapsmith.config.ts'), '// existing');
    answers.set(/Overwrite it/, true);
    lock(dir);
    const { exit } = await wizard();
    expect(exit).toBe('exit 1');
    expect(fs.readFileSync(path.join(dir, 'tapsmith.config.ts'), 'utf8')).toBe('// existing');
  });
});

describe('init wizard with a build skipped (PILOT-778)', () => {
  const answer = (pattern: RegExp, value: unknown): void => {
    for (const key of [...answers.keys()]) if (key.source === pattern.source) answers.delete(key);
    // Ahead of the defaults: the first matching pattern answers.
    const rest = [...answers];
    answers.clear();
    answers.set(pattern, value);
    for (const [k, v] of rest) answers.set(k, v);
  };

  afterEach(() => {
    Object.assign(env, { isMacOS: false, xcodeVersion: undefined, simulators: [] });
  });

  it('a lone platform with nothing set up still gets a config, with placeholders and a next step to fill them', async () => {
    answer(/Where is your Android APK/, 'Skip for now');
    answer(/package name/, '');
    const { exit, output } = await wizard();
    expect(exit).toBeUndefined();
    const config = fs.readFileSync(path.join(dir, 'tapsmith.config.ts'), 'utf8');
    expect(config).toContain("// apk: '<path to your .apk>',");
    expect(config).toContain("// package: '<applicationId>',");
    expect(output).toMatch(/Point it at your app:\s+build your app, then set apk and package in tapsmith\.config\.ts/);
    expect(output.indexOf('Point it at your app')).toBeLessThan(output.indexOf('Verify your setup'));
  });

  it('Both with the iOS build and bundle id skipped writes an Android-only config and says why iOS is missing', async () => {
    Object.assign(env, { isMacOS: true, xcodeVersion: '26.0', simulators: [{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26.0' }] });
    answer(/Which platform/, 'both');
    answer(/How will you run iOS tests/, 'simulators');
    answer(/simulator build\)/, '');
    answer(/Which simulator/, 'iPhone 17');
    answer(/bundle identifier/, '');
    const { exit, output } = await wizard();
    expect(exit).toBeUndefined();
    const config = fs.readFileSync(path.join(dir, 'tapsmith.config.ts'), 'utf8');
    expect(config).not.toContain('projects');
    expect(config).not.toContain("platform: 'ios'");
    expect(config).toContain("package: 'com.acme.app',");
    expect(output).toContain('iOS left out of the config: it has no build or bundle identifier yet');
    expect(output).not.toContain('Point it at your app');
    expect(output).not.toContain('--project');
  });
});
