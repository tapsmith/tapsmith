import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real probe (`probeCertTrust`) caches its verdict per device. Drive it
// through a mocked `execFile` so the replacement's re-probe is shown to reach
// the device rather than the cached first verdict.
const launches: string[][] = [];
const launchOutcomes: Array<{ stdout?: string, error?: string }> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = vi.fn();
  Object.assign(execFile, {
    [promisify.custom]: async (_cmd: string, args: string[]) => {
      launches.push(args);
      const outcome = launchOutcomes.shift() ?? { error: 'unexpected launch' };
      if (outcome.error) throw Object.assign(new Error(outcome.error), { stdout: '', stderr: outcome.error });
      return { stdout: outcome.stdout ?? '', stderr: '' };
    },
  });
  return { ...actual, execFile };
});

const { checkRunnerTrust, clearTrustProbeCache, probeCertTrust } = await import('../ios-trust-probe.js');

describe('checkRunnerTrust with the caching probe', () => {
  const UDID = '00008140-00000000000000AA';
  let dir: string;
  let xctestrun: string;

  beforeEach(() => {
    launches.length = 0;
    launchOutcomes.length = 0;
    clearTrustProbeCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-cache-'));
    fs.mkdirSync(path.join(dir, 'Debug-iphoneos', 'TapsmithAgentUITests-Runner.app'), { recursive: true });
    xctestrun = path.join(dir, 'TapsmithAgentUITests_iphoneos27.2-arm64.xctestrun');
    fs.writeFileSync(xctestrun, '');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('launches the freshly installed runner instead of answering the re-probe from the cache', async () => {
    launchOutcomes.push(
      { error: 'Unable to launch dev.tapsmith.agent.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.' },
      { stdout: 'Launched application with dev.tapsmith.agent.xctrunner bundle identifier.' },
    );
    const check = await checkRunnerTrust(UDID, async () => xctestrun, {
      probe: probeCertTrust,
      async uninstallRunner() {},
      async installApp() {},
      profileExpiry: () => undefined,
    });
    expect(check).toEqual({ outcome: 'ok', state: 'trusted', replaced: true });
    expect(launches).toHaveLength(2);
    expect(launches.every((args) => args.includes('launch') && args.includes(UDID))).toBe(true);
  });
});
