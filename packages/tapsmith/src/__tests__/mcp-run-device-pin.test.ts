import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TapsmithConfig } from '../config.js';

// PILOT-342: headless MCP `run_tests` accepted `device` and never applied it.
// The run went to whatever device the session auto-picked at startup — in the
// report, another live session's emulator — and the result said nothing.
// `device` must now either pin the run's target or refuse the call.

const hoisted = vi.hoisted(() => ({
  /** The config every `ensurePlatformTarget` call was handed. */
  resolved: [] as Array<{ platform?: string; device?: string }>,
  /** What an unpinned resolve picks — the device another session owns, in the report. */
  autoPick: 'emulator-5556',
  /** Platforms whose resolve fails (no device available). */
  failing: new Set<string>(),
}));

vi.mock('../mcp/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/connection.js')>();
  const { primaryDevicePin } = await import('../config.js');
  return {
    ...actual,
    ensurePlatformTarget: async (config: TapsmithConfig) => {
      hoisted.resolved.push({ platform: config.platform, device: config.device });
      if (hoisted.failing.has(config.platform ?? 'default')) throw new Error('No online Android device found');
      return {
        address: '127.0.0.1:50100',
        deviceSerial: primaryDevicePin(config) ?? (config.platform === 'ios' ? 'SIM-AUTO' : hoisted.autoPick),
        platform: config.platform,
      };
    },
    platformTargetIsLive: async () => true,
  };
});

const { HeadlessTestDispatcher } = await import('../mcp/headless-dispatcher.js');

describe('run_tests `device` in a headless MCP session', () => {
  let root: string;
  let originalCwd: string;

  function writeProject(config: string, files: string[] = ['a.test.ts']): void {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'), config);
    for (const f of files) fs.writeFileSync(path.join(root, f), '');
  }

  function dispatcher(): InstanceType<typeof HeadlessTestDispatcher> {
    return new HeadlessTestDispatcher({ configFile: path.join(root, 'tapsmith.config.mjs') });
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-pin-')));
    process.chdir(root);
    hoisted.resolved.length = 0;
    hoisted.failing.clear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pins the target to the requested device when it is the session\'s first choice of device', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();

    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560')).toBeNull();
    // The target was resolved on the requested device — never auto-picked first.
    expect(hoisted.resolved).toEqual([{ platform: 'android', device: 'emulator-5560' }]);
    expect(d.getSessionInfo().device).toBe('emulator-5560');
  });

  it('refuses a device other than the one the session already runs on, naming both', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    await d.ensureDevicesReady();

    const error = await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560');
    expect(error).toContain('emulator-5556');
    expect(error).toContain('emulator-5560');
    expect(error).toMatch(/restart the MCP server/);
    // Nothing moved: no second resolve on the requested device.
    expect(hoisted.resolved).toEqual([{ platform: 'android', device: undefined }]);
  });

  it('accepts the device the session already runs on', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    await d.ensureDevicesReady();
    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5556')).toBeNull();
  });

  it('keeps the pin when the target has to be resolved again', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560');
    const internals = d as unknown as { _resolvePlatformTargets(config: unknown): Promise<void>; _config: unknown };
    await internals._resolvePlatformTargets(internals._config);
    expect(hoisted.resolved.at(-1)).toEqual({ platform: 'android', device: 'emulator-5560' });
  });

  it('says the config pins another device instead of overriding it', async () => {
    writeProject('export default { platform: "android", device: "emulator-5554", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    const error = await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560');
    expect(error).toContain('The config pins emulator-5554');
    expect(hoisted.resolved).toEqual([{ platform: 'android', device: 'emulator-5554' }]);
  });

  it('re-resolves a target that found no device, on the requested one', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();

    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560')).toBeNull();
    expect(hoisted.resolved.at(-1)).toEqual({ platform: 'android', device: 'emulator-5560' });
  });

  it('refuses a device for files that run on more than one target', async () => {
    writeProject(`export default {
      testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["b.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    const d = dispatcher();

    const error = await d.deviceChoiceError([path.join(root, 'a.test.ts'), path.join(root, 'b.test.ts')], 'emulator-5560');
    expect(error).toMatch(/run on 2 device targets/);
    expect(error).toContain('project');
    // Neither target was pinned to a serial that can serve only one of them.
    expect(hoisted.resolved.map((r) => r.device)).toEqual([undefined, undefined]);
  });

  it('pins only the target of the project the files run under', async () => {
    writeProject(`export default {
      testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["b.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    const d = dispatcher();

    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560', 'android')).toBeNull();
    expect(hoisted.resolved).toEqual([
      { platform: 'android', device: 'emulator-5560' },
      { platform: 'ios', device: undefined },
    ]);
  });

  it('accepts a group member by name or serial, and refuses one outside the group', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [{ name: "chat", use: { devices: [{ name: "alice" }, { name: "bob" }] } }],
    }\n`);
    const d = dispatcher();
    await d.ensureDevicesReady();
    // The mock resolves no members; give the group target one, as the pool would.
    const internals = d as unknown as { _targets: Map<string, { address: string; deviceSerial: string; members?: Array<{ name: string; address: string; deviceSerial: string }> }> };
    const [key, target] = [...internals._targets][0];
    internals._targets.set(key, { ...target, members: [{ name: 'bob', address: '127.0.0.1:50101', deviceSerial: 'emulator-5558' }] });

    const file = path.join(root, 'a.test.ts');
    expect(await d.deviceChoiceError([file], 'alice')).toBeNull();
    expect(await d.deviceChoiceError([file], 'bob')).toBeNull();
    expect(await d.deviceChoiceError([file], 'emulator-5558')).toBeNull();
    expect(await d.deviceChoiceError([file], 'emulator-5560')).toContain('emulator-5556');
  });

  it('leaves files that match nothing to the run, which reports them', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    expect(await d.deviceChoiceError([path.join(root, 'missing.test.ts')], 'emulator-5560')).toBeNull();
  });
});
