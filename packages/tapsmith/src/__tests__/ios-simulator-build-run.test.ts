/**
 * buildSimulatorAgent() against a real child process: a fake `xcodebuild`
 * shell script on PATH stands in for Xcode, so output size, exit codes,
 * signals and timeouts behave exactly as they would for the real tool
 * (PILOT-393: a buffered build was killed by ENOBUFS and reported without a
 * reason).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tapsmithPackageVersion } from '../ios-agent-paths.js';

vi.mock('../build-ios-agent.js', () => ({
  resolveIosAgentDir: () => process.env.FAKE_AGENT_DIR,
  stripDstRootPath: () => undefined,
}));

// By default no existing build and a detectable SDK, so ensureSimulatorAgent()
// builds; a test can hand it a build for another SDK instead.
const { existingBuild } = vi.hoisted(() => ({
  existingBuild: { path: undefined as string | undefined, sdk: '27.0' as string | undefined },
}));
// Without a hand-set existing build, the lookup finds what the real cache
// inspection (reading the temp HOME) calls current — so a build one call
// made is what the next call finds.
vi.mock('../ios-device-resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ios-device-resolve.js')>();
  return {
    ...actual,
    findSimulatorXctestrun: () => {
      if (existingBuild.path) return existingBuild.path;
      const cache = actual.inspectSimulatorAgentCache(existingBuild.sdk);
      return cache && !cache.stale ? cache.xctestrun : undefined;
    },
    getInstalledSimulatorSdkVersion: () => existingBuild.sdk,
    extractSdkVersion: (p: string) => /iphonesimulator(\d+\.\d+)/.exec(p)?.[1],
  };
});

// The machine's arch as host-arch.ts reports it: arm64 under Rosetta too.
const { hostArch } = vi.hoisted(() => ({ hostArch: vi.fn(() => 'arm64') }));
vi.mock('../host-arch.js', async () => {
  const actual = await vi.importActual<typeof import('../host-arch.js')>('../host-arch.js');
  return { ...actual, hostArch, appleArch: (arch: string = hostArch()) => actual.appleArch(arch) };
});

const XCTESTRUN = 'TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator27.0-arm64.xctestrun';

const FAKE_XCODEBUILD = `#!/bin/sh
[ -n "$FAKE_XCB_ARGS" ] && echo "$@" > "$FAKE_XCB_ARGS"
[ -n "$FAKE_XCB_COUNT" ] && echo build >> "$FAKE_XCB_COUNT"
dd=""
while [ $# -gt 0 ]; do
  case "$1" in -derivedDataPath) dd="$2"; shift;; esac
  shift
done
products() {
  mkdir -p "$dd/Build/Products/Debug-iphonesimulator/TapsmithAgentUITests-Runner.app/PlugIns/TapsmithAgentUITests.xctest"
  touch "$dd/Build/Products/${XCTESTRUN}"
}
case "$FAKE_XCB_MODE" in
  ok-icon)
    # What actool and the XCTRunner template leave: the icon in the .xctest only.
    products
    app="$dd/Build/Products/Debug-iphonesimulator/TapsmithAgentUITests-Runner.app"
    xctest="$app/PlugIns/TapsmithAgentUITests.xctest"
    plutil -create xml1 "$app/Info.plist"
    plutil -create xml1 "$xctest/Info.plist"
    plutil -insert CFBundleIcons -json '{"CFBundlePrimaryIcon":{"CFBundleIconName":"AppIcon"}}' "$xctest/Info.plist"
    touch "$xctest/Assets.car" "$xctest/AppIcon60x60@2x.png"
    exit 0;;
  slow-ok)
    sleep 1
    products
    exit 0;;
  big-ok)
    # 12 MB: over both the old 1 MB (init) and 10 MB (runtime) buffers.
    yes 'CompileSwift normal arm64 /a/fairly/long/path/to/TapsmithAgent/Source.swift (in target TapsmithAgentUITests)' | head -c 12000000
    echo
    echo 'some warning on stderr' >&2
    products
    echo '** TEST BUILD SUCCEEDED **'
    exit 0;;
  fail)
    i=0; while [ $i -lt 500 ]; do echo "CompileSwift line $i"; i=$((i+1)); done
    echo "/src/Agent.swift:12:5: error: cannot find 'foo' in scope"
    echo "/src/Agent.swift:20:1: error: expected declaration"
    i=0; while [ $i -lt 50 ]; do echo "trailing noise $i"; i=$((i+1)); done
    echo '** TEST BUILD FAILED **'
    exit 65;;
  fail-noerr)
    i=0; while [ $i -lt 100 ]; do echo "plain line $i"; i=$((i+1)); done
    echo 'last line before exit' >&2
    exit 1;;
  signal)
    echo 'about to be killed'
    kill -KILL $$;;
  sleep)
    echo 'hanging'
    exec sleep 30;;
  ok-child-holds)
    # Exits 0 at once; a descendant holds the pipes past the deadline.
    sleep 2 &
    products
    echo '** TEST BUILD SUCCEEDED **'
    exit 0;;
  fail-child-holds)
    sleep 5 &
    printf 'final line without a newline'
    exit 3;;
  ok-no-products)
    echo 'built nothing'
    exit 0;;
  ignore-term)
    # Ignores SIGTERM (so does its child): only the SIGKILL escalation ends it.
    trap '' TERM
    echo 'ignoring SIGTERM'
    sleep 30 &
    wait;;
  sleep-child)
    # A descendant inherits the pipes and outlives the killed parent.
    echo 'hanging with a child'
    sleep 30 &
    wait;;
esac
`;

let root: string;
let home: string;
let fakeBin: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-xcb-test-'));
  fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'xcodebuild'), FAKE_XCODEBUILD, { mode: 0o755 });
  const agentDir = path.join(root, 'ios-agent');
  fs.mkdirSync(path.join(agentDir, 'TapsmithAgent.xcodeproj'), { recursive: true });
  process.env.FAKE_AGENT_DIR = agentDir;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FAKE_AGENT_DIR;
});

beforeEach(() => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(root, 'home-'));
  process.env.HOME = home;
  process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH ?? ''}`;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  delete process.env.FAKE_XCB_MODE;
  existingBuild.path = undefined;
  existingBuild.sdk = '27.0';
});

const cacheRoot = (): string => path.join(home, '.tapsmith', 'ios-simulator-agent');
/** This version's cache (PILOT-485: one directory per Tapsmith version). */
const cacheDir = (): string => path.join(cacheRoot(), tapsmithPackageVersion());
const logPath = (): string => path.join(cacheDir(), `xcodebuild-${process.pid}.log`);

async function build(mode: string, options?: { timeoutMs?: number }): Promise<string> {
  process.env.FAKE_XCB_MODE = mode;
  const { buildSimulatorAgent } = await import('../ios-simulator-build.js');
  return buildSimulatorAgent('27.0', options);
}

async function buildError(mode: string, options?: { timeoutMs?: number }): Promise<string> {
  return build(mode, options).then(
    () => { throw new Error('expected the build to fail'); },
    (err: unknown) => (err as Error).message,
  );
}

describe('buildSimulatorAgent() xcodebuild output handling', () => {
  it('builds for the machine\'s arch, not Node\'s (PILOT-559: arm64 under Rosetta)', async () => {
    const argsFile = path.join(home, 'xcodebuild-args');
    process.env.FAKE_XCB_ARGS = argsFile;
    onTestFinished(() => { delete process.env.FAKE_XCB_ARGS; hostArch.mockReturnValue('arm64'); });
    for (const [arch, archs] of [['arm64', 'ARCHS=arm64'], ['x64', 'ARCHS=x86_64']] as const) {
      hostArch.mockReturnValue(arch);
      await build('big-ok');
      expect(fs.readFileSync(argsFile, 'utf8').split(' ')).toContain(archs);
    }
  }, 60_000);

  it('succeeds when xcodebuild prints more output than any buffer would hold', async () => {
    const xctestrun = await build('big-ok');
    expect(xctestrun).toBe(path.join(cacheDir(), XCTESTRUN));
    expect(fs.readFileSync(path.join(cacheDir(), '.sdk-version'), 'utf8')).toBe('27.0');
    // Only a failed build leaves its log behind.
    expect(fs.readdirSync(cacheDir()).filter((f) => f.endsWith('.log'))).toEqual([]);
  }, 30_000);

  it('names the exit code, shows the error lines and points at the log', async () => {
    const message = await buildError('fail');
    expect(message).toContain('xcodebuild build-for-testing failed (exit code 65)');
    expect(message).toContain("/src/Agent.swift:12:5: error: cannot find 'foo' in scope");
    expect(message).toContain('/src/Agent.swift:20:1: error: expected declaration');
    expect(message).not.toContain('CompileSwift line 3');
    expect(message).toContain(`Full build log: ${logPath()}`);
    expect(fs.readFileSync(logPath(), 'utf8')).toContain('CompileSwift line 499');
    // The daemon's agent-launch text: classified as retryable infrastructure.
    expect(message).not.toContain('xcodebuild exited with');
    // A failed build leaves no SDK marker, so it is never taken as cached.
    expect(fs.existsSync(path.join(cacheDir(), '.sdk-version'))).toBe(false);
  });

  it('falls back to the last lines when the output has no error: lines', async () => {
    const message = await buildError('fail-noerr');
    expect(message).toContain('failed (exit code 1)');
    expect(message).toContain('last line before exit');
    expect(message).toContain('plain line 99');
    expect(message).not.toContain('plain line 10\n');
    expect(message.split('\n').length).toBeLessThan(30);
  });

  it('names the signal when xcodebuild is killed', async () => {
    const message = await buildError('signal');
    expect(message).toContain('xcodebuild build-for-testing was killed by SIGKILL');
    expect(message).toContain('about to be killed');
    expect(message).not.toContain('xcodebuild exited with');
    expect(message).toContain(`Full build log: ${logPath()}`);
  });

  it('stops a build that outlives its timeout and says so', async () => {
    const started = Date.now();
    const message = await buildError('sleep', { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(message).toContain('xcodebuild build-for-testing timed out after 0.3s and was stopped');
    expect(message).toContain('hanging');
  });

  it('stops at the timeout even when a descendant still holds the output pipes', async () => {
    const started = Date.now();
    const message = await buildError('sleep-child', { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(message).toContain('timed out after 0.3s and was stopped');
    expect(message).toContain('hanging with a child');
  }, 15_000);

  it('does not report a build that exited in time as timed out while a descendant holds the pipes', async () => {
    expect(await build('ok-child-holds', { timeoutMs: 500 })).toBe(path.join(cacheDir(), XCTESTRUN));
  }, 15_000);

  it('keeps the last unterminated line when the drain closes the pipes', async () => {
    const message = await buildError('fail-child-holds');
    expect(message).toContain('failed (exit code 3)');
    expect(message).toContain('final line without a newline');
  }, 15_000);

  it('removes day-old logs of exited processes, and keeps recent or live ones', async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    const deadOld = path.join(cacheDir(), 'xcodebuild-99999998.log');
    const deadRecent = path.join(cacheDir(), 'xcodebuild-99999999.log');
    const liveOld = path.join(cacheDir(), `xcodebuild-${process.ppid}.log`);
    fs.writeFileSync(deadOld, 'old failure');
    fs.utimesSync(deadOld, dayAgo, dayAgo);
    // The failure an error message (e.g. init's) just pointed at.
    fs.writeFileSync(deadRecent, 'recent failure');
    fs.writeFileSync(liveOld, 'another session building');
    fs.utimesSync(liveOld, dayAgo, dayAgo);
    await build('big-ok');
    expect(fs.existsSync(deadOld)).toBe(false);
    expect(fs.existsSync(deadRecent)).toBe(true);
    expect(fs.existsSync(liveOld)).toBe(true);
  }, 30_000);

  it('escalates to SIGKILL when xcodebuild ignores SIGTERM at the timeout', async () => {
    const started = Date.now();
    const message = await buildError('ignore-term', { timeoutMs: 300 });
    // 0.3 s deadline + 5 s grace + 2 s drain.
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(message).toContain('timed out after 0.3s and was stopped');
    expect(message).toContain('ignoring SIGTERM');
  }, 20_000);

  it('keeps building when the log cannot be written', async () => {
    // A directory where the log goes: opening it fails (EISDIR), as a full
    // disk or an unwritable path would. 12 MB of output must still drain.
    fs.mkdirSync(logPath(), { recursive: true });
    expect(await build('big-ok')).toBe(path.join(cacheDir(), XCTESTRUN));
  }, 30_000);

  it('omits the log line when the log could not be written', async () => {
    fs.mkdirSync(logPath(), { recursive: true });
    const message = await buildError('fail');
    expect(message).toContain('failed (exit code 65)');
    expect(message).not.toContain('Full build log');
  }, 30_000);

  it('keeps the log when xcodebuild succeeded but produced no products', async () => {
    const message = await buildError('ok-no-products');
    expect(message).toContain('products directory not found');
    expect(message).toContain(`Full build log: ${logPath()}`);
    expect(fs.readFileSync(logPath(), 'utf8')).toContain('built nothing');
  });

  it.runIf(process.platform === 'darwin')('gives the cached runner app the icon the .xctest was built with', async () => {
    const script = path.join(process.env.FAKE_AGENT_DIR!, 'install-runner-icon.sh');
    fs.copyFileSync(path.resolve(import.meta.dirname, '../../../../ios-agent/install-runner-icon.sh'), script);
    onTestFinished(() => fs.rmSync(script));
    await build('ok-icon');
    const app = path.join(cacheDir(), 'Debug-iphonesimulator', 'TapsmithAgentUITests-Runner.app');
    expect(fs.existsSync(path.join(app, 'Assets.car'))).toBe(true);
    expect(fs.existsSync(path.join(app, 'AppIcon60x60@2x.png'))).toBe(true);
    expect(fs.readFileSync(path.join(app, 'Info.plist'), 'utf8')).toContain('<string>AppIcon</string>');
  }, 30_000);

  it('keeps a build whose runner icon could not be installed', async () => {
    const script = path.join(process.env.FAKE_AGENT_DIR!, 'install-runner-icon.sh');
    fs.writeFileSync(script, 'exit 1\n');
    onTestFinished(() => fs.rmSync(script));
    expect(await build('slow-ok')).toBe(path.join(cacheDir(), XCTESTRUN));
  }, 30_000);

  it('says xcodebuild could not start when it is not installed', async () => {
    process.env.PATH = path.join(root, 'empty-bin');
    const message = await buildError('big-ok');
    expect(message).toMatch(/could not start xcodebuild: .*ENOENT/);
    expect(fs.existsSync(logPath())).toBe(false);
  });
});

describe('ensureSimulatorAgent() options', () => {
  it('quiet keeps stdout clean while it builds', async () => {
    process.env.FAKE_XCB_MODE = 'big-ok';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, 'write');
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      expect(await ensureSimulatorAgent({ quiet: true })).toBe(path.join(cacheDir(), XCTESTRUN));
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  }, 30_000);

  it('reports its progress line by default', async () => {
    process.env.FAKE_XCB_MODE = 'big-ok';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      await ensureSimulatorAgent();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Building from source for SDK 27.0'));
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it('rebuilds an SDK-mismatched build quietly, within its timeout, and names the failure', async () => {
    existingBuild.path = '/old/TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun';
    process.env.FAKE_XCB_MODE = 'sleep';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      await expect(ensureSimulatorAgent({ quiet: true, timeoutMs: 300 })).rejects.toThrow(
        /^Failed to rebuild the iOS simulator agent for SDK 27\.0: xcodebuild build-for-testing timed out after 0\.3s/,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  // PILOT-485: another version's cached build is never used, so the run
  // builds this version's own — says that is why — and leaves the other be.
  it('builds its own agent when only another Tapsmith version has one cached, and says why', async () => {
    const otherDir = path.join(cacheRoot(), '0.0.1-older');
    fs.mkdirSync(path.join(otherDir, 'Debug-iphonesimulator', 'R.app', 'PlugIns', 'T.xctest'), { recursive: true });
    fs.writeFileSync(path.join(otherDir, XCTESTRUN), '<plist/>');
    fs.writeFileSync(path.join(otherDir, '.sdk-version'), '27.0');
    process.env.FAKE_XCB_MODE = 'big-ok';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      expect(await ensureSimulatorAgent()).toBe(path.join(cacheDir(), XCTESTRUN));
      expect(log).toHaveBeenCalledWith(expect.stringMatching(
        /^The cached iOS simulator agent in .* was built by Tapsmith 0\.0\.1-older \(this is .*\)\. Building iOS agent for SDK 27\.0/,
      ));
      expect(fs.existsSync(path.join(otherDir, XCTESTRUN))).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it('drops the SDK marker while it builds, so a failed build leaves no current-looking cache', async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), '.sdk-version'), '27.0');
    await buildError('fail');
    expect(fs.existsSync(path.join(cacheDir(), '.sdk-version'))).toBe(false);
  }, 30_000);

  it('builds once when several workers need the agent at the same time', async () => {
    const count = path.join(home, 'xcodebuild-count');
    process.env.FAKE_XCB_COUNT = count;
    process.env.FAKE_XCB_MODE = 'slow-ok';
    onTestFinished(() => { delete process.env.FAKE_XCB_COUNT; });
    const lines: string[] = [];
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    const results = await Promise.all([1, 2, 3].map(() => ensureSimulatorAgent({ onProgress: (m) => lines.push(m) })));
    expect(results).toEqual(Array(3).fill(path.join(cacheDir(), XCTESTRUN)));
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(lines).toContain('Waiting for another Tapsmith process to finish building the iOS simulator agent...');
  }, 30_000);

  it('reports the build that failed while it waited, instead of repeating it once per worker', async () => {
    const count = path.join(home, 'xcodebuild-count');
    process.env.FAKE_XCB_COUNT = count;
    process.env.FAKE_XCB_MODE = 'fail';
    onTestFinished(() => { delete process.env.FAKE_XCB_COUNT; });
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    const results = await Promise.allSettled([1, 2, 3].map(() => ensureSimulatorAgent({ quiet: true })));
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(String((r as PromiseRejectedResult).reason)).toContain('xcodebuild build-for-testing failed (exit code 65)');
    }
    // The next run (nobody building) tries again.
    process.env.FAKE_XCB_MODE = 'big-ok';
    expect(await ensureSimulatorAgent({ quiet: true })).toBe(path.join(cacheDir(), XCTESTRUN));
    expect(fs.existsSync(path.join(cacheDir(), '.build-failed'))).toBe(false);
  }, 30_000);

  it('keeps a finished build when its lock was broken as stale meanwhile (release rejects ERELEASED)', async () => {
    const actual = await vi.importActual<typeof import('proper-lockfile')>('proper-lockfile');
    vi.doMock('proper-lockfile', () => ({
      default: {
        ...actual,
        lock: async (file: string, opts: object) => {
          const release = await actual.lock(file, opts);
          return async () => {
            await release();
            throw Object.assign(new Error('Lock is already released'), { code: 'ERELEASED' });
          };
        },
      },
    }));
    onTestFinished(() => { vi.doUnmock('proper-lockfile'); });
    process.env.FAKE_XCB_MODE = 'big-ok';
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    expect(await ensureSimulatorAgent({ quiet: true })).toBe(path.join(cacheDir(), XCTESTRUN));
  }, 30_000);

  it('hands its progress to onProgress instead of stdout', async () => {
    process.env.FAKE_XCB_MODE = 'big-ok';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lines: string[] = [];
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      await ensureSimulatorAgent({ onProgress: (m) => lines.push(m) });
      expect(lines).toEqual([expect.stringContaining('Building from source for SDK 27.0')]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it('says macOS is needed when there is no SDK because this is not a Mac', async () => {
    existingBuild.sdk = undefined;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      await expect(ensureSimulatorAgent({ quiet: true })).rejects.toThrow('iOS simulator testing needs macOS with Xcode');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('says why it cannot build when the simulator SDK cannot be detected', async () => {
    existingBuild.sdk = undefined;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    onTestFinished(() => { Object.defineProperty(process, 'platform', platform); });
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    const message = await ensureSimulatorAgent({ quiet: true }).then(() => '', (err: unknown) => (err as Error).message);
    expect(message).toContain('the iOS Simulator SDK could not be detected');
    expect(message).toContain('xcode-select');
    expect(message).toContain('xcodebuild -license accept');
    expect(message).not.toContain('npm install');
    expect(message).not.toContain('name=iPhone');
  });

  it('passes its timeout to the build and names the build failure', async () => {
    process.env.FAKE_XCB_MODE = 'sleep';
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    await expect(ensureSimulatorAgent({ quiet: true, timeoutMs: 300 })).rejects.toThrow(
      /^Failed to build iOS simulator agent from source: xcodebuild build-for-testing timed out after 0\.3s/,
    );
  });
});
