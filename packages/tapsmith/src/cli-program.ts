/**
 * The `tapsmith` command tree (PILOT-260).
 *
 * Every command, its flags, its help and its usage errors are declared here
 * on commander, the parser Playwright's own CLI uses. This module only
 * parses: each command's work is an injected handler (the real ones live in
 * `cli.ts` and import the heavy modules lazily), which is what lets the whole
 * surface be unit-tested without spawning anything.
 *
 * Commander covers most of the contract. The three gaps it leaves are filled
 * in `runCli`:
 *
 * - A value flag followed by another flag (`--device --shard=abc`) is an
 *   error, not a value. The `=` form still takes anything, so a value that
 *   really starts with `-` stays expressible (`--grep=-slow`).
 * - `-j=4` short-equals forms are rewritten to `--workers=4`; commander would
 *   read the value as `=4`.
 * - An unknown command is an error even when `--help` is also on the command
 *   line; commander would print the top-level help and exit 0.
 */

import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { DEFAULT_API_LEVEL, DEFAULT_DEVICE_PROFILE, defaultAbi } from './avd-defaults.js';
import { TELEMETRY_DOCS_URL } from './telemetry.js';
import { TRACE_MODES, type TraceMode } from './trace/types.js';
import { VIDEO_MODES, type VideoMode } from './video/types.js';

// ─── Parsed options, per command ───

/** `tapsmith test`. Field names match what the run body has always read. */
export interface TestCommandArgs {
  files: string[];
  device?: string;
  workers?: number;
  shard?: { current: number; total: number };
  trace?: TraceMode;
  video?: VideoMode;
  watch: boolean;
  ui: boolean;
  uiPort?: number;
  uiDevUrl?: string;
  config?: string;
  forceInstall: boolean;
  /** Set on the child of the tsx re-exec. */
  tsxReexec: boolean;
  grep?: RegExp;
  grepInvert?: RegExp;
  reporter?: string;
  project?: string[];
}

/** Raw `tapsmith init` flags. `init-noninteractive.ts` validates the values, keeping its error codes. */
export interface InitCommandOptions {
  yes: boolean;
  json: boolean;
  force: boolean;
  platform?: string;
  apk?: string;
  package?: string;
  app?: string;
  bundleId?: string;
  avd?: string;
  simulator?: string;
  deviceType?: string;
  networkCapture: boolean;
  exampleTest: boolean;
  agentsMd: boolean;
}

/** Raw `tapsmith create-avd` flags. `create-avd.ts` applies defaults and validates. */
export interface CreateAvdCommandOptions {
  api?: string;
  name?: string;
  device?: string;
  abi?: string;
  force: boolean;
  installTools: boolean;
}

export interface IosNetworkCommandOptions {
  udid: string;
  ssid?: string;
  deviceName?: string;
  fixFirewall: boolean;
}

export type TelemetryAction = 'status' | 'enable' | 'disable';

/**
 * What each command does once its arguments parsed. A handler may return an
 * exit code; returning nothing means 0 (or whatever it set on `process`).
 */
export interface CliHandlers {
  test(args: TestCommandArgs): Promise<number | void>;
  showTrace(opts: { file: string }): Promise<number | void>;
  showReport(opts: { dir?: string }): Promise<number | void>;
  mergeReports(opts: { dir?: string; config?: string }): Promise<number | void>;
  listDevices(opts: { json: boolean }): Promise<number | void>;
  setupIos(opts: Record<string, never>): Promise<number | void>;
  setupIosDevice(opts: Record<string, never>): Promise<number | void>;
  buildIosAgent(opts: { teamId?: string; cwd?: string; derivedDataPath?: string; verbose: boolean }): Promise<number | void>;
  createAvd(opts: CreateAvdCommandOptions): Promise<number | void>;
  configureIosNetwork(opts: IosNetworkCommandOptions): Promise<number | void>;
  refreshIosNetwork(opts: IosNetworkCommandOptions): Promise<number | void>;
  verifyIosNetwork(opts: { udid: string }): Promise<number | void>;
  init(opts: InitCommandOptions): Promise<number | void>;
  verify(opts: { json: boolean; config?: string }): Promise<number | void>;
  doctor(opts: { json: boolean; config?: string }): Promise<number | void>;
  mcpServer(opts: { config?: string }): Promise<number | void>;
  telemetry(opts: { action?: TelemetryAction; json: boolean; config?: string }): Promise<number | void>;
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface RunCliDeps {
  handlers: CliHandlers;
  version: string;
  /** Defaults to process.stdout / process.stderr. */
  io?: CliIo;
  /** Called once a command's arguments parsed, before its handler (the banner hook). */
  beforeAction?(command: string, opts: Record<string, unknown>): void;
}

/** Hidden `test` flag the tsx re-exec (cli.ts) appends for its child. */
const TSX_REEXEC_FLAG = '--__tsx-reexec';

// ─── Value parsers ───

function positiveInt(flag: string) {
  return (value: string): number => {
    if (!/^\d+$/.test(value) || Number(value) < 1) {
      throw new InvalidArgumentError(`${flag} must be a positive integer.`);
    }
    return Number(value);
  };
}

function nonNegativeInt(flag: string) {
  return (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError(`${flag} must be a non-negative integer.`);
    }
    return Number(value);
  };
}

function parseShard(value: string): { current: number; total: number } {
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new InvalidArgumentError('--shard must be x/y (e.g. --shard=1/4).');
  }
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current < 1 || current > total) {
    throw new InvalidArgumentError(`--shard ${current}/${total}: x must be between 1 and y.`);
  }
  return { current, total };
}

/** `pattern` or `/pattern/flags`, as `--grep` has always accepted. */
function regex(flag: string) {
  return (value: string): RegExp => {
    try {
      const match = value.match(/^\/(.*)\/([dgimsuvy]*)$/);
      return match ? new RegExp(match[1]!, match[2]) : new RegExp(value);
    } catch (err) {
      throw new InvalidArgumentError(`${flag} is not a valid regular expression: ${(err as Error).message}`);
    }
  };
}

/** A value flag given as `--flag=` with nothing after the `=`. */
function nonEmpty(flag: string) {
  return (value: string): string => {
    if (!value) throw new InvalidArgumentError(`${flag} needs a value.`);
    return value;
  };
}

function collectProject(value: string, previous: string[] | undefined): string[] {
  if (!value) throw new InvalidArgumentError('--project needs a project name.');
  return [...(previous ?? []), value];
}

// ─── Command tree ───

const ROOT_EXAMPLES = `
Examples:
  tapsmith test                       Run every test file
  tapsmith test login.test.ts -j 2    Run one file on two devices
  tapsmith test --ui                  Open UI mode
  tapsmith test --shard=1/4           Run shard 1 of 4 (CI)
  tapsmith show-trace trace.zip       Open a trace in the viewer
  tapsmith init --yes                 Set up a project non-interactively
  tapsmith help <command>             Show a command's options`;

const TEST_EXAMPLES = `
Examples:
  tapsmith test
  tapsmith test tests/login.test.ts --device emulator-5554
  tapsmith test --workers 4 --trace retain-on-failure
  tapsmith test --shard 2/4 --reporter junit
  tapsmith test --grep "checkout" --project android
  tapsmith test --watch
  tapsmith test --ui --ui-port 8080

A value that starts with "-" needs the = form: --grep=-slow`;

const INIT_EXAMPLES = `
Runs an interactive wizard in a terminal when given no options. Pass --yes
and/or explicit flags to run non-interactively (scripts and AI agents).

Examples:
  npx tapsmith init --yes
  npx tapsmith init --yes --platform android --apk ./app-debug.apk
  npx tapsmith doctor --json   # check the environment first`;

const MCP_EXAMPLES = `
Examples:
  codex mcp add tapsmith -- npx tapsmith mcp-server
  claude mcp add tapsmith -- npx tapsmith mcp-server
  npx tapsmith mcp-server --config tapsmith.config.ios.mjs`;

const TELEMETRY_HELP = `
Actions:
  status    Show whether anonymous usage telemetry is on, and why not if it is off (default)
  enable    Turn it on for this machine (does not override TAPSMITH_TELEMETRY=0 or \`telemetry: false\`)
  disable   Turn it off for this machine, for every project

Details: ${TELEMETRY_DOCS_URL}`;

const VERIFY_IOS_NETWORK_HELP = `
Starts the Tapsmith proxy, asks you to load an HTTPS page in Safari on the
device, then reports whether Tapsmith saw the request and could decrypt it.
Run it after configure-ios-network, before running tests.`;

/** Commands whose `--json` output also carries usage errors. */
const JSON_ERROR_COMMANDS = new Set(['init', 'verify', 'doctor', 'list-devices', 'telemetry']);

interface ParseState {
  /** The command being parsed, once known. */
  command?: string;
  /** Usage errors go out as JSON on stdout. */
  json: boolean;
  /** A usage error withheld from stderr, to print as JSON instead. */
  jsonError?: string;
  exitCode: number;
}

function buildProgram(deps: RunCliDeps, io: CliIo, state: ParseState): Command {
  const { handlers } = deps;
  const program = new Command('tapsmith');

  // Set before any subcommand is added: .command() copies these settings.
  program
    .description('Mobile app testing framework')
    .usage('<command> [options]')
    .version(deps.version, '-v, --version', 'Print the version')
    .helpOption('-h, --help', 'Show help')
    .helpCommand('help [command]', 'Show help for a command')
    // Root flags only before the command, so `build-ios-agent -v` is its
    // --verbose and `test -v` is an unknown option, not the version.
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError(true)
    // Descriptions carry their own defaults and choices, worded for people;
    // commander's generated "(default: false)" / "(choices: …)" suffixes are noise.
    .configureHelp({
      optionDescription: (option) => option.description,
      argumentDescription: (argument) => argument.description,
    })
    .configureOutput({
      writeOut: (text) => io.out(text),
      writeErr: (text) => io.err(text),
      outputError: (text) => {
        if (state.json) {
          state.jsonError = text.replace(/^error: /, '').trim();
          return;
        }
        const help = state.command ? `tapsmith ${state.command} --help` : 'tapsmith --help';
        io.err(`${text.trimEnd()}\nRun '${help}' for usage.\n`);
      },
    })
    .addHelpText('after', ROOT_EXAMPLES);

  const act = <T>(name: string, handler: (opts: T) => Promise<number | void>) => async (opts: T): Promise<void> => {
    deps.beforeAction?.(name, opts as Record<string, unknown>);
    const code = await handler(opts);
    if (typeof code === 'number') state.exitCode = code;
  };

  const configOption = (): Option => new Option('-c, --config <path>', 'Path to the config file (default: tapsmith.config.{ts,js,mjs})')
    .argParser(nonEmpty('--config'));
  const jsonOption = (what = 'Machine-readable output (also on errors)'): Option => new Option('--json', what).default(false);

  // ── test ──
  program
    .command('test')
    .description('Run test files')
    .argument('[files...]', 'Test files or globs (default: the config\'s testMatch)')
    .option('-d, --device <serial>', 'Target a specific device or simulator by serial/UDID')
    .option('-j, --workers <n>', 'Number of parallel workers (default: 1)', positiveInt('--workers'))
    .option('--shard <x/y>', 'Run shard x of y across CI machines (e.g. 1/4)', parseShard)
    .addOption(new Option('--trace [mode]', `Record traces. Modes: ${TRACE_MODES.join(', ')} (on when no mode is given)`)
      .choices(TRACE_MODES).preset('on'))
    .addOption(new Option('--video [mode]', `Record the device screen for each test. Modes: same as --trace (on when no mode is given)`)
      .choices(VIDEO_MODES).preset('on'))
    .option('-w, --watch', 'Watch test files and re-run on change', false)
    .option('--ui', 'Open interactive UI mode', false)
    .option('--ui-port <port>', 'UI mode server port (default: a free port)', nonNegativeInt('--ui-port'))
    .addOption(new Option('--ui-dev-url <url>', 'Serve UI mode from a dev server (development only)').argParser(nonEmpty('--ui-dev-url')).hideHelp())
    .addOption(configOption())
    .option('-g, --grep <pattern>', 'Only run tests whose full name matches this regex', regex('--grep'))
    .option('--grep-invert <pattern>', 'Skip tests whose full name matches this regex', regex('--grep-invert'))
    .option('--reporter <name>', 'Reporter: list, line, dot, json, junit, html, github, blob')
    .option('--project <name>', 'Only run this project from the config (repeatable; dependencies run too)', collectProject)
    .option('--force-install', 'Reinstall the app even if it is already installed', false)
    .addOption(new Option(TSX_REEXEC_FLAG).hideHelp().default(false))
    .addHelpText('after', TEST_EXAMPLES)
    .action(async (files: string[], opts: Record<string, unknown>) => {
      // An empty --device / --reporter means not given: `--device "$SERIAL"`
      // with an empty variable has always fallen back to automatic selection.
      const args: TestCommandArgs = {
        files,
        device: (opts.device as string | undefined) || undefined,
        workers: opts.workers as number | undefined,
        shard: opts.shard as TestCommandArgs['shard'],
        trace: opts.trace as TraceMode | undefined,
        video: opts.video as VideoMode | undefined,
        watch: opts.watch as boolean,
        ui: opts.ui as boolean,
        uiPort: opts.uiPort as number | undefined,
        uiDevUrl: opts.uiDevUrl as string | undefined,
        config: opts.config as string | undefined,
        forceInstall: opts.forceInstall as boolean,
        tsxReexec: opts.__tsxReexec as boolean,
        grep: opts.grep as RegExp | undefined,
        grepInvert: opts.grepInvert as RegExp | undefined,
        reporter: (opts.reporter as string | undefined) || undefined,
        project: opts.project as string[] | undefined,
      };
      await act('test', handlers.test)(args);
    });

  // ── reports and traces ──
  program
    .command('show-trace')
    .description('Open a trace in the trace viewer')
    .argument('<file>', 'Trace archive (.zip)')
    .action((file: string) => act('show-trace', handlers.showTrace)({ file }));

  program
    .command('show-report')
    .description('Open the HTML test report')
    .argument('[dir]', 'Report directory (default: tapsmith-report)')
    .action((dir: string | undefined) => act('show-report', handlers.showReport)({ dir }));

  program
    .command('merge-reports')
    .description('Merge blob reports from sharded runs')
    .argument('[dir]', 'Blob report directory (default: blob-report)')
    .addOption(configOption())
    .action((dir: string | undefined, opts: { config?: string }) =>
      act('merge-reports', handlers.mergeReports)({ dir, config: opts.config }));

  // ── devices and environment ──
  program
    .command('list-devices')
    .description('List connected devices (Android, iOS simulator, iOS physical)')
    .addOption(jsonOption('Output as JSON for scripting'))
    .action((opts: { json: boolean }) => act('list-devices', handlers.listDevices)({ json: opts.json }));

  program
    .command('doctor')
    .description('Check system health')
    .addOption(jsonOption('Machine-readable report, with fixes and the device inventory'))
    .addOption(configOption())
    .action((opts: { json: boolean; config?: string }) => act('doctor', handlers.doctor)({ json: opts.json, config: opts.config }));

  program
    .command('verify')
    .description('Run one test end-to-end to prove the setup works')
    .addOption(jsonOption())
    .addOption(configOption())
    .addHelpText('after', '\nScaffolds a throwaway smoke test if the project has no tests yet.')
    .action((opts: { json: boolean; config?: string }) => act('verify', handlers.verify)({ json: opts.json, config: opts.config }));

  program
    .command('init')
    .description('Initialize a new Tapsmith project (interactive wizard, or --yes for scripts)')
    .option('-y, --yes', 'Accept auto-detected defaults for anything not specified', false)
    .option('--platform <list>', 'android, ios, or android,ios (default: inferred from android/ and ios/)')
    .option('--apk <path>', 'Android APK (default: auto-detected under android/**/build/outputs/apk/)')
    .option('--package <id>', 'Android package name (default: read from the APK)')
    .option('--app <path>', 'iOS simulator .app bundle (default: auto-detected under ios/)')
    .option('--bundle-id <id>', 'iOS bundle identifier (default: read from Info.plist)')
    .option('--avd <name>', 'Android AVD to auto-launch (default: first available)')
    .option('--simulator <name>', 'iOS simulator name (default: newest available iPhone)')
    .option('--device-type <type>', 'emulator, physical or both (default: emulator)')
    .option('--network-capture', 'Enable HTTP(S) trace capture', false)
    .option('--no-example-test', 'Skip scaffolding tests/example.test.ts')
    .option('--no-agents-md', 'Skip scaffolding the AGENTS.md section')
    .option('--force', 'Overwrite an existing tapsmith.config.*', false)
    .addOption(jsonOption())
    .addHelpText('after', INIT_EXAMPLES)
    .action((opts: InitCommandOptions) => act('init', handlers.init)({ ...opts }));

  program
    .command('mcp-server')
    .description('Run the MCP server for LLM/agent integration (stdio transport)')
    .addOption(configOption())
    .addHelpText('after', MCP_EXAMPLES)
    .action((opts: { config?: string }) => act('mcp-server', handlers.mcpServer)({ ...opts }));

  program
    .command('telemetry')
    .description('Show or switch anonymous usage telemetry for this machine')
    .addArgument(new Argument('[action]', 'status, enable or disable (default: status)').choices(['status', 'enable', 'disable']))
    .addOption(jsonOption('Output as JSON'))
    .addOption(configOption())
    .addHelpText('after', TELEMETRY_HELP)
    .action((action: TelemetryAction | undefined, opts: { json: boolean; config?: string }) =>
      act('telemetry', handlers.telemetry)({ action, json: opts.json, config: opts.config }));

  // ── Android setup ──
  program
    .command('create-avd')
    .description('Create an Android AVD that supports HTTPS network capture')
    .option('--api <level>', `Android API level (default: ${DEFAULT_API_LEVEL})`)
    .option('--name <name>', 'AVD name (default: Tapsmith_Phone_API_<api>)')
    .option('--device <profile>', `avdmanager device profile (default: ${DEFAULT_DEVICE_PROFILE})`)
    .option('--abi <abi>', `System image ABI (default: ${defaultAbi()} on this machine)`)
    .option('--force', 'Overwrite an existing AVD with the same name', false)
    .option('--install-tools', 'Install the SDK command-line tools without prompting if they are missing', false)
    .addHelpText('after', '\nDownloads a Google APIs system image (rootable, unlike the Google Play images\nAndroid Studio preselects) with sdkmanager and creates the AVD with avdmanager.')
    .action((opts: CreateAvdCommandOptions) => act('create-avd', handlers.createAvd)({ ...opts }));

  // ── iOS setup ──
  program
    .command('setup-ios')
    .description('First-run setup for iOS network capture (macOS only)')
    .action(() => act('setup-ios', handlers.setupIos)({}));

  program
    .command('setup-ios-device')
    .description('Preflight checklist for physical iOS device testing')
    .action(() => act('setup-ios-device', handlers.setupIosDevice)({}));

  program
    .command('build-ios-agent')
    .description('Build the signed TapsmithAgent runner for physical iOS devices')
    .option('--team-id <id>', 'Apple Developer team ID (default: auto-detected)')
    .option('--cwd <path>', 'Path to the Tapsmith repo root (default: the working directory)')
    .option('--derived-data-path <path>', 'Where to write build products (default: ios-agent/.build-device)')
    .option('-v, --verbose', 'Stream raw xcodebuild output', false)
    .action((opts: { teamId?: string; cwd?: string; derivedDataPath?: string; verbose: boolean }) =>
      act('build-ios-agent', handlers.buildIosAgent)({ ...opts }));

  for (const [name, verb, handler] of [
    ['configure-ios-network', 'Generate', handlers.configureIosNetwork],
    ['refresh-ios-network', 'Regenerate', handlers.refreshIosNetwork],
  ] as const) {
    program
      .command(name)
      .description(`${verb} a network capture profile (.mobileconfig) for a physical iOS device`)
      .argument('<udid>', 'Device UDID (see tapsmith setup-ios-device)')
      .option('--ssid <name>', 'Wi-Fi SSID the profile targets (default: the host\'s current network)')
      .option('--device-name <name>', 'Friendly name for the profile (default: the device\'s name)')
      .option('--fix-firewall', 'Disable macOS Application Firewall stealth mode via sudo (prompts once)', false)
      .action((udid: string, opts: Omit<IosNetworkCommandOptions, 'udid'>) => act(name, handler)({ udid, ...opts }));
  }

  program
    .command('verify-ios-network')
    .description('Verify HTTPS capture for a normal system-trust client on a physical iOS device')
    .argument('<udid>', 'Device UDID')
    .addHelpText('after', VERIFY_IOS_NETWORK_HELP)
    .action((udid: string) => act('verify-ios-network', handlers.verifyIosNetwork)({ udid }));

  return program;
}

// ─── Pre-parse ───

const ROOT_FLAGS = new Set(['-h', '--help', '-v', '--version']);
const HELP_FLAGS = new Set(['-h', '--help']);

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/** The first token that names a command, if everything before it is a root flag. */
function commandIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('-')) return i;
    if (!ROOT_FLAGS.has(token)) return -1;
  }
  return -1;
}

/**
 * For a bundle of short flags (`-wd`), the value flag that would take the
 * next token as its value: one whose letter ends the bundle. A value flag
 * earlier in the bundle takes the rest of the bundle instead (`-wdserial`).
 */
function bundleEndingInValueFlag(token: string, byFlag: Map<string, Option>): Option | undefined {
  if (!/^-[a-zA-Z]{2,}$/.test(token)) return undefined;
  for (let k = 1; k < token.length; k++) {
    const option = byFlag.get(`-${token[k]}`);
    if (option) return k === token.length - 1 ? option : undefined;
  }
  return undefined;
}

/**
 * Rewrite `-j=4` to `--workers=4`, and refuse a flag where a value flag
 * expects its value. Returns the argv commander should parse; reports a
 * refused value through `cmd.error`, which throws.
 */
function prepareCommandArgs(cmd: Command, args: string[]): string[] {
  const valueOptions = cmd.options.filter((o) => o.required);
  const byFlag = new Map<string, Option>();
  for (const option of valueOptions) {
    if (option.long) byFlag.set(option.long, option);
    if (option.short) byFlag.set(option.short, option);
  }

  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') {
      // The tsx re-exec appends its marker to the user's argv, so it can land
      // after `--`; it is never a file.
      const operands = args.slice(i + 1);
      if (operands.includes(TSX_REEXEC_FLAG)) out.push(TSX_REEXEC_FLAG);
      out.push('--', ...operands.filter((t) => t !== TSX_REEXEC_FLAG));
      break;
    }
    const shortEquals = /^(-[a-zA-Z])=(.*)$/s.exec(token);
    if (shortEquals) {
      const option = byFlag.get(shortEquals[1]!);
      if (option?.long) {
        out.push(`${option.long}=${shortEquals[2]}`);
        continue;
      }
    }
    const next = args[i + 1];
    const option = byFlag.get(token) ?? bundleEndingInValueFlag(token, byFlag);
    if (option && next !== undefined && next.startsWith('-') && next !== '-') {
      cmd.error(
        `error: option '${option.flags}' argument missing (got the flag '${next}'). `
          + `If '${next}' really is the value, write ${option.long}=${next}`,
        { code: 'commander.optionMissingArgument', exitCode: 1 },
      );
    }
    out.push(token);
  }
  return out;
}

function jsonErrorCode(command: string, commanderCode: string): string {
  if (command === 'init') {
    // init has always called any token it did not know, positional or not, an unknown flag.
    if (commanderCode === 'commander.unknownOption' || commanderCode === 'commander.excessArguments') return 'UNKNOWN_FLAG';
    if (commanderCode === 'commander.optionMissingArgument') return 'MISSING_FLAG_VALUE';
  }
  return 'BAD_ARGS';
}

// ─── Entry ───

/**
 * Parse `argv` (the arguments after `tapsmith`) and run the matching
 * handler. Resolves to the exit code: usage errors are reported and resolve
 * to 1; anything a handler throws propagates.
 */
export async function runCli(argv: string[], deps: RunCliDeps): Promise<number> {
  const io = deps.io ?? {
    out: (text) => { process.stdout.write(text); },
    err: (text) => { process.stderr.write(text); },
  };
  const state: ParseState = { json: false, exitCode: 0 };
  const program = buildProgram(deps, io, state);

  if (argv.length === 0) {
    io.out(program.helpInformation());
    return 0;
  }

  try {
    let args = argv;
    const index = commandIndex(argv);
    if (index >= 0) {
      const name = argv[index]!;
      const target = name === 'help' ? argv[index + 1] : name;
      const cmd = target === undefined ? undefined : findCommand(program, target);
      if (target !== undefined && !cmd && !target.startsWith('-')) {
        // Unknown command: let commander report it, with its suggestion,
        // instead of answering a --help that came with it.
        args = [target];
      } else if (cmd && name !== 'help') {
        state.command = name;
        const rest = argv.slice(index + 1);
        const end = rest.indexOf('--');
        const flags = end >= 0 ? rest.slice(0, end) : rest;
        if (flags.some((t) => HELP_FLAGS.has(t))) {
          // Help wins over everything else on the command line, including a
          // value flag left without its value (`init --platform --help`).
          args = [...argv.slice(0, index + 1), '--help'];
        } else {
          state.json = JSON_ERROR_COMMANDS.has(name) && flags.includes('--json');
          args = [...argv.slice(0, index + 1), ...prepareCommandArgs(cmd, rest)];
        }
      }
    } else {
      // `tapsmith -c ci.mjs test`: the old parser took options anywhere.
      const misplaced = argv.find((t) => t.startsWith('-') && !ROOT_FLAGS.has(t));
      const later = argv.find((t) => !t.startsWith('-') && findCommand(program, t));
      if (misplaced && later) {
        program.error(
          `error: unknown option '${misplaced}'. '${misplaced}' goes after the command: tapsmith ${later} ${misplaced} …`,
          { code: 'commander.unknownOption', exitCode: 1 },
        );
      }
    }
    await program.parseAsync(args, { from: 'user' });
    return state.exitCode;
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    if (state.json && state.command && err.exitCode !== 0) {
      io.out(JSON.stringify({
        error: {
          code: jsonErrorCode(state.command, err.code),
          message: state.jsonError ?? err.message,
          fix: `Run: npx tapsmith ${state.command} --help`,
        },
      }, null, 2) + '\n');
    }
    return err.exitCode;
  }
}
