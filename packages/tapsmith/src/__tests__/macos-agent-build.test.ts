import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Only xcodebuild is faked: it writes what a real build-for-testing leaves in
// `-derivedDataPath`, so the copy into the cache is the real one.
vi.mock('../ios-simulator-build.js', () => ({
  runXcodebuild: vi.fn(async (args: string[]) => {
    const derived = args[args.indexOf('-derivedDataPath') + 1];
    const products = path.join(derived, 'Build', 'Products');
    fs.mkdirSync(path.join(products, 'Debug', 'TapsmithMacAgentUITests-Runner.app'), { recursive: true });
    fs.writeFileSync(path.join(products, 'TapsmithMacAgentUITests_macosx-arm64.xctestrun'), '<plist/>');
  }),
}));

const { runXcodebuild } = await import('../ios-simulator-build.js');
const { ensureMacAgent, findMacosAgentDir } = await import('../macos-agent-build.js');
const xcodebuild = vi.mocked(runXcodebuild);

let root: string;
let agentDir: string;
let cacheDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-mac-agent-')));
  agentDir = path.join(root, 'ios-agent');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(agentDir, 'TapsmithAgent'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'TapsmithAgent', 'Agent.swift'), 'let a = 1');
  fs.mkdirSync(path.join(agentDir, 'macos', 'TapsmithMacAgent.xcodeproj'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'macos', 'TapsmithMacAgent.xcodeproj', 'project.pbxproj'), '{}');
  xcodebuild.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureMacAgent()', () => {
  it('builds the macOS agent into the cache when nothing is cached', async () => {
    const xctestrun = await ensureMacAgent({ agentDir, cacheDir });

    expect(xcodebuild).toHaveBeenCalledTimes(1);
    const args = xcodebuild.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining([
      'build-for-testing',
      '-project', path.join(agentDir, 'macos', 'TapsmithMacAgent.xcodeproj'),
      '-scheme', 'TapsmithMacAgentUITests',
      '-destination', 'platform=macOS',
    ]));
    expect(xctestrun.startsWith(cacheDir + path.sep)).toBe(true);
    expect(xctestrun.endsWith('.xctestrun')).toBe(true);
    expect(fs.existsSync(xctestrun)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(xctestrun), 'Debug', 'TapsmithMacAgentUITests-Runner.app'))).toBe(true);
  });

  it('reuses the cached build while the source is unchanged, never a patched copy', async () => {
    const first = await ensureMacAgent({ agentDir, cacheDir });
    // The daemon's patched copy sits next to the build; it must not be returned.
    fs.writeFileSync(`${first}.launch.port18700.patched.xctestrun`, '<plist/>');

    const second = await ensureMacAgent({ agentDir, cacheDir });

    expect(second).toBe(first);
    expect(xcodebuild).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the agent source changes, and ignores Xcode user state', async () => {
    const first = await ensureMacAgent({ agentDir, cacheDir });
    fs.mkdirSync(path.join(agentDir, 'macos', 'TapsmithMacAgent.xcodeproj', 'xcuserdata'));
    expect(await ensureMacAgent({ agentDir, cacheDir })).toBe(first);
    expect(xcodebuild).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(agentDir, 'TapsmithAgent', 'Agent.swift'), 'let a = 2');
    const rebuilt = await ensureMacAgent({ agentDir, cacheDir });

    expect(xcodebuild).toHaveBeenCalledTimes(2);
    expect(path.dirname(rebuilt)).not.toBe(path.dirname(first));
  });
});

describe('findMacosAgentDir()', () => {
  it('finds the checkout the SDK runs from, whatever the working directory', () => {
    // root/packages/tapsmith/dist is where the SDK runs from in a checkout.
    const moduleDir = path.join(root, 'packages', 'tapsmith', 'dist');
    fs.mkdirSync(moduleDir, { recursive: true });

    expect(findMacosAgentDir({ moduleDir, cwd: path.join(root, 'e2e') })).toBe(path.join(root, 'ios-agent'));
  });
});
