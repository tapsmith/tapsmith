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
  /** Which kind of target resolved, in order: 'chat' for a group, 'solo' otherwise. */
  order: [] as string[],
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
      hoisted.order.push(config.devices ? 'chat' : 'solo');
      if (hoisted.failing.has(config.platform ?? 'default')) throw new Error('No online Android device found.');
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
    hoisted.order.length = 0;
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
    // Refused before anything was resolved: no target pinned, none auto-picked.
    expect(hoisted.resolved).toEqual([]);
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

  // A refused call must leave nothing behind: the pin used to land on the
  // first project owning the file before the project check refused the call.
  describe('a call refused for its project pins nothing', () => {
    const shared = `export default {
      testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["a.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`;

    it('when the file runs under two projects and none is named', async () => {
      writeProject(shared);
      const d = dispatcher();
      // validateProjectChoice refuses it by name ("needs a `project`").
      expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'SIM-1')).toBeNull();
      expect(hoisted.resolved).toEqual([]);
    });

    it('when the named project does not exist', async () => {
      writeProject(shared);
      const d = dispatcher();
      expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'SIM-1', 'iso')).toBeNull();
      expect(hoisted.resolved).toEqual([]);
    });
  });

  it('never pins a group member\'s name as a serial when re-resolving a target that found no device', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [{ name: "chat", use: { devices: [{ name: "alice" }, { name: "bob" }] } }],
    }\n`);
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'alice', 'chat');
    expect(hoisted.resolved.map((r) => r.device)).not.toContain('alice');
  });

  it('keeps a concurrent call\'s pending pin when an earlier call finishes', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    const internals = d as unknown as {
      _pendingPin: unknown
      _resolvePlatformTargets(config: unknown): Promise<void>
    };
    const mine = { device: 'emulator-5560', files: [], project: undefined };
    const resolve = internals._resolvePlatformTargets.bind(d);
    // Another call replaces the pending pin while the first is resolving.
    internals._resolvePlatformTargets = async (config) => {
      internals._pendingPin = mine;
      await resolve(config);
    };
    await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560');
    expect(internals._pendingPin).toBe(mine);
  });

  it('still pins after the test list has been read', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    await d.ensureInitialized();
    expect(hoisted.resolved).toEqual([]);
    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560')).toBeNull();
    expect(hoisted.resolved).toEqual([{ platform: 'android', device: 'emulator-5560' }]);
  });

  it('refuses, and drops the pin, when the named device cannot be set up', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    const error = await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5556x');
    expect(error).toMatch(/Could not set up emulator-5556x/);
    expect(error).toContain('No online Android device found');
    // The embedded reason ends in a period of its own.
    expect(error).not.toContain('..');
    // A later run without `device` is free to find one.
    hoisted.failing.clear();
    const internals = d as unknown as { _resolvePlatformTargets(config: unknown): Promise<void>; _config: unknown };
    await internals._resolvePlatformTargets(internals._config);
    expect(hoisted.resolved.at(-1)).toEqual({ platform: 'android', device: undefined });
  });

  it('never pins the primary onto a device the config pins to another member', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [{ name: "chat", use: { devices: [{ name: "alice" }, { name: "bob", device: "emulator-5558" }] } }],
    }\n`);
    const d = dispatcher();
    await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5558');
    expect(hoisted.resolved.map((r) => r.device)).not.toContain('emulator-5558');
  });

  // Refusing (or ignoring) a first call must not resolve targets: the auto-pick
  // spent the session's one chance to choose, so following the refusal's own
  // advice was refused next.
  it('resolves nothing for a refused first call, so the corrected retry still pins', async () => {
    writeProject(`export default {
      testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["a.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`);
    const d = dispatcher();
    const file = path.join(root, 'a.test.ts');
    // Each refused (by validateProjectChoice) or ignored without resolving anything.
    expect(await d.deviceChoiceError([file], 'SIM-1')).toBeNull();
    expect(await d.deviceChoiceError([file], 'SIM-1', 'iso')).toBeNull();
    expect(await d.deviceChoiceError([path.join(root, 'nope.test.ts')], 'SIM-1')).toBeNull();
    expect(hoisted.resolved).toEqual([]);
    expect(await d.deviceChoiceError([file], 'SIM-1', 'ios')).toBeNull();
    expect(hoisted.resolved).toContainEqual({ platform: 'ios', device: 'SIM-1' });
  });

  it('tries a failing device once per call', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5556x');
    expect(hoisted.resolved.filter((r) => r.device === 'emulator-5556x')).toHaveLength(1);
  });

  it('keeps a confirmed device when the target has to be resolved again', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    await d.ensureDevicesReady();
    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5556')).toBeNull();
    const internals = d as unknown as { _resolvePlatformTargets(config: unknown): Promise<void>; _config: unknown };
    await internals._resolvePlatformTargets(internals._config);
    expect(hoisted.resolved.at(-1)).toEqual({ platform: 'android', device: 'emulator-5556' });
  });

  // Every target resolves on the first device need. An unpinned one used to
  // resolve first and could take the very device another target was pinned
  // to; resolving the pinned one first lets the other share its daemon.
  it('resolves a pinned target before the unpinned ones', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [
        { name: "solo", testMatch: ["a.test.ts"] },
        { name: "chat", testMatch: ["b.test.ts"], use: { devices: [{ name: "alice" }, { name: "bob" }] } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    const d = dispatcher();
    expect(await d.deviceChoiceError([path.join(root, 'b.test.ts')], 'emulator-5560', 'chat')).toBeNull();
    expect(hoisted.resolved).toEqual([
      { platform: 'android', device: 'emulator-5560' },
      { platform: 'android', device: undefined },
    ]);
  });

  // Resolving devices takes seconds on a first run; a second run arriving in
  // that window used to pass the "already running" guard too.
  it('refuses a second run while the first is still resolving devices', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    await d.ensureInitialized();
    const internals = d as unknown as { _resolvePlatformTargets(config: unknown): Promise<void>; _runFileInChild: unknown };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const resolve = internals._resolvePlatformTargets.bind(d);
    internals._resolvePlatformTargets = async (config) => { await gate; await resolve(config); };
    internals._runFileInChild = async () => ({ results: [], suite: { name: 'a', tests: [], suites: [], durationMs: 0 } });
    const first = d.runFiles([path.join(root, 'a.test.ts')]);
    await new Promise((r) => setImmediate(r));
    expect(d.isRunning()).toBe(true);
    release();
    await first;
  });

  // The CLI keeps a root `device` on the projects of its own platform; the
  // headless session resolves projects itself and must do the same.
  it('does not pin the other platform\'s target to a root device', async () => {
    writeProject(`export default {
      device: "emulator-5554", testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["b.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    const d = dispatcher();
    await d.ensureDevicesReady();
    expect(hoisted.resolved).toContainEqual({ platform: 'android', device: 'emulator-5554' });
    expect(hoisted.resolved).toContainEqual({ platform: 'ios', device: undefined });
  });

  // Group names are unique per group, not per session; the files already say
  // which group they run on, so a name is resolved within that one.
  it('resolves a member name within the files\' own group', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [
        { name: "chatA", testMatch: ["a.test.ts"], use: { devices: [{ name: "alice" }, { name: "bob" }] } },
        { name: "chatB", testMatch: ["b.test.ts"], use: { devices: [{ name: "alice" }, { name: "bob" }], package: "com.y" } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    const d = dispatcher();
    await d.ensureDevicesReady();
    // Each group on devices of its own, as the pool would resolve them.
    const internals = d as unknown as { _targets: Map<string, { address: string; deviceSerial: string; members?: unknown[] }> };
    const keys = [...internals._targets.keys()];
    internals._targets.set(keys[0], { address: 'a', deviceSerial: 'emulator-5554', members: [{ name: 'bob', address: 'b', deviceSerial: 'emulator-5556' }] });
    internals._targets.set(keys[1], { address: 'c', deviceSerial: 'emulator-5558', members: [{ name: 'bob', address: 'd', deviceSerial: 'emulator-5560' }] });
    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'alice')).toBeNull();
  });

  // Two projects on one target: the file maps to one target key, but the call
  // is still refused for its project, and it must not resolve anything first.
  it('resolves nothing for a file under two projects of one target when no project is named', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [{ name: "smoke", testMatch: ["a.test.ts"] }, { name: "full", testMatch: ["a.test.ts"] }],
    }\n`);
    const d = dispatcher();
    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560')).toBeNull();
    expect(hoisted.resolved).toEqual([]);
  });

  // A config pin wins over `device` — also while its target has no device yet;
  // returning early there let the run go to the config's device silently.
  it('refuses a device other than the config\'s pin while that target has no device', async () => {
    writeProject('export default { platform: "android", device: "emulator-5554", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    const error = await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5556');
    expect(error).toContain('The config pins emulator-5554');
    expect(error).not.toContain('..');
  });

  it('treats the project a config without projects gets as unknown, resolving nothing', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    expect(await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560', 'default')).toBeNull();
    expect(hoisted.resolved).toEqual([]);
  });

  // Only runs used to retry a failed target, so after a device tool found no
  // device, booting one did not help any later device tool.
  it('retries a failed target for a device tool, not for every caller', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    await d.ensureDevicesReady();
    expect(hoisted.resolved).toHaveLength(1);
    await d.ensureDevicesReady({ retryFailedTargets: true });
    expect(hoisted.resolved).toHaveLength(2);
    expect(d.getSessionInfo().deviceTargets).toEqual([{ platform: 'android', device: 'emulator-5556' }]);
  });

  // The retry is for a session with no device at all: re-resolving a missing
  // platform on every tap of a working one churned a daemon per call.
  it('does not retry a failed target while another one serves, nor twice in quick succession', async () => {
    writeProject(`export default {
      testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["b.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    hoisted.failing.add('ios');
    const d = dispatcher();
    await d.ensureDevicesReady();
    const before = hoisted.resolved.length;
    await d.ensureDevicesReady({ retryFailedTargets: true });
    expect(hoisted.resolved.length).toBe(before);
  });

  it('retries at most once in quick succession when nothing serves', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    await d.ensureDevicesReady({ retryFailedTargets: true });
    await d.ensureDevicesReady({ retryFailedTargets: true });
    expect(hoisted.resolved).toHaveLength(2);
  });

  // A run in flight retries its own target; resolving it here too started a
  // second daemon for one target.
  it('does not re-resolve a failed target while a run is in flight', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    (d as unknown as { _isRunning: boolean })._isRunning = true;
    const before = hoisted.resolved.length;
    await d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5560');
    expect(hoisted.resolved.length).toBe(before);
  });

  // A group member's pin counts as a pin for the ordering: the unpinned solo
  // target used to resolve first and could take the member's device.
  it('resolves a target with a member pin before the unpinned ones', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [
        { name: "solo", testMatch: ["a.test.ts"] },
        { name: "chat", testMatch: ["b.test.ts"], use: { devices: [{ name: "alice" }, { name: "bob", device: "emulator-5558" }] } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    const d = dispatcher();
    await d.ensureDevicesReady();
    // The chat target (the only one with a pin) went first; solo followed.
    expect(hoisted.resolved.map((r) => r.device)).toEqual([undefined, undefined]);
    expect(hoisted.order[0]).toBe('chat');
  });

  it('does not answer a member of the unresolved group with a config-pin refusal', async () => {
    writeProject(`export default {
      platform: "android", package: "com.x", testMatch: ["**/*.test.ts"],
      projects: [{ name: "chat", use: { devices: [{ name: "alice", device: "emulator-5554" }, { name: "bob", device: "emulator-5556" }] } }],
    }\n`);
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    const file = path.join(root, 'a.test.ts');
    for (const device of ['alice', 'bob', 'emulator-5556']) {
      expect(await d.deviceChoiceError([file], device)).toBeNull();
    }
    expect(await d.deviceChoiceError([file], 'emulator-5560')).toContain('The config pins emulator-5554');
  });

  it('shares one retry between a device tool and a run_tests device', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    const before = hoisted.resolved.length;
    await Promise.all([
      d.ensureDevicesReady({ retryFailedTargets: true }),
      d.deviceChoiceError([path.join(root, 'a.test.ts')], 'emulator-5556'),
    ]);
    expect(hoisted.resolved.length).toBe(before + 1);
  });

  it('lets a run wait for a retry already in flight instead of resolving the target again', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    const internals = d as unknown as { _retryPromise: Promise<void> | null; _ensureTargetForProject(p?: string): Promise<unknown> };
    let release!: () => void;
    internals._retryPromise = new Promise<void>((r) => { release = r; });
    const before = hoisted.resolved.length;
    const target = internals._ensureTargetForProject();
    await new Promise((r) => setImmediate(r));
    expect(hoisted.resolved.length).toBe(before);
    release();
    internals._retryPromise = null;
    await target;
  });

  // A tool naming the failed platform's project retries just that target;
  // taps on the working platform still never do.
  it('retries the failed target a device tool names, while another target serves', async () => {
    writeProject(`export default {
      testMatch: ["**/*.test.ts"],
      projects: [
        { name: "android", testMatch: ["a.test.ts"], use: { platform: "android", package: "com.x" } },
        { name: "ios", testMatch: ["b.test.ts"], use: { platform: "ios", package: "com.x" } },
      ],
    }\n`, ['a.test.ts', 'b.test.ts']);
    hoisted.failing.add('ios');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    const before = hoisted.resolved.length;
    await d.ensureDevicesReady({ retryFailedTargets: true, project: 'android' });
    expect(hoisted.resolved.length).toBe(before);
    await d.ensureDevicesReady({ retryFailedTargets: true, project: 'ios' });
    expect(hoisted.resolved.length).toBe(before + 1);
    expect(hoisted.resolved.at(-1)).toEqual({ platform: 'ios', device: undefined });
  });

  it('lets only one of two concurrent run_tests retry a failed target', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    hoisted.failing.add('android');
    const d = dispatcher();
    await d.ensureDevicesReady();
    hoisted.failing.clear();
    const internals = d as unknown as { _retryPromise: Promise<void> | null };
    let release!: () => void;
    internals._retryPromise = new Promise<void>((r) => { release = r; }).then(() => { internals._retryPromise = null; });
    const before = hoisted.resolved.length;
    const file = path.join(root, 'a.test.ts');
    const both = Promise.all([d.deviceChoiceError([file], 'emulator-5556'), d.deviceChoiceError([file], 'emulator-5556')]);
    await new Promise((r) => setImmediate(r));
    release();
    await both;
    expect(hoisted.resolved.length).toBe(before + 1);
  });

  it('leaves files that match nothing to the run, which reports them', async () => {
    writeProject('export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n');
    const d = dispatcher();
    expect(await d.deviceChoiceError([path.join(root, 'missing.test.ts')], 'emulator-5560')).toBeNull();
  });
});

// The pool's first-time discovery starts its own daemon. It used to point it
// at the "best" device and start an agent there before any target existed —
// another session's device in the report, and after a mere list_devices.
// In a headless session its targets choose (prepareTarget sets the device
// and starts the agent), so discovery chooses nothing.
describe('discovery daemon device selection', () => {
  it('selects nothing in a headless session', async () => {
    const { discoverySelectsDevice } = await import('../mcp/connection.js');
    expect(discoverySelectsDevice({ uiMode: false })).toBe(false);
  });

  it('still selects one for a UI session\'s endpoint', async () => {
    const { discoverySelectsDevice } = await import('../mcp/connection.js');
    expect(discoverySelectsDevice({ uiMode: true })).toBe(true);
  });
});
