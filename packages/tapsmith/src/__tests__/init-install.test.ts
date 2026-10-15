import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripAnsi } from '../cli-json.js';
import type { InstallCommand } from '../config.js';

// `npx tapsmith init` and a global install write a config and example test
// importing `tapsmith` into a project that may not have it, so the next step
// failed with "Cannot find module 'tapsmith'" (PILOT-551).

interface Question { type: string; message: string; initial?: unknown }
const questions: Question[] = [];
let answer: unknown = true;
vi.mock('enquirer', () => ({
  default: class {
    prompt(question: Question): Promise<Record<string, unknown>> {
      questions.push(question);
      return Promise.resolve({ _: answer });
    }
  },
}));

const { offerTapsmithInstall, warnIfAndroidAgentMissing } = await import('../init.js');

let dir: string;
let logged: string[];
let ran: Array<{ command: InstallCommand; cwd: string }>;
let runResult: true | string;
const run = (command: InstallCommand, cwd: string): true | string => {
  ran.push({ command, cwd });
  return runResult;
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-install-')));
  questions.length = 0;
  answer = true;
  ran = [];
  runResult = true;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(stripAnsi(args.join(' '))); });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function installTapsmithStub(): void {
  const pkg = path.join(dir, 'node_modules', 'tapsmith');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{ "name": "tapsmith", "exports": { ".": { "default": "./index.js" } } }\n');
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export {};\n');
}

describe('offerTapsmithInstall()', () => {
  it('asks nothing when the project already has tapsmith', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    installTapsmithStub();
    expect(await offerTapsmithInstall(dir, run)).toBeUndefined();
    expect(questions).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("offers the project's package manager's install, yes by default, and runs it", async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(await offerTapsmithInstall(dir, run)).toBeUndefined();
    expect(questions).toHaveLength(1);
    expect(questions[0].type).toBe('confirm');
    expect(questions[0].initial).toBe(true);
    expect(questions[0].message).toContain('yarn add -D tapsmith');
    expect(ran).toEqual([{ command: { command: 'yarn', args: ['add', '-D', 'tapsmith'], display: 'yarn add -D tapsmith' }, cwd: dir }]);
    expect(logged.join('\n')).toContain('✓ Tapsmith installed');
  });

  it('returns the command for Next steps when declined', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    answer = false;
    expect(await offerTapsmithInstall(dir, run)).toBe('npm i -D tapsmith');
    expect(ran).toEqual([]);
  });

  it('warns and returns the command when the install fails', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    runResult = 'npm exited with code 1';
    expect(await offerTapsmithInstall(dir, run)).toBe('npm i -D tapsmith');
    expect(logged.join('\n')).toContain('⚠ Could not install Tapsmith: npm exited with code 1');
  });

  // PILOT-560: pnpm 11+ installs everything, then exits 1 over the build
  // scripts it skipped (ERR_PNPM_IGNORED_BUILDS: esbuild, protobufjs).
  it('counts the install as done when the command failed but tapsmith resolves, and gives pnpm its allowBuilds snippet', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const failingButInstalled = (command: InstallCommand, cwd: string): true | string => {
      ran.push({ command, cwd });
      installTapsmithStub();
      return 'pnpm exited with code 1';
    };
    expect(await offerTapsmithInstall(dir, failingButInstalled)).toBeUndefined();
    expect(ran[0]!.command.display).toBe('pnpm add -D tapsmith');
    const out = logged.join('\n');
    expect(out).toContain('✓ Tapsmith installed');
    expect(out).not.toContain('Could not install');
    expect(out).toContain('pnpm exited with code 1');
    expect(out).toContain('pnpm-workspace.yaml');
    expect(out).toMatch(/allowBuilds:\n\s+esbuild: false\n\s+protobufjs: false/);
  });

  it('gives no pnpm snippet to another package manager whose install failed after installing', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    const failingButInstalled = (): true | string => { installTapsmithStub(); return 'npm exited with code 1'; };
    expect(await offerTapsmithInstall(dir, failingButInstalled)).toBeUndefined();
    const out = logged.join('\n');
    expect(out).toContain('✓ Tapsmith installed');
    expect(out).not.toContain('allowBuilds');
  });

  // npm installs into the nearest ancestor with a package.json, which is not
  // necessarily this project: leave that to the user.
  it('does not offer to install without a package.json here, but still names the command', async () => {
    expect(await offerTapsmithInstall(dir, run)).toBe('npm init -y && npm i -D tapsmith');
    expect(questions).toEqual([]);
    expect(ran).toEqual([]);
  });

  // PILOT-631: a bare `npm i -D tapsmith` there would change the parent project.
  it('says there is no package.json here and names the parent a bare install would change', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    const app = path.join(dir, 'app');
    fs.mkdirSync(app);
    const step = await offerTapsmithInstall(app, run);
    expect(step).toBe('npm init -y && npm i -D tapsmith');
    expect(questions).toEqual([]);
    expect(ran).toEqual([]);
    expect(logged.join('\n')).toContain(`⚠ There's no package.json in ${app}: on its own, \`npm i -D tapsmith\` would add Tapsmith to ${dir} instead. If that is this project's root, run it there; otherwise create a package.json here first.`);
  });
});

// PILOT-709: pnpm 11+ skipped @tapsmith/agent-android, and init said nothing.
describe('warnIfAndroidAgentMissing()', () => {
  it('warns with the project\'s install command when its tapsmith has no agent package', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    installTapsmithStub();
    await warnIfAndroidAgentMissing(dir);
    expect(logged.join('\n')).toMatch(/⚠ Android agent not found — @tapsmith\/agent-android.*pnpm 11.*\n.*Run: pnpm add -D @tapsmith\/agent-android/);
  });

  it('says nothing when the agent package is installed', async () => {
    installTapsmithStub();
    const agent = path.join(dir, 'node_modules', '@tapsmith', 'agent-android');
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, 'package.json'), '{ "name": "@tapsmith/agent-android" }\n');
    await warnIfAndroidAgentMissing(dir);
    expect(logged).toEqual([]);
  });

  it('says nothing when the project has no tapsmith (the install step already said so)', async () => {
    await warnIfAndroidAgentMissing(dir);
    expect(logged).toEqual([]);
  });
});
