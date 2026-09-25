import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Telemetry, TELEMETRY_DOCS_URL } from '../telemetry.js';
import { runTelemetryCommand } from '../telemetry-cli.js';
import { defineConfig, type TapsmithConfig } from '../config.js';

let tempDir: string;
let stateFile: string;

function harness(opts: { env?: NodeJS.ProcessEnv; config?: TapsmithConfig | Error; realLoader?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const telemetry = new Telemetry({
    stateFile,
    endpoint: 'https://collector.test/v1/events',
    env: opts.env ?? {},
    fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    sdkVersion: '9.9.9',
    writeNotice: () => undefined,
  });
  const run = (argv: string[]) => runTelemetryCommand(argv, {
    telemetry,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    loadConfig: opts.realLoader ? undefined : async () => {
      if (opts.config instanceof Error) throw opts.config;
      return opts.config ?? defineConfig();
    },
  });
  return { run, out, err, telemetry, text: () => out.join(''), errText: () => err.join('') };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-telemetry-cli-'));
  stateFile = path.join(tempDir, 'telemetry.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tapsmith telemetry status', () => {
  it('is the default subcommand and reports enabled with the opt-out routes', async () => {
    const h = harness();
    expect(await h.run([])).toBe(0);
    expect(h.text()).toContain('Telemetry is enabled.');
    expect(h.text()).toContain('tapsmith telemetry disable');
    expect(h.text()).toContain('TAPSMITH_TELEMETRY=0');
    expect(h.text()).toContain('telemetry: false');
    expect(h.text()).toContain(TELEMETRY_DOCS_URL);
    // Status never creates the state file.
    expect(h.text()).toContain('(none yet');
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(h.errText()).toBe('');
  });

  it('names the env var when that decided it', async () => {
    const h = harness({ env: { TAPSMITH_TELEMETRY: '0' } });
    expect(await h.run(['status'])).toBe(0);
    expect(h.text()).toMatch(/Telemetry is disabled \(TAPSMITH_TELEMETRY or DO_NOT_TRACK is set/);
  });

  it('names the config file when that decided it', async () => {
    const h = harness({ config: defineConfig({ telemetry: false }) });
    expect(await h.run(['status'])).toBe(0);
    expect(h.text()).toMatch(/Telemetry is disabled \(telemetry: false in /);
  });

  it('names the machine switch and how to undo it', async () => {
    const h = harness();
    await h.run(['disable']);
    h.out.length = 0;
    expect(await h.run(['status'])).toBe(0);
    expect(h.text()).toMatch(/Telemetry is disabled \(machine-wide, via `tapsmith telemetry disable`/);
    expect(h.text()).toContain('Re-enable: tapsmith telemetry enable');
  });

  it('still answers when the config cannot be loaded, and says so', async () => {
    const h = harness({ config: new Error('bad config') });
    expect(await h.run(['status'])).toBe(0);
    expect(h.text()).toContain('Telemetry is enabled.');
    expect(h.text()).toContain('config could not be loaded (bad config)');
  });

  it('mentions the dry run when TAPSMITH_TELEMETRY_DEBUG is set', async () => {
    const h = harness({ env: { TAPSMITH_TELEMETRY_DEBUG: '1' } });
    expect(await h.run(['status'])).toBe(0);
    expect(h.text()).toContain('dry-run mode');
  });

  it('flags a present-but-unreadable config instead of silently reporting enabled (PILOT-330 review)', async () => {
    // A tapsmith.config in the cwd that cannot be imported makes loadConfig
    // reject (PILOT-262); status must say the config was not consulted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-cli-cwd-'));
    fs.writeFileSync(path.join(dir, 'tapsmith.config.mjs'), 'throw new Error("boom")\n');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const h = harness({ realLoader: true });
      expect(await h.run(['status'])).toBe(0);
      expect(h.text()).toContain('config could not be loaded');
      expect(h.text()).toContain('boom');
      h.out.length = 0;
      expect(await h.run(['status', '--json'])).toBe(0);
      expect(JSON.parse(h.text())).toMatchObject({ configConsulted: false });
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json emits the status object for scripting', async () => {
    const h = harness({ env: { DO_NOT_TRACK: '1' } });
    expect(await h.run(['status', '--json'])).toBe(0);
    const parsed = JSON.parse(h.text());
    expect(parsed).toMatchObject({
      enabled: false,
      reason: 'env',
      debug: false,
      stateFile,
      endpoint: 'https://collector.test/v1/events',
      docs: TELEMETRY_DOCS_URL,
    });
    expect(parsed).toHaveProperty('configPath');
  });
});

describe('tapsmith telemetry enable / disable', () => {
  it('disable writes the machine switch and says how to undo it', async () => {
    const h = harness();
    expect(await h.run(['disable'])).toBe(0);
    expect(h.text()).toMatch(/^Telemetry disabled for this machine \(.*telemetry\.json\)\. Re-enable with `tapsmith telemetry enable`\.\n$/);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).enabled).toBe(false);
    expect(h.telemetry.isEnabled({})).toBe(false);
  });

  it('enable flips it back', async () => {
    const h = harness();
    await h.run(['disable']);
    h.out.length = 0;
    expect(await h.run(['enable'])).toBe(0);
    expect(h.text()).toMatch(/^Telemetry enabled for this machine/);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).enabled).toBe(true);
    expect(h.telemetry.isEnabled({})).toBe(true);
  });

  it('enable warns when the env var still keeps it off', async () => {
    const h = harness({ env: { TAPSMITH_TELEMETRY: '0' } });
    expect(await h.run(['enable'])).toBe(0);
    expect(h.text()).toContain('Still off here: TAPSMITH_TELEMETRY or DO_NOT_TRACK is set');
  });

  it('enable warns when the project config still keeps it off (PILOT-330 review)', async () => {
    // Regression: `enable` used to compute status with no config, so this
    // caveat was dead code and the command reported enabled:true.
    const h = harness({ config: defineConfig({ telemetry: false }) });
    expect(await h.run(['enable'])).toBe(0);
    expect(h.text()).toContain('Still off here: the project config sets telemetry: false');
  });

  it('--json works on enable/disable too, with the same shape as status', async () => {
    const h = harness();
    expect(await h.run(['disable', '--json'])).toBe(0);
    const parsed = JSON.parse(h.text());
    expect(parsed).toMatchObject({ enabled: false, reason: 'machine' });
    // Same keys as `status --json` (PILOT-330 review).
    expect(parsed).toHaveProperty('configPath');
    expect(parsed).toHaveProperty('configConsulted', true);
  });

  it('enable --json reflects a config opt-out instead of claiming enabled (PILOT-330 review)', async () => {
    const h = harness({ config: defineConfig({ telemetry: false }) });
    expect(await h.run(['enable', '--json'])).toBe(0);
    expect(JSON.parse(h.text())).toMatchObject({ enabled: false, reason: 'config' });
  });

  it('fails clearly when the state file cannot be written', async () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.writeFileSync(tempDir, 'a file where the directory should be');
    const h = harness();
    expect(await h.run(['disable'])).toBe(1);
    expect(h.errText()).toContain('Could not write');
    expect(h.errText()).toContain('TAPSMITH_TELEMETRY=0');
  });
});

describe('argument handling', () => {
  it('rejects unknown arguments with usage and exit 1', async () => {
    const h = harness();
    expect(await h.run(['nuke'])).toBe(1);
    expect(h.errText()).toContain('Unknown argument: nuke');
    expect(h.errText()).toContain('Usage: tapsmith telemetry');
    expect(h.text()).toBe('');
  });

  it('rejects two subcommands', async () => {
    const h = harness();
    expect(await h.run(['enable', 'disable'])).toBe(1);
    expect(h.errText()).toContain('Unexpected argument: disable');
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('prints usage on --help', async () => {
    const h = harness();
    expect(await h.run(['--help'])).toBe(0);
    expect(h.text()).toContain('Usage: tapsmith telemetry [status|enable|disable]');
  });

  it('accepts -c / --config for status', async () => {
    const seen: Array<string | undefined> = [];
    const h = harness();
    const run = (argv: string[]) => runTelemetryCommand(argv, {
      telemetry: h.telemetry,
      stdout: () => undefined,
      stderr: () => undefined,
      loadConfig: async (file) => { seen.push(file); return defineConfig(); },
    });
    expect(await run(['status', '-c', 'x.mjs'])).toBe(0);
    expect(await run(['--config=y.mjs'])).toBe(0);
    expect(await run(['-c'])).toBe(1);
    expect(seen).toEqual(['x.mjs', 'y.mjs']);
  });
});
