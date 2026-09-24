import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceInfoProto } from '../grpc-client.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';
import { deviceGroupNames } from '../config.js';

// How a `use.devices` project surfaces to an MCP consumer that has not read
// the config: the test tree and the session's project list name the group's
// members, and the device list labels each member with the name the device
// tools accept. Without these an agent sees "[project] pair" and two bare
// serials, and has no way to learn that the tests need two devices or that
// `device: "bob"` is a thing it can say.

const hoisted = vi.hoisted(() => ({
  devices: [] as DeviceInfoProto[],
}));

vi.mock('../mcp/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/connection.js')>()),
  listAllDevices: async () => hoisted.devices,
  getSessionDeviceSerials: () => null,
}));

const { createMcpServer } = await import('../mcp/index.js');

function makeDispatcher(overrides: Partial<TestDispatcher> = {}): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ timeout: 0, retries: 0, projects: [] }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: true }),
    ...overrides,
  };
}

async function callTool(name: string, dispatcher: TestDispatcher): Promise<string> {
  const server = createMcpServer({ dispatcher });
  const client = new Client({ name: 'group-discovery-probe', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const res = await client.callTool({ name, arguments: {} }) as CallToolResult;
    return res.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  } finally {
    await client.close();
    await server.close();
  }
}

const pairProject = {
  name: 'pair',
  platform: 'android',
  package: 'dev.tapsmith.testapp',
  testFiles: ['/proj/e2e/tests/multi-device/two-devices.test.ts'],
  dependencies: [],
  devices: ['alice', 'bob'],
};
const soloProject = { name: 'android', platform: 'android', testFiles: ['/proj/e2e/tests/home.test.ts'], dependencies: [] };

describe('deviceGroupNames', () => {
  it('names the members of a use.devices project, primary first', () => {
    expect(deviceGroupNames({ devices: [{ name: 'alice' }, { name: 'bob' }] })).toEqual(['alice', 'bob']);
    expect(deviceGroupNames({ devices: 2 })).toHaveLength(2);
  });

  it('is undefined for a single-device project', () => {
    expect(deviceGroupNames({})).toBeUndefined();
    expect(deviceGroupNames({ devices: 1 })).toBeUndefined();
  });
});

describe('tapsmith_list_tests', () => {
  it('says which projects drive a device group and names the members', async () => {
    const out = await callTool('tapsmith_list_tests', makeDispatcher({
      getProjects: () => ['pair', 'android'],
      getTestTree: () => [
        { type: 'project', name: 'pair', fullName: 'pair', filePath: '', status: 'idle', devices: ['alice', 'bob'], children: [
          { type: 'file', name: 'two-devices.test.ts', fullName: 'two-devices.test.ts', filePath: pairProject.testFiles[0]!, status: 'idle' },
        ] },
        { type: 'project', name: 'android', fullName: 'android', filePath: '', status: 'idle', children: [
          { type: 'file', name: 'home.test.ts', fullName: 'home.test.ts', filePath: soloProject.testFiles[0]!, status: 'idle' },
        ] },
      ],
    }));
    expect(out).toContain('[project] pair  (drives 2 devices: alice, bob)');
    // A single-device project reads exactly as it always has.
    expect(out).toMatch(/^\[project\] android$/m);
  });
});

describe('tapsmith_session_info', () => {
  it('lists a group project\'s members beside it, not only in the device lines', async () => {
    const out = await callTool('tapsmith_session_info', makeDispatcher({
      getSessionInfo: () => ({
        timeout: 15000,
        retries: 0,
        projects: [pairProject, soloProject],
        deviceTargets: [
          { platform: 'android', device: 'emulator-5554', name: 'alice', group: 'pair' },
          { platform: 'android', device: 'emulator-5556', name: 'bob', group: 'pair' },
        ],
      }),
    }));
    expect(out).toContain('- **pair**: android | dev.tapsmith.testapp | devices: alice, bob | 1 file(s)');
    expect(out).toContain('- **android**: android | 1 file(s)');
    expect(out).toContain('Device (android) alice [pair]: emulator-5554');
  });
});

describe('tapsmith_list_devices', () => {
  it('labels group members with the name device tools accept and their project', async () => {
    hoisted.devices = [
      { serial: 'emulator-5554', model: 'Pixel A', platform: 'android', osVersion: '16', isEmulator: true, state: 'Active' },
      { serial: 'emulator-5556', model: 'Pixel B', platform: 'android', osVersion: '16', isEmulator: true, state: 'Discovered' },
      { serial: 'HT123', model: 'Pixel 8', platform: 'android', osVersion: '15', isEmulator: false, state: 'device' },
    ];
    const out = JSON.parse(await callTool('tapsmith_list_devices', makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [pairProject],
        deviceTargets: [
          { platform: 'android', device: 'emulator-5554', name: 'alice', group: 'pair' },
          { platform: 'android', device: 'emulator-5556', name: 'bob', group: 'pair' },
        ],
      }),
    }))) as Array<Record<string, unknown>>;
    expect(out.map((d) => [d.serial, d.name, d.project])).toEqual([
      ['emulator-5554', 'alice', 'pair'],
      ['emulator-5556', 'bob', 'pair'],
      ['HT123', undefined, undefined],
    ]);
    // A device outside any group carries no name/project keys at all.
    expect(Object.keys(out[2]!)).not.toContain('name');
  });

  it('never provisions devices just to label them: a dispatcher that cannot answer yet is tolerated', async () => {
    hoisted.devices = [
      { serial: 'emulator-5554', model: 'Pixel A', platform: 'android', osVersion: '16', isEmulator: true, state: 'Active' },
    ];
    const out = JSON.parse(await callTool('tapsmith_list_devices', makeDispatcher({
      getSessionInfo: () => { throw new Error('not initialized'); },
    }))) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]!.serial).toBe('emulator-5554');
  });
});
