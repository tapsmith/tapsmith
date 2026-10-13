/**
 * What a run and doctor say when the Android agent APKs are missing
 * (PILOT-709): pnpm 11+ skipped @tapsmith/agent-android, and the old advice
 * named config keys and `npm install` whatever the project used.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { androidAgentInstalledFor, missingAndroidAgentAdvice, missingAndroidAgentError } from '../agent-resolve.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-agent-advice-')));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The daemon's AGENT_NOT_INSTALLED message (grpc_server.rs).
const DAEMON_MESSAGE = 'Tapsmith agent is not installed on the device. Set agentApk and agentTestApk in your Tapsmith config, or install manually with: adb install <path-to-agent.apk>';

describe('missingAndroidAgentAdvice()', () => {
  it('installs the package with the project\'s package manager and says pnpm skipped it', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const advice = await missingAndroidAgentAdvice(dir);
    expect(advice.install).toBe('pnpm add -D @tapsmith/agent-android');
    expect(advice.why).toContain('@tapsmith/agent-android');
    expect(advice.why).toContain('pnpm 11');
  });

  it('names npm and optional-dependency omission for an npm project', async () => {
    const advice = await missingAndroidAgentAdvice(dir);
    expect(advice.install).toBe('npm i -D @tapsmith/agent-android');
    expect(advice.why).toContain('optional dependenc');
    expect(advice.why).not.toContain('pnpm');
  });

  it('follows yarn', async () => {
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect((await missingAndroidAgentAdvice(dir)).install).toBe('yarn add -D @tapsmith/agent-android');
  });
});

describe('missingAndroidAgentError()', () => {
  it('replaces the daemon\'s advice when there was no APK to install', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const message = await missingAndroidAgentError(DAEMON_MESSAGE, {}, dir);
    expect(message).toContain('not installed on the device');
    expect(message).toContain('`pnpm add -D @tapsmith/agent-android`');
    expect(message).toContain('pnpm 11');
    expect(message).not.toContain('adb install');
  });

  it('also when only one of the two APKs was found', async () => {
    const message = await missingAndroidAgentError(DAEMON_MESSAGE, { agentApkPath: '/a.apk' }, dir);
    expect(message).toContain('`npm i -D @tapsmith/agent-android`');
  });

  it('leaves the error alone when both APKs were handed to the daemon', async () => {
    expect(await missingAndroidAgentError(DAEMON_MESSAGE, { agentApkPath: '/a.apk', agentTestApkPath: '/t.apk' }, dir)).toBeUndefined();
  });

  it('leaves any other agent-start failure alone', async () => {
    expect(await missingAndroidAgentError('Agent did not connect within 30s', {}, dir)).toBeUndefined();
  });
});

// init checks the project's own install, not the copy of Tapsmith running it
// (`npx tapsmith init` runs one from the npx cache).
describe('androidAgentInstalledFor()', () => {
  function write(rel: string, content: string): void {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  function installTapsmith(at = 'node_modules/tapsmith'): void {
    write(`${at}/package.json`, '{ "name": "tapsmith", "exports": { ".": { "default": "./dist/index.js" } } }\n');
    write(`${at}/dist/index.js`, 'export {};\n');
  }

  it('is undefined when the project has no tapsmith', () => {
    expect(androidAgentInstalledFor(dir)).toBeUndefined();
  });

  it('is false when tapsmith cannot resolve the agent package', () => {
    installTapsmith();
    expect(androidAgentInstalledFor(dir)).toBe(false);
  });

  it('is true when the agent package sits beside tapsmith (npm, yarn)', () => {
    installTapsmith();
    write('node_modules/@tapsmith/agent-android/package.json', '{ "name": "@tapsmith/agent-android" }\n');
    expect(androidAgentInstalledFor(dir)).toBe(true);
  });

  it('is true when only tapsmith\'s own node_modules has it (pnpm\'s layout)', () => {
    installTapsmith('node_modules/.pnpm/tapsmith@1.0.0/node_modules/tapsmith');
    write('node_modules/.pnpm/tapsmith@1.0.0/node_modules/@tapsmith/agent-android/package.json', '{ "name": "@tapsmith/agent-android" }\n');
    fs.symlinkSync(path.join(dir, 'node_modules/.pnpm/tapsmith@1.0.0/node_modules/tapsmith'), path.join(dir, 'node_modules/tapsmith'));
    expect(androidAgentInstalledFor(dir)).toBe(true);
  });
});
