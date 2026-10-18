import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TapsmithConfig } from '../config.js';
import { tapsmithPackageVersion } from '../ios-agent-paths.js';

// PILOT-264: the MCP server starts the iOS agent itself (its run_tests
// children adopt it), so its xctestrun must resolve the way every other run
// path does — the npm device build for a physical device, a missing hand-set
// path refused — not through a simulator-only lookup of its own.

const mocks = vi.hoisted(() => ({ physical: new Set<string>() }));

vi.mock('../ios-devicectl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-devicectl.js')>()),
  isPhysicalDevice: vi.fn((serial: string) => mocks.physical.has(serial)),
}));

vi.mock('../ios-device-resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-device-resolve.js')>()),
  findSimulatorXctestrun: vi.fn(() => undefined),
}));

vi.mock('../ios-simulator-build.js', () => ({
  ensureSimulatorAgent: vi.fn(async () => '/derived/Sim_iphonesimulator27.0-arm64.xctestrun'),
}));

const { iosXctestrunForAgentStart } = await import('../mcp/connection.js');

let tmp: string;
let savedHome: string | undefined;
let savedEnv: string | undefined;

function config(over: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000, retries: 0, screenshot: 'never', testMatch: [], daemonAddress: 'localhost:50051',
    rootDir: path.join(tmp, 'project'), outputDir: 'out', workers: 1, launchEmulators: false,
    platform: 'ios', package: 'com.example.app', app: './App.app',
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-mcp-xctestrun-')));
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.mkdirSync(path.join(tmp, 'project'));
  savedHome = process.env.HOME;
  process.env.HOME = path.join(tmp, 'home');
  savedEnv = process.env.TAPSMITH_IOS_XCTESTRUN;
  delete process.env.TAPSMITH_IOS_XCTESTRUN;
  mocks.physical.clear();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedEnv === undefined) delete process.env.TAPSMITH_IOS_XCTESTRUN;
  else process.env.TAPSMITH_IOS_XCTESTRUN = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('iosXctestrunForAgentStart', () => {
  it('a physical device gets the npm device build, not a simulator xctestrun', async () => {
    const agent = path.join(tmp, 'home', '.tapsmith', 'ios-agent');
    const products = path.join(agent, '.build-device', 'Build', 'Products');
    fs.mkdirSync(products, { recursive: true });
    fs.writeFileSync(path.join(agent, '.tapsmith-version'), tapsmithPackageVersion());
    const built = path.join(products, 'A_iphoneos26.4-arm64.xctestrun');
    fs.writeFileSync(built, '<plist/>');
    mocks.physical.add('00008110-PHYS');
    await expect(iosXctestrunForAgentStart(config(), '00008110-PHYS')).resolves.toBe(built);
  });

  it('a physical device with no build fails with the shared not-found message', async () => {
    mocks.physical.add('00008110-PHYS');
    await expect(iosXctestrunForAgentStart(config(), '00008110-PHYS'))
      .rejects.toThrow(/No device xctestrun found .*tapsmith ios build-agent/);
  });

  it('refuses a hand-set iosXctestrun that does not exist', async () => {
    await expect(iosXctestrunForAgentStart(config({ iosXctestrun: 'gone/Agent.xctestrun' }), 'SIM-1'))
      .rejects.toThrow(/The xctestrun set by `iosXctestrun` .*does not exist/);
  });

  // PILOT-485: a simulator resolves like every test run path — building the
  // agent when nothing current is cached (a first run, an upgrade) — with its
  // progress on stderr, never stdout (the stdio protocol channel).
  it('a simulator with nothing set resolves through the on-demand build, logging to stderr', async () => {
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    vi.mocked(ensureSimulatorAgent).mockImplementationOnce(async (opts) => {
      opts?.onProgress?.('Building iOS agent for SDK 27.0... (cached for future runs)');
      return '/cache/Sim_iphonesimulator27.0-arm64.xctestrun';
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      await expect(iosXctestrunForAgentStart(config(), 'SIM-1')).resolves.toBe('/cache/Sim_iphonesimulator27.0-arm64.xctestrun');
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[tapsmith-mcp] Building iOS agent for SDK 27.0'));
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('a simulator whose agent cannot be built logs why and starts without an xctestrun', async () => {
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    vi.mocked(ensureSimulatorAgent).mockRejectedValueOnce(new Error('Failed to build iOS simulator agent from source: boom'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(iosXctestrunForAgentStart(config(), 'SIM-1')).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Failed to build iOS simulator agent from source: boom'));
    } finally {
      stderr.mockRestore();
    }
  });

  it('with no device known (it may be a phone), only looks — never builds and stalls discovery', async () => {
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    vi.mocked(ensureSimulatorAgent).mockClear();
    vi.mocked(findSimulatorXctestrun).mockReturnValueOnce('/cache/Sim_iphonesimulator27.0-arm64.xctestrun');
    await expect(iosXctestrunForAgentStart(config(), undefined)).resolves.toBe('/cache/Sim_iphonesimulator27.0-arm64.xctestrun');
    expect(ensureSimulatorAgent).not.toHaveBeenCalled();
  });

  it('a simulator with a hand-set path that exists gets it, checked', async () => {
    const file = path.join(tmp, 'project', 'Sim.xctestrun');
    fs.writeFileSync(file, '<plist/>');
    await expect(iosXctestrunForAgentStart(config({ iosXctestrun: 'Sim.xctestrun' }), 'SIM-1')).resolves.toBe(file);
  });

  it('with no device known, honours TAPSMITH_IOS_XCTESTRUN', async () => {
    process.env.TAPSMITH_IOS_XCTESTRUN = '/env/Agent.xctestrun';
    await expect(iosXctestrunForAgentStart(config(), undefined)).resolves.toBe('/env/Agent.xctestrun');
  });

  it('with no device known, uses the hand-set path as given', async () => {
    await expect(iosXctestrunForAgentStart(config({ iosXctestrun: 'x/Agent.xctestrun' }), undefined))
      .resolves.toBe(path.join(tmp, 'project', 'x', 'Agent.xctestrun'));
  });
});
