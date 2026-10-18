import { describe, expect, it } from 'vitest';
import { runCli, printsBanner, claimBanner, type CliHandlers } from '../cli-program.js';

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

    it.each([
      [['-wd', '--workers', '2'], '--device'],
      [['-wc', '--json'], '--config'],
      [['-wj', '--ui'], '--workers'],
    ])('rejects a short-flag bundle ending in a value flag: %j', async (argv, flag) => {
      const h = await usageError(['test', ...argv]);
      expect(h.err).toContain(flag);
      expect(h.err).toMatch(/argument missing/);
      // The suggested rewrite keeps the bundle's other flags.
      expect(h.err).toContain(`write -w ${flag}=`);
    });

    it('still reads a bundle whose value flag carries its value', async () => {
      expect(await testArgs(['-wdemulator-5554'])).toMatchObject({ watch: true, device: 'emulator-5554' });
      expect(await testArgs(['-wd', 'emulator-5554'])).toMatchObject({ watch: true, device: 'emulator-5554' });
    });

    it.each([['--device'], ['--grep'], ['-c'], ['--project']])('rejects %s at the end of argv', async (flag) => {
      const h = await usageError(['test', flag]);
      expect(h.err).toMatch(/argument missing/);
    });
  });

  it.each([['-grep', '--grep'], ['-device', '--device'], ['-config', '--config'], ['-workers', '--workers']])(
    'refuses the single-dash long flag %s instead of reading it as a short flag with a value',
    async (typo, long) => {
      const h = await usageError(['test', typo, 'x']);
      expect(h.err).toContain(`unknown option '${typo}'`);
      expect(h.err).toContain(`Did you mean ${long}?`);
    },
  );

  it('keeps a /pattern/ with a flag it has never taken as a literal pattern', async () => {
    expect((await testArgs(['--grep', '/api/v'])).grep).toEqual(new RegExp('/api/v'));
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
    // The same help as --help, examples included.
    expect(h.out).toBe((await run(['--help'])).out);
    expect(h.out).toContain('Examples:');
  });

  it.each([['--help'], ['-h'], ['help']])('%s prints top-level help', async (...argv) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toMatch(/Usage: tapsmith/);
  });

  const commands = [
    'test', 'show-trace', 'show-report', 'merge-reports', 'list-devices', 'create-avd',
    'init', 'verify', 'doctor', 'mcp-server', 'telemetry',
    'ios', 'ios setup-device', 'ios build-agent',
    'ios network', 'ios network setup-simulator', 'ios network configure', 'ios network verify',
  ];

  it.each(commands)('%s --help prints that command\'s help and never runs it (PILOT-252)', async (command) => {
    const words = command.split(' ');
    // `help <command>` answers for the word after it, at any level: `tapsmith ios network help verify`.
    const viaHelp = [...words.slice(0, -1), 'help', words[words.length - 1]!];
    for (const argv of [[...words, '--help'], [...words, '-h'], viaHelp]) {
      const h = await run(argv);
      expect(h.code, argv.join(' ')).toBe(0);
      expect(h.calls, argv.join(' ')).toEqual([]);
      expect(h.out, argv.join(' ')).toContain(`Usage: tapsmith ${command}`);
    }
  });

  it.each(commands)('--help before %s never runs it (PILOT-252)', async (command) => {
    for (const flag of ['--help', '-h']) {
      const h = await run([flag, ...command.split(' ')]);
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

  it.each([['init', '--platform', '--help'], ['test', '--device', '-h'], ['test', '--bogus', '--help']])(
    '%j prints help instead of a usage error',
    async (...argv) => {
      const h = await run(argv);
      expect(h.code).toBe(0);
      expect(h.calls).toEqual([]);
      expect(h.err).toBe('');
      expect(h.out).toContain(`Usage: tapsmith ${argv[0]}`);
    },
  );

  it('--help wins over a misplaced option before the command', async () => {
    for (const argv of [['-c', 'x', 'test', '--help'], ['--help', '-c', 'x', 'test']]) {
      const h = await run(argv);
      expect(h.code, argv.join(' ')).toBe(0);
      expect(h.out, argv.join(' ')).toMatch(/Usage: tapsmith/);
    }
  });

  it('a --help after -- is a file, not a help request', async () => {
    expect((await testArgs(['--', '--help'])).files).toEqual(['--help']);
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

  it('an option before the command says it belongs after the command', async () => {
    const h = await usageError(['-c', 'ci.mjs', 'test']);
    expect(h.err).toMatch(/'-c' goes after the command: tapsmith test -c/);
  });

  it('points at --help instead of dumping it', async () => {
    const h = await usageError(['tset']);
    expect(h.err).toContain("tapsmith --help");
    expect(h.err).not.toContain('Commands:');
  });
});

describe('per-command options (PILOT-260)', () => {
  it.each([
    [['show-trace', 'foo.zip', '--force-install'], '--force-install', 'show-trace'],
    [['show-report', '--workers', '2'], '--workers', 'show-report'],
    [['doctor', '--bogus'], '--bogus', 'doctor'],
    [['list-devices', '--bogus'], '--bogus', 'list-devices'],
    [['mcp-server', '--bogus'], '--bogus', 'mcp-server'],
    [['ios', 'network', 'setup-simulator', '--json'], '--json', 'ios network setup-simulator'],
    [['ios', 'build-agent', '--team', 'X'], '--team', 'ios build-agent'],
  ])('%j rejects %s', async (argv, flag, command) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`unknown option '${flag}'`);
    // The hint names the whole command, nested ones included.
    expect(h.err).toContain(`tapsmith ${command} --help`);
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

  it.each([['doctor', '--config='], ['test', '--config='], ['test', '-c', '']])(
    '%s %s (an empty config path) is an error',
    async (...argv) => {
      expect((await usageError(argv)).err).toMatch(/needs a value/);
    },
  );

  it('an empty --device, --reporter, --trace, --video, --grep, --grep-invert or --ui-dev-url means unset, as `--device "$SERIAL"` with an empty variable always has', async () => {
    const args = await testArgs(['--device', '', '--reporter=', '--trace', '', '--video=', '--ui-dev-url=', '--grep', '', '--grep-invert=']);
    expect(args.grep).toBeUndefined();
    expect(args.grepInvert).toBeUndefined();
    expect(args.device).toBeUndefined();
    expect(args.reporter).toBeUndefined();
    expect(args.trace).toBeUndefined();
    expect(args.video).toBeUndefined();
    expect(args.uiDevUrl).toBeUndefined();
  });

  it('a short-flag bundle in = form gives the value to the last flag', async () => {
    expect(await testArgs(['-wd=emulator-5554'])).toMatchObject({ watch: true, device: 'emulator-5554' });
  });

  it('a value flag early in a bundle takes the rest of it, never a rewritten long flag', async () => {
    // Standard short-option reading (`-dserial`): the device is "j=4". It must not become "--workers=4".
    const args = await testArgs(['-dj=4']);
    expect(args.device).toBe('j=4');
    expect(args.workers).toBeUndefined();
  });

  it.each(['configure', 'verify'])('ios network %s refuses an empty UDID', async (command) => {
    expect((await usageError(['ios', 'network', command, ''])).err).toMatch(/UDID.*tapsmith ios setup-device/);
  });

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

  it('ios build-agent keeps -v as --verbose', async () => {
    expect((await run(['ios', 'build-agent', '-v', '--team-id', 'ABC', '--cwd', '/r', '--derived-data-path=/d'])).calls)
      .toEqual([['iosBuildAgent', { verbose: true, teamId: 'ABC', cwd: '/r', derivedDataPath: '/d' }]]);
    expect((await run(['ios', 'build-agent'])).calls).toEqual([['iosBuildAgent', { verbose: false }]]);
  });

  it('create-avd passes its raw options through', async () => {
    expect((await run(['create-avd', '--api', '35', '--name=N', '--device', 'pixel_7', '--abi', 'x86_64', '--force', '--install-tools'])).calls)
      .toEqual([['createAvd', { api: '35', name: 'N', device: 'pixel_7', abi: 'x86_64', force: true, installTools: true }]]);
    expect((await run(['create-avd'])).calls).toEqual([['createAvd', { force: false, installTools: false }]]);
  });

  it('ios network configure needs a UDID and takes its options, --refresh included (PILOT-271)', async () => {
    expect((await usageError(['ios', 'network', 'configure'])).err).toMatch(/missing required argument 'udid'/);
    expect((await run(['ios', 'network', 'configure', 'U1', '--ssid', 'Home', '--device-name=Phone', '--fix-firewall'])).calls)
      .toEqual([['iosNetworkConfigure', { udid: 'U1', ssid: 'Home', deviceName: 'Phone', fixFirewall: true, refresh: false }]]);
    expect((await run(['ios', 'network', 'configure', '--refresh', 'U1'])).calls)
      .toEqual([['iosNetworkConfigure', { udid: 'U1', fixFirewall: false, refresh: true }]]);
  });

  it('ios network verify needs a UDID', async () => {
    await usageError(['ios', 'network', 'verify']);
    expect((await run(['ios', 'network', 'verify', 'U1'])).calls).toEqual([['iosNetworkVerify', { udid: 'U1' }]]);
  });

  it('ios setup-device takes --json (PILOT-270); ios network setup-simulator takes no options', async () => {
    expect((await run(['ios', 'setup-device'])).calls).toEqual([['iosSetupDevice', { json: false }]]);
    expect((await run(['ios', 'setup-device', '--json'])).calls).toEqual([['iosSetupDevice', { json: true }]]);
    expect((await run(['ios', 'network', 'setup-simulator'])).calls).toEqual([['iosNetworkSetupSimulator', {}]]);
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
    // Neither capture flag leaves the choice to init's default (PILOT-775).
    expect((await run(['init', '-y'])).calls[0]![1]).not.toHaveProperty('networkCapture');
    expect((await run(['init', '-y', '--no-network-capture'])).calls[0]![1]).toMatchObject({ networkCapture: false });
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
    [['init', '--json', 'yes'], 'UNKNOWN_FLAG'],
    [['verify', '--json', '--bogus'], 'BAD_ARGS'],
    [['doctor', '--json', '--bogus'], 'BAD_ARGS'],

    [['telemetry', '--json', 'toggle'], 'BAD_ARGS'],
    [['list-devices', '--json', '--bogus'], 'BAD_ARGS'],
    [['ios', 'setup-device', '--json', '--bogus'], 'BAD_ARGS'],
    [['ios', 'setup-device', 'extra', '--json'], 'BAD_ARGS'],
    [['-c', 'x.mjs', 'doctor', '--json'], 'BAD_ARGS'],
  ])('%j prints a JSON error with code %s on stdout', async (argv, code) => {
    const h = await usageError(argv);
    expect(h.err).toBe('');
    const parsed = JSON.parse(h.out) as { error: { code: string; message: string; fix: string } };
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBeTruthy();
    const command = argv[0] === 'ios' ? 'ios setup-device' : argv.find((t) => !t.startsWith('-') && t !== 'x.mjs');
    expect(parsed.error.fix).toBe(`Run: npx tapsmith ${command} --help`);
  });

  it('list-devices uses the shared envelope too (it used to print { error: <message> })', async () => {
    const h = await usageError(['list-devices', '--json', 'extra']);
    expect(h.err).toBe('');
    expect(JSON.parse(h.out)).toEqual({
      error: { code: 'BAD_ARGS', message: expect.stringMatching(/too many arguments/), fix: 'Run: npx tapsmith list-devices --help' },
    });
  });

  it.each([
    [['doctor', '--json'], 'doctor'],
    [['init', '--yes', '--json'], 'init'],
    [['ios', 'setup-device', '--json'], 'iosSetupDevice'],
  ])('%j: a handler that throws still prints the UNEXPECTED_ERROR envelope, exit 1', async (argv, handler) => {
    const out: string[] = [];
    const handlers = new Proxy({} as CliHandlers, {
      get: (_t, name) => async () => { if (name === handler) throw new Error('Cannot find module ./x.js'); },
    });
    const code = await runCli(argv, { handlers, version: '0.0.0', io: { out: (t) => out.push(t), err: () => {} } });
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({
      error: { code: 'UNEXPECTED_ERROR', message: 'Cannot find module ./x.js', fix: expect.stringContaining('without --json') },
    });
  });

  it('without --json, a handler that throws still reaches the fatal-error handler', async () => {
    const handlers = new Proxy({} as CliHandlers, { get: () => async () => { throw new Error('boom'); } });
    await expect(runCli(['doctor'], { handlers, version: '0.0.0', io: { out: () => {}, err: () => {} } })).rejects.toThrow('boom');
  });

  it('mcp-server usage errors go to stderr, keeping the stdio channel clean', async () => {
    const h = await usageError(['mcp-server', '--bogus']);
    expect(h.out).toBe('');
    expect(h.err).toMatch(/unknown option/);
  });
});

// ─── Nested commands (PILOT-271) ───

describe('tapsmith ios', () => {
  it.each([['ios'], ['ios', 'network']])('%j alone prints its help on stdout and exits 0, like a bare tapsmith', async (...argv) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.err).toBe('');
    expect(h.out).toContain(`Usage: tapsmith ${argv.join(' ')}`);
    expect(h.out).toBe((await run([...argv, '--help'])).out);
  });

  it('lists the two tracks in its help', async () => {
    const ios = (await run(['ios', '--help'])).out;
    for (const sub of ['setup-device', 'build-agent', 'network']) expect(ios).toContain(sub);
    const network = (await run(['ios', 'network', '--help'])).out;
    for (const sub of ['setup-simulator', 'configure', 'verify']) expect(network).toContain(sub);
    expect(network).toMatch(/setup-simulator\s+.*simulator/i);
  });

  it.each([
    [['ios', 'nope'], 'nope', 'tapsmith ios --help'],
    [['ios', 'nope', '--help'], 'nope', 'tapsmith ios --help'],
    [['ios', 'network', 'refresh', 'U1'], 'refresh', 'tapsmith ios network --help'],
    [['ios', 'network', 'nope', '-h'], 'nope', 'tapsmith ios network --help'],
  ])('%j is an unknown-command error naming its group', async (argv, word, hint) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`unknown command '${word}'`);
    expect(h.err).toContain(hint);
    expect(h.out).toBe('');
  });

  it('suggests the nearest subcommand', async () => {
    expect((await usageError(['ios', 'netwrk'])).err).toMatch(/Did you mean network\?/);
    expect((await usageError(['ios', 'network', 'verfy', 'U1'])).err).toMatch(/Did you mean verify\?/);
  });

  it.each([
    ['setup-ios'], ['setup-ios-device'], ['build-ios-agent'],
    ['configure-ios-network', 'U1'], ['refresh-ios-network', 'U1'], ['verify-ios-network', 'U1'],
  ])('the removed name %s is a plain unknown command (hard cut, no alias)', async (...argv) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`unknown command '${argv[0]}'`);
  });

  it('refuses a value flag given a flag at the leaf, as the docs guard does', async () => {
    const h = await usageError(['ios', 'network', 'configure', 'U1', '--ssid', '--refresh']);
    expect(h.err).toContain('If \'--refresh\' really is the value, write --ssid=--refresh');
    expect(h.err).toContain('tapsmith ios network configure --help');
    // The = form still takes it.
    expect((await run(['ios', 'network', 'configure', 'U1', '--ssid=--refresh'])).calls)
      .toEqual([['iosNetworkConfigure', { udid: 'U1', ssid: '--refresh', fixFirewall: false, refresh: false }]]);
  });

  it('refuses a single-dash long flag at the leaf', async () => {
    expect((await usageError(['ios', 'network', 'configure', 'U1', '-refresh'])).err).toContain('Did you mean --refresh?');
  });

  it('lets --help win at the leaf, even over a value flag missing its value', async () => {
    const h = await run(['ios', 'build-agent', '--team-id', '--help']);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toContain('Usage: tapsmith ios build-agent');
  });

  it('a group-level --help after a subcommand shows the subcommand\'s help', async () => {
    expect((await run(['ios', 'network', 'verify', '--help'])).out).toContain('Usage: tapsmith ios network verify');
  });

  it.each([['-v'], ['--version']])('%s before a bare group prints the version, as before any other command', async (flag) => {
    for (const argv of [[flag, 'ios'], [flag, 'ios', 'network']]) {
      const h = await run(argv);
      expect(h.code, argv.join(' ')).toBe(0);
      expect(h.out, argv.join(' ')).toBe('1.2.3\n');
    }
  });

  it('-h before a bare group never runs anything', async () => {
    const h = await run(['-h', 'ios', 'network']);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toMatch(/Usage: tapsmith/);
  });

  it('a bare group followed by -- is still a help request', async () => {
    const h = await run(['ios', '--']);
    expect(h.code).toBe(0);
    expect(h.err).toBe('');
    expect(h.out).toContain('Usage: tapsmith ios');
  });

  it.each([
    [['help', 'ios', 'network'], 'tapsmith ios network'],
    [['help', 'ios', 'network', 'configure'], 'tapsmith ios network configure'],
    [['ios', 'help', 'network', 'verify'], 'tapsmith ios network verify'],
    [['help', 'ios'], 'tapsmith ios'],
  ])('%j resolves the whole command path, git-style', async (argv, usage) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toContain(`Usage: ${usage} `);
  });

  it.each([
    [['help', 'ios', 'netwrk'], 'netwrk', 'tapsmith ios --help'],
    [['help', 'ios', 'network', 'nope'], 'nope', 'tapsmith ios network --help'],
    [['ios', 'help', 'nope'], 'nope', 'tapsmith ios --help'],
  ])('%j is an unknown-command error, not a help page', async (argv, word, hint) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`unknown command '${word}'`);
    expect(h.err).toContain(hint);
  });

  it('an option before a nested command is refused, and never moved to a command that lacks it', async () => {
    let h = await usageError(['-c', 'x.mjs', 'ios', 'network', 'verify', 'U1']);
    expect(h.err).toContain('unknown option \'-c\' (tapsmith ios network verify does not take it either)');
    expect(h.err).not.toContain('goes after the command');
    h = await usageError(['-c', 'x.mjs', 'ios']);
    expect(h.err).toContain('tapsmith ios does not take it either');
    h = await usageError(['--refresh', 'ios', 'network', 'configure', 'U1']);
    expect(h.err).toContain('\'--refresh\' goes after the command: tapsmith ios network configure --refresh');
  });

  it('a misplaced flag whose value names a command still finds the real command', async () => {
    let h = await usageError(['--platform', 'ios', 'init']);
    expect(h.err).toContain('\'--platform\' goes after the command: tapsmith init --platform');
    h = await run(['--json', '--platform', 'ios', 'init']);
    expect(h.code).toBe(1);
    expect(JSON.parse(h.out).error.code).toBe('UNKNOWN_FLAG');
  });

  it.each([[['--platform', 'ios']], [['--project', 'ios', 'network']]])('%j: a flag value that names only a group is not the command', async (argv) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`unknown option '${argv[0]}'`);
    expect(h.err).not.toContain('tapsmith ios');
  });

  it.each([
    [['--force-install', 'test', 'verify'], 'test'],
    [['--force-install', 'test', 'ios'], 'test'],
    [['-w', 'test', 'doctor'], 'test'],
  ])('%j: a positional that names a command is not the command', async (argv, command) => {
    const h = await usageError(argv);
    expect(h.err).toContain(`'${argv[0]}' goes after the command: tapsmith ${command} ${argv[0]}`);
  });

  it('--json before test with a positional named doctor is not doctor\'s JSON error', async () => {
    const h = await usageError(['--json', 'test', 'doctor']);
    expect(h.out).toBe('');
    expect(h.err).toContain('tapsmith test does not take it either');
  });

  it('--json misplaced before ios setup-device is reported as that command\'s JSON error', async () => {
    const h = await usageError(['--json', 'ios', 'setup-device']);
    expect(h.err).toBe('');
    expect(JSON.parse(h.out)).toEqual({
      error: { code: 'BAD_ARGS', message: expect.stringContaining("'--json' goes after the command: tapsmith ios setup-device --json"), fix: 'Run: npx tapsmith ios setup-device --help' },
    });
  });

  it('a boolean misplaced flag before a nested command names that command, not a top-level namesake', async () => {
    let h = await usageError(['--json', 'ios', 'network', 'verify', 'U1']);
    expect(h.out).toBe('');
    expect(h.err).toContain('tapsmith ios network verify does not take it either');
    h = await usageError(['--refresh', 'ios', 'network', 'verify', 'U1']);
    expect(h.err).toContain('tapsmith ios network verify does not take it either');
    expect(h.err).toContain('tapsmith ios network verify --help');
  });

  it.each([
    [['-v', 'help', 'test']], [['-v', 'help']], [['-v', 'ios', 'help', 'network']], [['--version', 'help', 'ios', 'network']],
  ])('%j: a root flag before help still applies', async (argv) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.out).toBe('1.2.3\n');
  });

  it.each([['-j4'], ['-wd'], ['-j=4']])('%s before test is recognised as a test flag', async (flag) => {
    const h = await usageError([flag, 'test']);
    expect(h.err).toContain(`'${flag}' goes after the command: tapsmith test ${flag}`);
  });

  it.each([
    [['ios', 'help', '--help'], 'tapsmith ios'],
    [['ios', 'network', 'help', '-h'], 'tapsmith ios network'],
    [['help', '--help'], 'tapsmith'],
    [['help', 'ios', 'network', 'help', 'verify'], 'tapsmith ios network verify'],
  ])('%j shows help and exits 0', async (argv, usage) => {
    const h = await run(argv);
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out).toContain(`Usage: ${usage} `);
  });
});

// ─── Banner ───

// `verify` prints the banner, then runs `tapsmith test` as a child, which
// printed it again (PILOT-540).
describe('claimBanner()', () => {
  it('claims the banner once per process tree, through the environment children inherit', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(claimBanner(env)).toBe(true);
    expect(claimBanner(env)).toBe(false);
    // A child spawned with `{ ...process.env }` sees the claim.
    expect(claimBanner({ ...env })).toBe(false);
  });
});

describe('printsBanner()', () => {
  it('keeps --json output byte-clean', async () => {
    for (const command of ['list-devices', 'doctor', 'verify', 'ios setup-device']) {
      // The options object exactly as the command's handler receives it.
      const h = await run([...command.split(' '), '--json']);
      expect(printsBanner(command, h.calls[0]![1] as Record<string, unknown>), command).toBe(false);
      expect(printsBanner(command, { json: false }), command).toBe(true);
    }
  });

  it('never prints for the protocol, settings, wizard and test commands', () => {
    for (const command of ['mcp-server', 'telemetry', 'init', 'test']) {
      expect(printsBanner(command, {}), command).toBe(false);
    }
  });

  it('prints for the iOS commands, by their full path', () => {
    for (const command of ['ios setup-device', 'ios build-agent', 'ios network setup-simulator', 'ios network configure', 'ios network verify']) {
      expect(printsBanner(command, {}), command).toBe(true);
    }
    for (const command of ['ios', 'ios network', 'setup-ios', 'configure-ios-network']) {
      expect(printsBanner(command, {}), command).toBe(false);
    }
  });

  it('hands the banner hook the full command path', async () => {
    const seen: string[] = [];
    const handlers = new Proxy({} as CliHandlers, { get: () => async () => {} });
    await runCli(['ios', 'network', 'configure', 'U1'], {
      handlers, version: '1', io: { out: () => {}, err: () => {} }, beforeAction: (command) => { seen.push(command); },
    });
    expect(seen).toEqual(['ios network configure']);
  });
});

// ─── Refusals before a handler runs (PILOT-560) ───

describe('refuse hook', () => {
  async function refused(argv: string[]): Promise<Harness & { banners: string[] }> {
    const calls: Array<[string, unknown]> = [];
    const banners: string[] = [];
    const handlers = new Proxy({} as CliHandlers, {
      get: (_target, name: string) => async (opts: unknown) => { calls.push([name, opts]); },
    });
    let out = '';
    let err = '';
    const code = await runCli(argv, {
      handlers,
      version: '1.2.3',
      io: { out: (s) => { out += s; }, err: (s) => { err += s; } },
      beforeAction: (command) => { banners.push(command); },
      refuse: (command) => (command === 'test' || command === 'verify'
        ? { code: 'NOPE', message: `cannot ${command} here`, fix: 'do the other thing' }
        : undefined),
    });
    return { code, out, err, calls, banners };
  }

  it('exits 1 with the message and fix, without the banner or the handler', async () => {
    const h = await refused(['test', 'a.test.ts']);
    expect(h.code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.banners).toEqual([]);
    expect(h.out).toBe('');
    expect(h.err).toBe('cannot test here\ndo the other thing\n');
  });

  it('answers --json with the error envelope on stdout', async () => {
    const h = await refused(['verify', '--json']);
    expect(h.code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err).toBe('');
    expect(JSON.parse(h.out)).toEqual({ error: { code: 'NOPE', message: 'cannot verify here', fix: 'do the other thing' } });
  });

  it('runs a command it does not refuse', async () => {
    const h = await refused(['doctor']);
    expect(h.code).toBe(0);
    expect(h.calls.map(([name]) => name)).toEqual(['doctor']);
  });
});
