/**
 * `tapsmith telemetry [status|enable|disable] [--json] [-c <config>]`
 *
 * The switch users expect from Next.js and Astro: a machine-wide toggle that
 * needs no config edit and no env var, plus a status command that says
 * whether this process would report and which of the three switches (env,
 * config, machine) decided it. See `docs/telemetry.md`.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, configPathOf, type TapsmithConfig } from './config.js';
import type { TelemetryAction } from './cli-program.js';
import { telemetry as defaultTelemetry, TELEMETRY_DOCS_URL, type Telemetry, type TelemetryStatus } from './telemetry.js';

export interface TelemetryCommandDeps {
  telemetry?: Telemetry;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Loads the project config for `status`; swapped out by tests. */
  loadConfig?: (configFile?: string) => Promise<TapsmithConfig>;
}

export interface TelemetryCommandArgs {
  action?: TelemetryAction;
  json: boolean;
  config?: string;
}

function tilde(file: string): string {
  const home = os.homedir();
  return home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** Everything the config load told us, shared by every subcommand. */
interface ConfigView {
  status: TelemetryStatus;
  configPath: string | undefined;
  /** Set when loading the config threw: a file that exists but cannot be imported, or a validation error. */
  configError: string | undefined;
}

/**
 * Load the project config best-effort and fold it into the telemetry status.
 * Every subcommand goes through this so `enable`/`disable` account for a
 * `telemetry: false` config exactly as `status` does (PILOT-330 review).
 */
async function resolveConfigView(
  telemetry: Telemetry,
  load: (configFile?: string) => Promise<TapsmithConfig>,
  configFile: string | undefined,
): Promise<ConfigView> {
  let config: TapsmithConfig | undefined;
  let configError: string | undefined;
  try {
    config = await load(configFile);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  const configPath = config ? configPathOf(config) : undefined;
  return { status: telemetry.status(config), configPath, configError };
}

function configNote(view: ConfigView): string | undefined {
  if (view.configError) {
    return `the config could not be loaded (${view.configError}); its \`telemetry\` key was not consulted`;
  }
  return undefined;
}

function jsonPayload(view: ConfigView): Record<string, unknown> {
  return {
    ...view.status,
    configPath: view.configPath ?? null,
    configConsulted: !configNote(view),
    docs: TELEMETRY_DOCS_URL,
  };
}

function describe(view: ConfigView): string {
  const { status } = view;
  const lines: string[] = [];
  if (status.enabled) {
    lines.push(status.debug
      ? 'Telemetry is enabled in dry-run mode: TAPSMITH_TELEMETRY_DEBUG is set, so events print to stderr and nothing is sent.'
      : 'Telemetry is enabled.');
    lines.push('  One anonymous event per test-file run: run mode, platform, pass/fail counts, SDK/Node/OS versions.');
    lines.push('  Never test names, locators, app identifiers, or file paths.');
    lines.push(`  Anonymous id: ${status.anonymousId ?? '(none yet — created on the first run)'}  (${tilde(status.stateFile)})`);
    lines.push('  Disable: tapsmith telemetry disable · TAPSMITH_TELEMETRY=0 · telemetry: false in tapsmith.config.ts');
  } else {
    const why = status.reason === 'env'
      ? 'TAPSMITH_TELEMETRY or DO_NOT_TRACK is set in this environment'
      : status.reason === 'config'
        ? `telemetry: false in ${view.configPath ?? 'the config'}`
        : `machine-wide, via \`tapsmith telemetry disable\` (${tilde(status.stateFile)})`;
    lines.push(`Telemetry is disabled (${why}).`);
    if (status.reason === 'machine') lines.push('  Re-enable: tapsmith telemetry enable');
  }
  const note = configNote(view);
  if (note) lines.push(`  Note: ${note}.`);
  lines.push(`  Docs: ${TELEMETRY_DOCS_URL}`);
  return lines.join('\n') + '\n';
}

/** Runs the command and returns the process exit code. */
export async function runTelemetryCommand(args: TelemetryCommandArgs, deps: TelemetryCommandDeps = {}): Promise<number> {
  const telemetry = deps.telemetry ?? defaultTelemetry;
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  const load = deps.loadConfig ?? ((configFile?: string) => loadConfig(undefined, configFile));

  if (args.action === 'enable' || args.action === 'disable') {
    const enabling = args.action === 'enable';
    if (!telemetry.setMachineEnabled(enabling)) {
      const stateFile = telemetry.status(undefined).stateFile;
      stderr(`Could not write ${tilde(stateFile)}. `
        + (enabling ? 'Telemetry stays as it was.\n' : 'Set TAPSMITH_TELEMETRY=0 in your shell instead.\n'));
      return 1;
    }
    // Fold the project config in, so `enable` under `telemetry: false` reports
    // the truth and the JSON shape matches `status` (PILOT-330 review).
    const view = await resolveConfigView(telemetry, load, args.config);
    if (args.json) {
      stdout(JSON.stringify(jsonPayload(view), null, 2) + '\n');
      return 0;
    }
    if (enabling) {
      stdout(`Telemetry enabled for this machine (${tilde(view.status.stateFile)}).\n`);
      if (!view.status.enabled) {
        stdout(`  Still off here: ${view.status.reason === 'env'
          ? 'TAPSMITH_TELEMETRY or DO_NOT_TRACK is set in this environment.'
          : `the project config sets telemetry: false${view.configPath ? ` in ${view.configPath}` : ''}.`}\n`);
      }
    } else {
      stdout(`Telemetry disabled for this machine (${tilde(view.status.stateFile)}). Re-enable with \`tapsmith telemetry enable\`.\n`);
    }
    return 0;
  }

  // status (the default)
  const view = await resolveConfigView(telemetry, load, args.config);
  if (args.json) {
    stdout(JSON.stringify(jsonPayload(view), null, 2) + '\n');
  } else {
    stdout(describe(view));
  }
  return 0;
}
