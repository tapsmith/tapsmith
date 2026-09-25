import { describe, expect, it } from 'vitest';
import { runCli, type CliHandlers } from '../cli-program.js';

// ─── Harness ───

interface Harness {
  /** Exit code runCli returned. */
  code: number;
  out: string;
  err: string;
  /** Handler calls in order: [handler name, options]. */
  calls: Array<[string, unknown]>;
}

async function run(argv: string[], results: Partial<Record<keyof CliHandlers, number>> = {}): Promise<Harness> {
  const calls: Array<[string, unknown]> = [];
  const handlers = new Proxy({} as CliHandlers, {
    get: (_target, name: string) => async (opts: unknown) => {
      calls.push([name, opts]);
      return results[name as keyof CliHandlers];
    },
  });
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    handlers,
    version: '1.2.3',
    io: { out: (s) => { out += s; }, err: (s) => { err += s; } },
  });
  return { code, out, err, calls };
}

async function testArgs(argv: string[]): Promise<Record<string, unknown>> {
  const h = await run(['test', ...argv]);
  expect(h.err).toBe('');
  expect(h.code).toBe(0);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]![0]).toBe('test');
  return h.calls[0]![1] as Record<string, unknown>;
}

async function usageError(argv: string[]): Promise<Harness> {
  const h = await run(argv);
  expect(h.code).toBe(1);
  expect(h.calls).toEqual([]);
  return h;
}

// ─── test command ───

describe('tapsmith test', () => {
  it('passes defaults when no options are given', async () => {
    expect(await testArgs([])).toEqual({
      files: [],
      watch: false,
      ui: false,
      forceInstall: false,
      tsxReexec: false,
    });
  });

  it('accepts files interleaved with options, in both value forms', async () => {
    const args = await testArgs([
      'a.test.ts', '--device', 'emulator-5554', 'b.test.ts', '--workers=2', '-c', 'x.config.mjs',
      '--reporter', 'json', '--ui-dev-url=http://localhost:5173', '--force-install', '-w', '--ui',
      '--ui-port', '8080',
    ]);
    expect(args).toMatchObject({
      files: ['a.test.ts', 'b.test.ts'],
      device: 'emulator-5554',
      workers: 2,
      config: 'x.config.mjs',
      reporter: 'json',
      uiDevUrl: 'http://localhost:5173',
      forceInstall: true,
      watch: true,
      ui: true,
      uiPort: 8080,
    });
  });

  it('treats everything after -- as a file', async () => {
    expect((await testArgs(['--', '--odd-name.test.ts'])).files).toEqual(['--odd-name.test.ts']);
  });

  describe('--shard', () => {
    it.each([['--shard=1/4'], ['--shard', '1/4']])('parses %s', async (...argv) => {
      expect((await testArgs(argv)).shard).toEqual({ current: 1, total: 4 });
    });

    it.each(['abc', '0/4', '5/4', '1/0', '1/'])('rejects --shard %s', async (value) => {
      const h = await usageError(['test', '--shard', value]);
      expect(h.err).toMatch(/--shard/);
    });
  });

  describe('--workers', () => {
    it.each([['-j', '3'], ['-j3'], ['-j=3'], ['--workers', '3'], ['--workers=3']])('parses %s', async (...argv) => {
      expect((await testArgs(argv)).workers).toBe(3);
    });

    it.each(['0', 'abc', '1.5', '2x'])('rejects --workers %s', async (value) => {
      const h = await usageError(['test', `--workers=${value}`]);
      expect(h.err).toMatch(/--workers.*positive integer/);
    });
  });

  it('rejects a non-integer --ui-port', async () => {
    expect((await usageError(['test', '--ui-port', 'abc'])).err).toMatch(/--ui-port.*non-negative integer/);
  });

  describe('--trace / --video', () => {
    it.each(['--trace', '--video'])('%s alone means on', async (flag) => {
      const args = await testArgs([flag]);
      expect(args[flag.slice(2)]).toBe('on');
    });

    it.each(['--trace', '--video'])('%s takes a mode in both forms', async (flag) => {
      expect((await testArgs([flag, 'retain-on-failure']))[flag.slice(2)]).toBe('retain-on-failure');
      expect((await testArgs([`${flag}=on-first-retry`]))[flag.slice(2)]).toBe('on-first-retry');
    });

    it.each(['--trace', '--video'])('%s rejects an unknown mode, listing the valid ones (PILOT-254)', async (flag) => {
      const h = await usageError(['test', flag, 'retain-on-falure']);
      expect(h.err).toContain("'retain-on-falure'");
      expect(h.err).toContain('retain-on-failure-and-retries');
    });

    it('a bare --trace followed by a flag still means on', async () => {
      expect(await testArgs(['--trace', '--workers', '2'])).toMatchObject({ trace: 'on', workers: 2 });
    });
  });

  describe('--grep / --grep-invert', () => {
    it('compiles plain and /slash/ patterns', async () => {
      const args = await testArgs(['-g', 'login', '--grep-invert=/slow/i']);
      expect(args.grep).toEqual(/login/);
      expect(args.grepInvert).toEqual(/slow/i);
    });

    it('accepts -g=pattern', async () => {
      expect((await testArgs(['-g=login'])).grep).toEqual(/login/);
    });

    it('accepts a pattern starting with - in the = form', async () => {
      expect((await testArgs(['--grep=-slow'])).grep).toEqual(/-slow/);
    });

    it('rejects an invalid regular expression', async () => {
      expect((await usageError(['test', '--grep', '('])).err).toMatch(/--grep.*not a valid regular expression/);
    });
  });

  it('collects repeated --project flags', async () => {
    expect((await testArgs(['--project', 'a', '--project=b'])).project).toEqual(['a', 'b']);
  });

  it('accepts the hidden tsx re-exec marker', async () => {
    expect((await testArgs(['a.test.ts', '--__tsx-reexec'])).tsxReexec).toBe(true);
  });

  it('reads the re-exec marker appended after --, instead of taking it for a file', async () => {
    // The tsx re-exec appends the marker to the user's argv, which may end in `-- <files>`.
    expect(await testArgs(['--', '--odd.test.ts', '--__tsx-reexec'])).toMatchObject({
      files: ['--odd.test.ts'],
      tsxReexec: true,
    });
  });

  describe('value flags never swallow the next flag (PILOT-260)', () => {
    it.each([
      [['--device', '--shard=abc'], '--device'],
      [['-d', '--workers', '2'], '--device'],
      [['--config', '--json'], '--config'],
      [['-c', '-w'], '--config'],
      [['--grep', '--workers', '2'], '--grep'],
      [['--grep-invert', '-w'], '--grep-invert'],
      [['--reporter', '--ui'], '--reporter'],
      [['--project', '--ui'], '--project'],
      [['--ui-dev-url', '--ui'], '--ui-dev-url'],
      [['--workers', '--ui'], '--workers'],
      [['--shard', '--ui'], '--shard'],
    ])('rejects %j', async (argv, flag) => {
      const h = await usageError(['test', ...argv]);
      expect(h.err).toContain(flag);
      expect(h.err).toMatch(/argument missing/);
      // Point at the escape hatch for a value that really starts with "-".
      expect(h.err).toContain(`${flag}=`);
    });

    it.each([['--device'], ['--grep'], ['-c'], ['--project']])('rejects %s at the end of argv', async (flag) => {
      const h = await usageError(['test', flag]);
      expect(h.err).toMatch(/argument missing/);
    });
  });

  it('rejects an unknown option', async () => {
    // --retries included: documented once, never implemented (a follow-up adds it Playwright-style).
    expect((await usageError(['test', '--retries', '2'])).err).toMatch(/unknown option '--retries'/);
    const h = await usageError(['test', '--bogus']);
    expect(h.err).toMatch(/unknown option '--bogus'/);
    expect(h.out).toBe('');
  });

  it('rejects -v after the command (version is a top-level flag)', async () => {
    await usageError(['test', '-v']);
  });
});

// ─── Help ───

describe('help', () => {
  it('prints top-level help on stdout, exit 0, for a bare invocation', async () => {
    const h = await run([]);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toMatch(/Usage: tapsmith/);
    expect(h.out).toContain('show-trace');
  });

  it.each([['--help'], ['-h'], ['help']])('%s prints top-level help', async (...argv) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toMatch(/Usage: tapsmith/);
  });

  const commands = [
    'test', 'show-trace', 'show-report', 'merge-reports', 'list-devices', 'setup-ios', 'setup-ios-device',
    'build-ios-agent', 'create-avd', 'configure-ios-network', 'refresh-ios-network', 'verify-ios-network',
    'init', 'verify', 'doctor', 'mcp-server', 'telemetry',
  ];

  it.each(commands)('%s --help prints that command\'s help and never runs it (PILOT-252)', async (command) => {
    for (const argv of [[command, '--help'], [command, '-h'], ['help', command]]) {
      const h = await run(argv);
      expect(h.code, argv.join(' ')).toBe(0);
      expect(h.calls, argv.join(' ')).toEqual([]);
      expect(h.out, argv.join(' ')).toContain(`Usage: tapsmith ${command}`);
    }
  });

  it.each(commands)('--help before %s never runs it (PILOT-252)', async (command) => {
    for (const flag of ['--help', '-h']) {
      const h = await run([flag, command]);
      expect(h.code).toBe(0);
      expect(h.calls).toEqual([]);
      expect(h.out).toMatch(/Usage: tapsmith/);
    }
  });

  it('help <unknown> is an unknown-command error', async () => {
    expect((await usageError(['help', 'tset'])).err).toMatch(/unknown command 'tset'[\s\S]*Did you mean test\?/);
  });

  it('--help wins over other flags on the command line', async () => {
    const h = await run(['doctor', '--json', '--help']);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('test --help lists test flags, including --ui and --ui-port, but not the tsx marker', async () => {
    const { out } = await run(['test', '--help']);
    for (const flag of ['--device', '--workers', '--shard', '--trace', '--video', '--ui', '--ui-port', '--grep', '--project', '--force-install']) {
      expect(out).toContain(flag);
    }
    expect(out).not.toContain('tsx-reexec');
  });

  it('show-trace --help does not list test-only flags', async () => {
    const { out } = await run(['show-trace', '--help']);
    expect(out).not.toContain('--force-install');
    expect(out).not.toContain('--workers');
  });
});

describe('--version', () => {
  it.each([['--version'], ['-v']])('%s prints the version', async (...argv) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.out).toBe('1.2.3\n');
    expect(h.calls).toEqual([]);
  });
});

// ─── Unknown commands and options ───

describe('unknown commands', () => {
  it.each([['tset'], ['tset', '--help'], ['--help', 'tset'], ['-h', 'tset']])('%j is an error with a suggestion', async (...argv) => {
    const h = await usageError(argv);
    expect(h.err).toMatch(/unknown command 'tset'/);
    expect(h.err).toMatch(/Did you mean test\?/);
    expect(h.out).toBe('');
  });

  it('a command with no near match gets no suggestion but still fails', async () => {
    const h = await usageError(['xyzzy-nothing']);
    expect(h.err).toMatch(/unknown command 'xyzzy-nothing'/);
  });

  it('points at --help instead of dumping it', async () => {
    const h = await usageError(['tset']);
    expect(h.err).toContain("tapsmith --help");
    expect(h.err).not.toContain('Commands:');
  });
});

describe('per-command options (PILOT-260)', () => {
  it.each([
    [['show-trace', 'foo.zip', '--force-install'], '--force-install'],
    [['show-report', '--workers', '2'], '--workers'],
    [['doctor', '--bogus'], '--bogus'],
    [['list-devices', '--bogus'], '--bogus'],
    [['mcp-server', '--bogus'], '--bogus'],
    [['setup-ios', '--json'], '--json'],
  ])('%j rejects %s', async (argv, flag) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`unknown option '${flag}'`);
    expect(h.err).toContain(`tapsmith ${argv[0]} --help`);
  });

  it('rejects stray positional arguments', async () => {
    expect((await usageError(['doctor', 'extra'])).err).toMatch(/too many arguments/);
  });
});

// ─── Other commands ───

describe('commands', () => {
  it('show-trace needs a file', async () => {
    expect((await usageError(['show-trace'])).err).toMatch(/missing required argument 'file'/);
    const h = await run(['show-trace', 't.zip']);
    expect(h.calls).toEqual([['showTrace', { file: 't.zip' }]]);
  });

  it('show-report and merge-reports take an optional directory', async () => {
    expect((await run(['show-report'])).calls).toEqual([['showReport', { dir: undefined }]]);
    expect((await run(['show-report', 'out'])).calls).toEqual([['showReport', { dir: 'out' }]]);
    expect((await run(['merge-reports', 'blobs', '-c', 'x.mjs'])).calls)
      .toEqual([['mergeReports', { dir: 'blobs', config: 'x.mjs' }]]);
  });

  it('list-devices and doctor take --json (and doctor -c)', async () => {
    expect((await run(['list-devices', '--json'])).calls).toEqual([['listDevices', { json: true }]]);
    expect((await run(['doctor'])).calls).toEqual([['doctor', { json: false }]]);
    expect((await run(['doctor', '--json', '-c', 'x.mjs'])).calls).toEqual([['doctor', { json: true, config: 'x.mjs' }]]);
  });

  it('doctor -c followed by a flag is an error, not a config path', async () => {
    await usageError(['doctor', '-c', '--json']);
  });

  it.each([['doctor', '--config='], ['test', '--config='], ['test', '--device='], ['test', '--reporter=']])(
    '%s %s (an empty = value) is an error',
    async (...argv) => {
      expect((await usageError(argv)).err).toMatch(/needs a value/);
    },
  );

  it('verify and mcp-server take a config', async () => {
    expect((await run(['verify', '--json', '--config=t.mjs'])).calls).toEqual([['verify', { json: true, config: 't.mjs' }]]);
    expect((await run(['mcp-server', '-c', 'm.mjs'])).calls).toEqual([['mcpServer', { config: 'm.mjs' }]]);
    expect((await run(['mcp-server'])).calls).toEqual([['mcpServer', {}]]);
  });

  it('telemetry takes an optional action from a fixed set', async () => {
    expect((await run(['telemetry'])).calls).toEqual([['telemetry', { action: undefined, json: false }]]);
    expect((await run(['telemetry', 'disable', '--json'])).calls).toEqual([['telemetry', { action: 'disable', json: true }]]);
    const h = await usageError(['telemetry', 'toggle']);
    expect(h.err).toMatch(/'toggle'.*status, enable, disable/);
    await usageError(['telemetry', 'enable', 'disable']);
  });

  it('build-ios-agent keeps -v as --verbose', async () => {
    expect((await run(['build-ios-agent', '-v', '--team-id', 'ABC', '--cwd', '/r', '--derived-data-path=/d'])).calls)
      .toEqual([['buildIosAgent', { verbose: true, teamId: 'ABC', cwd: '/r', derivedDataPath: '/d' }]]);
    expect((await run(['build-ios-agent'])).calls).toEqual([['buildIosAgent', { verbose: false }]]);
  });

  it('create-avd passes its raw options through', async () => {
    expect((await run(['create-avd', '--api', '35', '--name=N', '--device', 'pixel_7', '--abi', 'x86_64', '--force', '--install-tools'])).calls)
      .toEqual([['createAvd', { api: '35', name: 'N', device: 'pixel_7', abi: 'x86_64', force: true, installTools: true }]]);
    expect((await run(['create-avd'])).calls).toEqual([['createAvd', { force: false, installTools: false }]]);
  });

  it.each(['configure-ios-network', 'refresh-ios-network'])('%s needs a UDID and takes its options', async (command) => {
    expect((await usageError([command])).err).toMatch(/missing required argument 'udid'/);
    const handler = command === 'configure-ios-network' ? 'configureIosNetwork' : 'refreshIosNetwork';
    expect((await run([command, 'U1', '--ssid', 'Home', '--device-name=Phone', '--fix-firewall'])).calls)
      .toEqual([[handler, { udid: 'U1', ssid: 'Home', deviceName: 'Phone', fixFirewall: true }]]);
  });

  it('verify-ios-network needs a UDID', async () => {
    await usageError(['verify-ios-network']);
    expect((await run(['verify-ios-network', 'U1'])).calls).toEqual([['verifyIosNetwork', { udid: 'U1' }]]);
  });

  it('setup-ios and setup-ios-device take no options', async () => {
    expect((await run(['setup-ios'])).calls).toEqual([['setupIos', {}]]);
    expect((await run(['setup-ios-device'])).calls).toEqual([['setupIosDevice', {}]]);
  });

  it('init passes every flag through', async () => {
    const h = await run([
      'init', '--yes', '--json', '--force', '--platform', 'android,ios',
      '--apk', './a.apk', '--package', 'com.x', '--app', './X.app',
      '--bundle-id', 'com.x.ios', '--avd', 'Pixel_7', '--simulator', 'iPhone 16',
      '--device-type', 'both', '--network-capture', '--no-example-test', '--no-agents-md',
    ]);
    expect(h.calls).toEqual([['init', {
      yes: true, json: true, force: true, platform: 'android,ios', apk: './a.apk', package: 'com.x',
      app: './X.app', bundleId: 'com.x.ios', avd: 'Pixel_7', simulator: 'iPhone 16', deviceType: 'both',
      networkCapture: true, exampleTest: false, agentsMd: false,
    }]]);
    expect((await run(['init', '-y', '--platform=android'])).calls[0]![1]).toMatchObject({ yes: true, platform: 'android' });
  });

  it('returns the handler\'s exit code', async () => {
    expect((await run(['telemetry', 'enable'], { telemetry: 3 })).code).toBe(3);
  });
});

// ─── Machine-readable usage errors ───

describe('usage errors under --json', () => {
  it.each([
    [['init', '--json', '--bogus'], 'UNKNOWN_FLAG'],
    [['init', '--json', '--platform'], 'MISSING_FLAG_VALUE'],
    [['init', '--platform', '--json'], 'MISSING_FLAG_VALUE'],
    [['verify', '--json', '--bogus'], 'BAD_ARGS'],
    [['doctor', '--json', '--bogus'], 'BAD_ARGS'],
    [['list-devices', '--json', 'extra'], 'BAD_ARGS'],
    [['telemetry', '--json', 'toggle'], 'BAD_ARGS'],
  ])('%j prints a JSON error with code %s on stdout', async (argv, code) => {
    const h = await usageError(argv);
    expect(h.err).toBe('');
    const parsed = JSON.parse(h.out) as { error: { code: string; message: string; fix: string } };
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBeTruthy();
    expect(parsed.error.fix).toContain(`tapsmith ${argv[0]} --help`);
  });

  it('mcp-server usage errors go to stderr, keeping the stdio channel clean', async () => {
    const h = await usageError(['mcp-server', '--bogus']);
    expect(h.out).toBe('');
    expect(h.err).toMatch(/unknown option/);
  });
});
