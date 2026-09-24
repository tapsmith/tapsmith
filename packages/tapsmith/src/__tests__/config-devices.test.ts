import { describe, it, expect } from 'vitest';
import {
  assignGroupMemberDevices,
  defineConfig,
  deviceGroupSize,
  effectiveConfigForProject,
  MAX_DEVICE_GROUP_SIZE,
  primaryDevicePin,
  pinnedDeviceSerials,
  resolveDeviceGroup,
  validateDevicesOption,
  type TapsmithConfig,
} from '../config.js';
import { deviceGroupSignature, deviceSignature, resolveProjects, sharedDeviceGroup } from '../project.js';

// `use.devices` (PILOT-310): a project whose tests drive several devices at
// once. The declaration is validated at load time and normalised into named
// members everywhere else, so a typo cannot provision a wrong-sized group and
// no embedder has to know both spellings.

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return defineConfig({ platform: 'android', avd: 'Pixel_6', package: 'com.x', ...overrides });
}

describe('validateDevicesOption', () => {
  it('accepts a positive count or a named list', () => {
    expect(() => validateDevicesOption({ devices: 2 })).not.toThrow();
    expect(() => validateDevicesOption({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] })).not.toThrow();
    expect(() => validateDevicesOption({})).not.toThrow();
  });

  it('rejects counts that cannot be a group', () => {
    expect(() => validateDevicesOption({ devices: 0 })).toThrow(/positive integer/);
    expect(() => validateDevicesOption({ devices: 1.5 })).toThrow(/positive integer/);
    expect(() => validateDevicesOption({ devices: [] })).toThrow(/non-empty array/);
  });

  it('caps the group at the member-port band the UI and watch allocators reserve per worker', () => {
    expect(MAX_DEVICE_GROUP_SIZE).toBe(10);
    expect(() => validateDevicesOption({ devices: 10 })).not.toThrow();
    expect(() => validateDevicesOption({ devices: 11 })).toThrow(/at most 10/);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `user-${i}` }));
    expect(() => validateDevicesOption({ devices: eleven })).toThrow(/at most 10 members/);
    expect(() => validateDevicesOption({ devices: eleven.slice(0, 10) })).not.toThrow();
  });


  it('rejects malformed, duplicate or unsafe member names', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed input on purpose
    expect(() => validateDevicesOption({ devices: [{ name: '' }] as any })).toThrow(/devices\[0\] must be an object with a non-empty string `name`/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed input on purpose
    expect(() => validateDevicesOption({ devices: ['alice'] as any })).toThrow(/devices\[0\]/);
    expect(() => validateDevicesOption({ devices: [{ name: 'alice' }, { name: 'alice' }] })).toThrow(/names must be unique/);
    // Names become file-name suffixes and trace ids.
    expect(() => validateDevicesOption({ devices: [{ name: 'a/b' }] })).toThrow(/may only contain/);
  });

  it('rejects two members pinned to one device', () => {
    expect(() => validateDevicesOption({
      devices: [{ name: 'alice', device: 'emulator-5554' }, { name: 'bob', device: 'emulator-5554' }],
    })).toThrow(/pinned by another entry/);
    expect(() => validateDevicesOption({ devices: [{ name: 'alice', device: '' }] })).toThrow(/non-empty serial/);
  });

  it('names the source of the failure', () => {
    expect(() => validateDevicesOption({ devices: 0 }, 'test.use()')).toThrow(/^test\.use\(\):/);
    expect(() => defineConfig({ devices: 0 })).toThrow(/^config: devices/);
  });

  it('is applied to a project `use` block too', () => {
    const root = makeConfig();
    expect(() => effectiveConfigForProject(root, { use: { devices: 0 } })).toThrow(/devices must be a positive integer/);
    expect(() => resolveProjects(makeConfig({
      projects: [{ name: 'chat', use: { devices: [{ name: 'a' }, { name: 'a' }] } }],
    }))).toThrow(/names must be unique/);
  });
});

describe('resolveDeviceGroup / deviceGroupSize', () => {
  it('treats a config without `devices` as a group of one', () => {
    const config = makeConfig();
    expect(deviceGroupSize(config)).toBe(1);
    expect(resolveDeviceGroup(config)).toEqual([{ name: 'device-1' }]);
  });

  it('names a counted group device-1 … device-N', () => {
    const config = makeConfig({ devices: 3 });
    expect(deviceGroupSize(config)).toBe(3);
    expect(resolveDeviceGroup(config).map((e) => e.name)).toEqual(['device-1', 'device-2', 'device-3']);
  });

  it('keeps named members and their pins in declaration order', () => {
    const config = makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] });
    expect(deviceGroupSize(config)).toBe(2);
    expect(resolveDeviceGroup(config)).toEqual([{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }]);
  });

  it('lets `config.device` pin the primary when the first member leaves it open', () => {
    // `--device <serial>` keeps meaning "run the primary on this device".
    expect(resolveDeviceGroup(makeConfig({ device: 'emulator-5554', devices: 2 }))[0])
      .toEqual({ name: 'device-1', device: 'emulator-5554' });
    expect(resolveDeviceGroup(makeConfig({ device: 'emulator-5554' }))[0])
      .toEqual({ name: 'device-1', device: 'emulator-5554' });
    // An explicit pin on the first member wins over `config.device`.
    expect(resolveDeviceGroup(makeConfig({ device: 'emulator-5554', devices: [{ name: 'alice', device: 'X' }] }))[0])
      .toEqual({ name: 'alice', device: 'X' });
  });
});

// The primary is the group's first member. Two embedders (the sequential CLI
// and the headless MCP server) read its pin from `config.device` and so
// honoured `bob`'s pin while auto-picking `alice`'s — the exact shape
// docs/multi-device.md documents. Every embedder reads the pin from here now.
describe('primaryDevicePin', () => {
  it('is the first member\'s own pin when the root leaves `device` unset', () => {
    const config = makeConfig({ devices: [{ name: 'alice', device: 'emulator-5558' }, { name: 'bob', device: 'emulator-5560' }] });
    expect(primaryDevicePin(config)).toBe('emulator-5558');
  });

  it('falls back to root `device` for an unpinned first member, and to nothing at all', () => {
    expect(primaryDevicePin(makeConfig({ device: 'emulator-5554', devices: [{ name: 'alice' }, { name: 'bob', device: 'X' }] })))
      .toBe('emulator-5554');
    expect(primaryDevicePin(makeConfig({ device: 'emulator-5554' }))).toBe('emulator-5554');
    expect(primaryDevicePin(makeConfig({ devices: 2 }))).toBeUndefined();
    expect(primaryDevicePin(makeConfig())).toBeUndefined();
  });

  it('lets the first member\'s pin win over root `device`', () => {
    expect(primaryDevicePin(makeConfig({ device: 'emulator-5554', devices: [{ name: 'alice', device: 'X' }] }))).toBe('X');
  });
});

// A pinned device can host exactly one worker, so every embedder that sizes a
// worker pool asks this whether the target pins anything (PILOT-261/313).
describe('pinnedDeviceSerials', () => {
  it('lists root `device` (and so `--device`) as the primary\'s pin', () => {
    expect(pinnedDeviceSerials(makeConfig({ device: 'emulator-5554' }))).toEqual(['emulator-5554']);
  });

  it('lists every pinned member of a group, primary first', () => {
    const config = makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'X' }, { name: 'carol', device: 'Y' }] });
    expect(pinnedDeviceSerials(config)).toEqual(['X', 'Y']);
    expect(pinnedDeviceSerials({ ...config, device: 'P' })).toEqual(['P', 'X', 'Y']);
  });

  it('is empty when nothing is pinned', () => {
    expect(pinnedDeviceSerials(makeConfig())).toEqual([]);
    expect(pinnedDeviceSerials(makeConfig({ devices: 3 }))).toEqual([]);
  });
});

describe('assignGroupMemberDevices', () => {
  // Every embedder (sequential CLI, parallel dispatcher, per-bucket
  // provisioning) turns a provisioned device list into a group through this
  // one function; two of them used to drop the unpinned members of a
  // partially pinned group.
  const mixed = [{ name: 'alice' }, { name: 'bob', device: 'X' }, { name: 'carol' }];

  it('keeps pins and fills the unpinned members from the pool in declaration order', () => {
    expect(assignGroupMemberDevices(mixed, 'P', ['P', 'X', 'A', 'B'])).toEqual(['X', 'A']);
    // The pool need not contain the pinned device (a serial adb has not listed yet).
    expect(assignGroupMemberDevices(mixed, 'P', ['P', 'A'])).toEqual(['X', 'A']);
  });

  it('never hands out the primary or a pinned device as a free one', () => {
    expect(assignGroupMemberDevices(mixed, 'P', ['X', 'P', 'A'])).toEqual(['X', 'A']);
    expect(assignGroupMemberDevices([{ name: 'a' }, { name: 'b' }, { name: 'c', device: 'Z' }], 'P', ['P', 'Z', 'Q']))
      .toEqual(['Q', 'Z']);
  });

  it('is undefined when the pool cannot fill every unpinned member', () => {
    expect(assignGroupMemberDevices(mixed, 'P', ['P', 'X'])).toBeUndefined();
    expect(assignGroupMemberDevices(mixed, 'P', [])).toBeUndefined();
  });

  it('needs no pool for a fully pinned group and none for a group of one', () => {
    expect(assignGroupMemberDevices([{ name: 'a', device: 'P' }, { name: 'b', device: 'X' }], 'P', [])).toEqual(['X']);
    expect(assignGroupMemberDevices([{ name: 'a' }], 'P', [])).toEqual([]);
    expect(assignGroupMemberDevices([{ name: 'a' }, { name: 'b' }], undefined, ['Q'])).toEqual(['Q']);
  });
});

describe('deviceSignature with device groups', () => {
  it('keeps single-device signatures unchanged', () => {
    const plain = deviceSignature(makeConfig());
    expect(plain).not.toContain('devices=');
    expect(deviceSignature(makeConfig({ devices: 1 }))).toBe(plain);
  });

  it('puts a group project and a single-device project on the same device shape in one target', () => {
    // The two share devices: the target is provisioned for the group and
    // the single project runs on its primary. A separate target per group
    // used to hand both the same first emulator (two workers on one device)
    // and made a mixed config need one emulator more than it uses.
    const single = deviceSignature(makeConfig());
    const pair = deviceSignature(makeConfig({ devices: 2 }));
    const pinned = deviceSignature(makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] }));
    expect(pair).toBe(single);
    expect(pinned).toBe(single);
    expect(pair).not.toContain('devices=');
  });

  it('still separates genuinely different device shapes', () => {
    const android = deviceSignature(makeConfig({ devices: 2 }));
    expect(deviceSignature(makeConfig({ package: 'com.other', devices: 2 }))).not.toBe(android);
    expect(deviceSignature(makeConfig({ avd: 'Pixel_9', devices: 2 }))).not.toBe(android);
  });

  it('is carried onto resolved projects, which then share one target', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'solo', testMatch: ['**/solo/**'] },
        { name: 'chat', testMatch: ['**/chat/**'], use: { devices: 2 } },
      ],
    }));
    expect(projects[0].deviceSignature).toBe(projects[1].deviceSignature);
    expect(deviceGroupSize(projects[1].effectiveConfig)).toBe(2);
  });
});

describe('deviceGroupSignature', () => {
  it('is empty for a single device and names members and pins otherwise', () => {
    expect(deviceGroupSignature(makeConfig())).toBe('');
    expect(deviceGroupSignature(makeConfig({ devices: 1 }))).toBe('');
    expect(deviceGroupSignature(makeConfig({ devices: 2 }))).toBe('devices=device-1,device-2');
    expect(deviceGroupSignature(makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] })))
      .toBe('devices=alice,bob@emulator-5556');
  });

  it('tells differently pinned groups apart, which deviceSignature deliberately does not', () => {
    const a = makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] });
    const b = makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5558' }] });
    expect(deviceSignature(a)).toBe(deviceSignature(b));
    expect(deviceGroupSignature(a)).not.toBe(deviceGroupSignature(b));
  });
});

describe('sharedDeviceGroup', () => {
  const project = (name: string, use?: { devices?: TapsmithConfig['devices'] }) =>
    resolveProjects(makeConfig({ projects: [{ name, testMatch: [`**/${name}/**`], use }] }))[0];

  it('is a group of one for single-device projects', () => {
    const shared = sharedDeviceGroup([project('solo'), project('other')]);
    expect(shared.group).toEqual([{ name: 'device-1' }]);
    expect(shared.config.devices).toBeUndefined();
  });

  it('picks the largest declared group and its project as the authority', () => {
    const solo = project('solo');
    const pair = project('pair', { devices: [{ name: 'alice' }, { name: 'bob' }] });
    const shared = sharedDeviceGroup([solo, pair]);
    expect(shared.group).toEqual([{ name: 'alice' }, { name: 'bob' }]);
    expect(shared.config).toBe(pair.effectiveConfig);
    // Order does not matter, and a group of one beside it is fine.
    expect(sharedDeviceGroup([pair, solo]).group).toEqual(shared.group);
    expect(sharedDeviceGroup([project('one', { devices: 1 }), pair]).config).toBe(pair.effectiveConfig);
  });

  it('accepts a smaller group that is a prefix of the largest, pins included', () => {
    const trio = project('trio', { devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }, { name: 'carol' }] });
    const pairPinned = project('pair', { devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] });
    const pairLoose = project('loose', { devices: [{ name: 'alice' }, { name: 'bob' }] });
    expect(sharedDeviceGroup([pairLoose, trio, pairPinned]).group).toHaveLength(3);
    // A pin on the smaller group's side of an unpinned larger entry is fine too.
    const trioLoose = project('trio-loose', { devices: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] });
    expect(sharedDeviceGroup([pairPinned, trioLoose]).group).toHaveLength(3);
    // Default names line up with an explicit list using the same names.
    expect(sharedDeviceGroup([
      project('two', { devices: 2 }),
      project('three', { devices: [{ name: 'device-1' }, { name: 'device-2' }, { name: 'device-3' }] }),
    ]).group).toHaveLength(3);
  });

  it('rejects groups that disagree on names, naming both projects', () => {
    const pair = project('pair', { devices: [{ name: 'alice' }, { name: 'bob' }] });
    const other = project('other', { devices: [{ name: 'alice' }, { name: 'carol' }] });
    expect(() => sharedDeviceGroup([pair, other])).toThrow(/Projects "pair" and "other" target the same device but declare incompatible device groups \(alice, bob vs alice, carol\)/);
    // Same size, different names: neither is a prefix of the other.
    const counted = project('counted', { devices: 2 });
    expect(() => sharedDeviceGroup([pair, counted])).toThrow(/incompatible device groups/);
  });

  it('rejects groups that disagree on a pin', () => {
    const a = project('a', { devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] });
    const b = project('b', { devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5558' }, { name: 'carol' }] });
    expect(() => sharedDeviceGroup([a, b])).toThrow(/"b" and "a".*bob@emulator-5558, carol vs alice, bob@emulator-5556/);
  });

  it('rejects a smaller group that is not a prefix, even with matching names elsewhere', () => {
    const trio = project('trio', { devices: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] });
    const tail = project('tail', { devices: [{ name: 'bob' }, { name: 'carol' }] });
    expect(() => sharedDeviceGroup([trio, tail])).toThrow(/incompatible device groups/);
  });

  it('refuses an empty project list', () => {
    expect(() => sharedDeviceGroup([])).toThrow(/no projects/);
  });
});
