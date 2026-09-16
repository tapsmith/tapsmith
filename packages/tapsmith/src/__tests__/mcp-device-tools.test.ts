import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { selectorToProto } from '../selectors.js';
import type { DeviceInfoProto, ElementInfo, TapsmithGrpcClient } from '../grpc-client.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';

// The device-backed half of the MCP surface — snapshot, screenshot, tap, type,
// swipe, press_key, launch_app, list_devices, test_locator, watch — had no
// coverage at the tool boundary: only the helpers underneath it did. These
// drive the real server through a real MCP client, so a tool that fails to
// register, a schema that stops validating, or an error path that silently
// reports success is a failure here rather than something an agent discovers
// mid-session.
//
// The daemon is the only thing faked. `resolveDeviceTarget` is where a tool
// stops being testable without a device, so that is the seam.

const hoisted = vi.hoisted(() => ({
  client: null as unknown as TapsmithGrpcClient,
  devices: [] as DeviceInfoProto[],
  sessionSerials: null as Set<string> | null,
  requests: [] as Array<{ device?: string; project?: { name: string; platform?: string } }>,
}));

vi.mock('../mcp/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/connection.js')>()),
  resolveDeviceTarget: async (request?: { device?: string; project?: { name: string; platform?: string } }) => {
    hoisted.requests.push(request ?? {});
    return { client: hoisted.client, device: request?.device };
  },
  listAllDevices: async () => hoisted.devices,
  getSessionDeviceSerials: () => hoisted.sessionSerials,
}));

const { createMcpServer } = await import('../mcp/index.js');

// ─── Fakes ───

function makeElement(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1',
    className: 'android.widget.TextView',
    text: '',
    contentDescription: '',
    resourceId: '',
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: '',
    checked: false,
    selected: false,
    focused: false,
    role: '',
    viewportRatio: 1.0,
    ...overrides,
  };
}

interface FakeDaemon {
  client: TapsmithGrpcClient
  findElements: ReturnType<typeof vi.fn>
  tap: ReturnType<typeof vi.fn>
  typeText: ReturnType<typeof vi.fn>
  clearText: ReturnType<typeof vi.fn>
  swipe: ReturnType<typeof vi.fn>
  pressKey: ReturnType<typeof vi.fn>
  launchApp: ReturnType<typeof vi.fn>
  getUiHierarchy: ReturnType<typeof vi.fn>
  takeScreenshot: ReturnType<typeof vi.fn>
  /** Every action call, in the order the tool made them. */
  calls: string[]
}

function ok(): { requestId: string; success: true; errorType: string; errorMessage: string } {
  return { requestId: '1', success: true, errorType: '', errorMessage: '' };
}

function makeDaemon(options: {
  elements?: ElementInfo[]
  hierarchyXml?: string
  hierarchyError?: string
  findError?: string
  screenshot?: Buffer
  screenshotError?: string
  actionError?: string
} = {}): FakeDaemon {
  const calls: string[] = [];
  const action = (name: string) => vi.fn(async () => {
    calls.push(name);
    return options.actionError
      ? { requestId: '1', success: false, errorType: 'ACTION_FAILED', errorMessage: options.actionError }
      : ok();
  });

  const daemon = {
    calls,
    findElements: vi.fn(async () => ({
      requestId: '1',
      elements: options.elements ?? [],
      errorMessage: options.findError ?? '',
    })),
    tap: action('tap'),
    typeText: action('typeText'),
    clearText: action('clearText'),
    swipe: action('swipe'),
    pressKey: action('pressKey'),
    launchApp: action('launchApp'),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: options.hierarchyXml ?? '<hierarchy />',
      errorMessage: options.hierarchyError ?? '',
    })),
    takeScreenshot: vi.fn(async () => ({
      requestId: '1',
      success: !options.screenshotError,
      data: options.screenshot ?? Buffer.alloc(0),
      errorMessage: options.screenshotError ?? '',
    })),
  } as unknown as FakeDaemon;
  daemon.client = daemon as unknown as TapsmithGrpcClient;
  return daemon;
}

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
    toggleWatch: () => ({ enabled: true }),
    ...overrides,
  };
}

// ─── Harness ───

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  dispatcher: TestDispatcher = makeDispatcher(),
): Promise<CallToolResult> {
  const server = createMcpServer({ dispatcher });
  const client = new Client({ name: 'device-tool-probe', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    return await client.callTool({ name, arguments: args }) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function text(res: CallToolResult): string {
  return res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

/** The iOS sign-in screen the locator fixtures use, as agent hierarchy XML. */
const SIGN_IN_XML = `
<XCUIElementTypeApplication type="XCUIElementTypeApplication">
  <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Sign in to continue to DreamSpinner" clickable="false" />
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Sign in" clickable="true" />
</XCUIElementTypeApplication>`;

beforeEach(() => {
  hoisted.client = makeDaemon().client;
  hoisted.devices = [];
  hoisted.sessionSerials = null;
  hoisted.requests = [];
});

// ─── tapsmith_snapshot ───

describe('tapsmith_snapshot', () => {
  it('returns the tree and the locators an agent is meant to copy', async () => {
    hoisted.client = makeDaemon({ hierarchyXml: SIGN_IN_XML }).client;
    const res = await callTool('tapsmith_snapshot');
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('Sign in to continue to DreamSpinner');
    expect(out).toContain('## Suggested Locators');
    expect(out).toContain('device.getByRole("button", { name: "Sign in" })');
  });

  it('reports a daemon error instead of an empty screen', async () => {
    // The failure this guards: an errored hierarchy parses to no nodes, so
    // without the check the tool answers "(empty screen)" — an agent then
    // believes the app rendered nothing rather than that the device is gone.
    hoisted.client = makeDaemon({ hierarchyError: 'device offline' }).client;
    const res = await callTool('tapsmith_snapshot');
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: device offline');
  });

  it('says the screen is empty when the hierarchy genuinely is', async () => {
    const res = await callTool('tapsmith_snapshot');
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('(empty screen)');
  });

  it('passes the requested device through to the daemon target', async () => {
    await callTool('tapsmith_snapshot', { device: 'emulator-5556' });
    expect(hoisted.requests.at(-1)).toMatchObject({ device: 'emulator-5556' });
  });

  it('resolves a project name to its platform before picking a device', async () => {
    const dispatcher = makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [{ name: 'ios', platform: 'ios', testFiles: [], dependencies: [] }],
      }),
    });
    await callTool('tapsmith_snapshot', { project: 'ios' }, dispatcher);
    expect(hoisted.requests.at(-1)).toMatchObject({ project: { name: 'ios', platform: 'ios' } });
  });
});

// ─── tapsmith_screenshot ───

describe('tapsmith_screenshot', () => {
  it('returns the PNG as base64 image content, not text', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    hoisted.client = makeDaemon({ screenshot: png }).client;
    const res = await callTool('tapsmith_screenshot');
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);
    const image = res.content[0] as { type: string; data: string; mimeType: string };
    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64')).toEqual(png);
  });

  it('reports a capture failure as an error', async () => {
    hoisted.client = makeDaemon({ screenshotError: 'screencap failed' }).client;
    const res = await callTool('tapsmith_screenshot');
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: screencap failed');
  });
});

// ─── tapsmith_tap ───

describe('tapsmith_tap', () => {
  it('taps a unique match by locator', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Sign in' })] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Sign in")' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('OK');
    expect(daemon.tap).toHaveBeenCalledTimes(1);
    const [selector, , elementId] = daemon.tap.mock.calls[0];
    expect(selectorToProto(selector)).toEqual({ textContains: 'Sign in' });
    expect(elementId).toBeUndefined();
  });

  it('refuses an ambiguous locator and taps nothing (PILOT-226)', async () => {
    // Strict mode is only worth anything if the tap does not happen. Before
    // this path existed the agent tapped the first match — the subtitle, not
    // the button — and the run failed several steps later.
    const daemon = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Sign in to continue', role: 'text' }),
        makeElement({ elementId: 'el-2', text: 'Sign in', role: 'button' }),
      ],
    });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Sign in")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/strict mode violation/);
    expect(text(res)).toContain('resolved to 2 elements');
    expect(daemon.tap).not.toHaveBeenCalled();
  });

  it('taps the exact element a positional chain resolved, by id', async () => {
    // Both matches share the text, so a locator would land on the first one.
    const daemon = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Sign in' }),
        makeElement({ elementId: 'el-2', text: 'Sign in' }),
      ],
    });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Sign in").nth(1)' });
    expect(res.isError).toBeFalsy();
    const [selector, , elementId] = daemon.tap.mock.calls[0];
    expect(selector).toBeUndefined();
    expect(elementId).toBe('el-2');
  });

  it('surfaces a daemon failure rather than reporting OK', async () => {
    hoisted.client = makeDaemon({
      elements: [makeElement({ text: 'Sign in' })],
      actionError: 'element not clickable',
    }).client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Sign in")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: element not clickable');
  });

  it('requires a locator, and says which argument is missing', async () => {
    const res = await callTool('tapsmith_tap', {});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('locator');
  });
});

// ─── tapsmith_type ───

describe('tapsmith_type', () => {
  it('types without clearing by default', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Email' })] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_type', {
      locator: 'device.getByText("Email")',
      text: 'sam@example.com',
    });
    expect(text(res)).toBe('OK');
    expect(daemon.clearText).not.toHaveBeenCalled();
    expect(daemon.typeText.mock.calls[0][1]).toBe('sam@example.com');
  });

  it('clears before typing when asked, in that order', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Email' })] });
    hoisted.client = daemon.client;
    await callTool('tapsmith_type', {
      locator: 'device.getByText("Email")',
      text: 'new',
      clear: true,
    });
    expect(daemon.calls).toEqual(['clearText', 'typeText']);
  });

  it('clears the same element it types into', async () => {
    // A positional target types by id; clearing by locator instead would wipe
    // the first match and type into the second.
    const daemon = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Code' }),
        makeElement({ elementId: 'el-2', text: 'Code' }),
      ],
    });
    hoisted.client = daemon.client;
    await callTool('tapsmith_type', {
      locator: 'device.getByText("Code").nth(1)',
      text: '2',
      clear: true,
    });
    expect(daemon.clearText.mock.calls[0][0]).toBeUndefined();
    expect(daemon.clearText.mock.calls[0][2]).toBe('el-2');
    expect(daemon.typeText.mock.calls[0][4]).toBe('el-2');
  });

  it('refuses an ambiguous locator and types nothing', async () => {
    const daemon = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Email address' }),
        makeElement({ elementId: 'el-2', text: 'Email' }),
      ],
    });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_type', {
      locator: 'device.getByText("Email")',
      text: 'sam@example.com',
    });
    expect(res.isError).toBe(true);
    expect(daemon.typeText).not.toHaveBeenCalled();
    expect(daemon.clearText).not.toHaveBeenCalled();
  });
});

// ─── tapsmith_swipe / tapsmith_press_key ───

describe('tapsmith_swipe', () => {
  it('passes the direction to the daemon', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_swipe', { direction: 'up' });
    expect(text(res)).toBe('OK');
    expect(daemon.swipe).toHaveBeenCalledWith('up');
  });

  it('rejects a direction that is not one of the four', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_swipe', { direction: 'diagonal' });
    expect(res.isError).toBe(true);
    expect(daemon.swipe).not.toHaveBeenCalled();
  });

  it('reports a swipe the device refused', async () => {
    hoisted.client = makeDaemon({ actionError: 'nothing scrollable' }).client;
    const res = await callTool('tapsmith_swipe', { direction: 'down' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: nothing scrollable');
  });
});

describe('tapsmith_press_key', () => {
  it('passes the key name through unchanged', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    await callTool('tapsmith_press_key', { key: 'back' });
    expect(daemon.pressKey).toHaveBeenCalledWith('back');
  });

  it('reports a key the device does not know', async () => {
    hoisted.client = makeDaemon({ actionError: 'unknown key: teleport' }).client;
    const res = await callTool('tapsmith_press_key', { key: 'teleport' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: unknown key: teleport');
  });
});

// ─── tapsmith_launch_app ───

describe('tapsmith_launch_app', () => {
  it('leaves app data alone unless asked', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_launch_app', { package: 'com.example.app' });
    expect(text(res)).toBe('OK');
    expect(daemon.launchApp).toHaveBeenCalledWith('com.example.app', { clearData: false });
  });

  it('clears app data when the caller asks for a fresh start', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    await callTool('tapsmith_launch_app', { package: 'com.example.app', clear_data: true });
    expect(daemon.launchApp).toHaveBeenCalledWith('com.example.app', { clearData: true });
  });

  it('reports a launch failure', async () => {
    hoisted.client = makeDaemon({ actionError: 'package not installed' }).client;
    const res = await callTool('tapsmith_launch_app', { package: 'com.missing' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: package not installed');
  });

  it('requires a package name, and says which argument is missing', async () => {
    const res = await callTool('tapsmith_launch_app', {});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('package');
  });
});

// ─── tapsmith_list_devices ───

function deviceInfo(overrides: Partial<DeviceInfoProto> = {}): DeviceInfoProto {
  return {
    serial: 'emulator-5554',
    model: 'Pixel 7',
    state: 'device',
    isEmulator: true,
    platform: 'android',
    osVersion: '14',
    ...overrides,
  };
}

describe('tapsmith_list_devices', () => {
  it('reports each device under the field names the tool documents', async () => {
    hoisted.devices = [deviceInfo()];
    const res = await callTool('tapsmith_list_devices');
    expect(JSON.parse(text(res))).toEqual([{
      serial: 'emulator-5554',
      model: 'Pixel 7',
      platform: 'android',
      os_version: '14',
      is_emulator: true,
      state: 'device',
    }]);
  });

  it('lists only the devices the session drives when it is scoped to some', async () => {
    // In UI mode the machine may have a dozen simulators booted; offering them
    // all invites an agent to act on one whose daemon is pointed elsewhere.
    hoisted.devices = [
      deviceInfo({ serial: 'emulator-5554' }),
      deviceInfo({ serial: 'emulator-5556' }),
      deviceInfo({ serial: 'ABC-IOS', platform: 'ios', isEmulator: false }),
    ];
    hoisted.sessionSerials = new Set(['emulator-5556', 'ABC-IOS']);
    const listed = JSON.parse(text(await callTool('tapsmith_list_devices'))) as Array<{ serial: string }>;
    expect(listed.map((d) => d.serial)).toEqual(['emulator-5556', 'ABC-IOS']);
  });

  it('lists everything visible when the session is not scoped', async () => {
    hoisted.devices = [deviceInfo({ serial: 'a' }), deviceInfo({ serial: 'b' })];
    hoisted.sessionSerials = null;
    const listed = JSON.parse(text(await callTool('tapsmith_list_devices'))) as Array<{ serial: string }>;
    expect(listed.map((d) => d.serial)).toEqual(['a', 'b']);
  });

  it('returns an empty list, not an error, when nothing is connected', async () => {
    const res = await callTool('tapsmith_list_devices');
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual([]);
  });
});

// ─── tapsmith_test_locator ───

describe('tapsmith_test_locator', () => {
  it('reports a unique match', async () => {
    hoisted.client = makeDaemon({
      elements: [makeElement({ text: 'Sign in', role: 'button' })],
    }).client;
    const res = await callTool('tapsmith_test_locator', { locator: 'device.getByText("Sign in")' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toMatchObject({
      matched: true,
      count: 1,
      elements: [{ role: 'button', text: 'Sign in' }],
    });
  });

  it('warns that an ambiguous locator will throw at runtime', async () => {
    hoisted.client = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Sign in to continue' }),
        makeElement({ elementId: 'el-2', text: 'Sign in' }),
      ],
    }).client;
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', {
      locator: 'device.getByText("Sign in")',
    })));
    expect(result.count).toBe(2);
    expect(result.strictModeWarning).toMatch(/strict mode violation/);
  });

  it('reports how many a positional chain narrowed from', async () => {
    hoisted.client = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Item 1' }),
        makeElement({ elementId: 'el-2', text: 'Item 2' }),
        makeElement({ elementId: 'el-3', text: 'Item 3' }),
      ],
    }).client;
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', {
      locator: 'device.getByText("Item").first()',
    })));
    expect(result).toMatchObject({ matched: true, count: 1, totalMatches: 3 });
    expect(result.strictModeWarning).toBeUndefined();
  });

  it('reports no match without calling it an error', async () => {
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', {
      locator: 'device.getByText("Ghost")',
    })));
    expect(result).toMatchObject({ matched: false, count: 0 });
  });

  it('rejects a string that is not a locator, and says what is valid', async () => {
    const res = await callTool('tapsmith_test_locator', { locator: 'click the login button' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Invalid locator');
    expect(text(res)).toContain('getByTestId()');
  });

  it('surfaces a daemon error instead of reporting no match', async () => {
    hoisted.client = makeDaemon({ findError: 'agent not responding' }).client;
    const res = await callTool('tapsmith_test_locator', { locator: 'device.getByText("Sign in")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error: agent not responding');
  });
});

// ─── tapsmith_watch ───

describe('tapsmith_watch', () => {
  it('says what it enabled and that saving re-runs it', async () => {
    const res = await callTool('tapsmith_watch', { file: '/proj/e2e/login.test.ts' }, makeDispatcher({
      toggleWatch: () => ({ enabled: true }),
    }));
    expect(text(res)).toBe('Watch enabled for file. Will re-run on save.');
  });

  it('reports the toggle turning watch off', async () => {
    const res = await callTool('tapsmith_watch', { file: '/proj/e2e/login.test.ts' }, makeDispatcher({
      toggleWatch: () => ({ enabled: false }),
    }));
    expect(text(res)).toBe('Watch disabled for file.');
  });

  it('scopes the watch to one test and one project when asked', async () => {
    const toggleWatch = vi.fn(() => ({ enabled: true }));
    const res = await callTool(
      'tapsmith_watch',
      { file: '/proj/e2e/login.test.ts', test: 'signs in', project: 'ios' },
      makeDispatcher({ toggleWatch }),
    );
    expect(toggleWatch).toHaveBeenCalledWith('/proj/e2e/login.test.ts', {
      testFilter: 'signs in',
      project: 'ios',
    });
    expect(text(res)).toBe('Watch enabled for test "signs in" [ios]. Will re-run on save.');
  });
});

// ─── Registration ───

describe('the device tools the server advertises', () => {
  it('registers every device tool, with the arguments an agent needs', async () => {
    const server = createMcpServer({ dispatcher: makeDispatcher() });
    const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));

      // The whole inventory a session with a dispatcher offers. Adding a tool
      // is meant to fail here — this is the one place that says what the
      // surface is.
      expect([...byName.keys()].sort()).toEqual([
        'tapsmith_launch_app',
        'tapsmith_list_devices',
        'tapsmith_list_results',
        'tapsmith_list_tests',
        'tapsmith_press_key',
        'tapsmith_read_trace',
        'tapsmith_run_tests',
        'tapsmith_screenshot',
        'tapsmith_session_info',
        'tapsmith_snapshot',
        'tapsmith_stop_tests',
        'tapsmith_suite_status',
        'tapsmith_swipe',
        'tapsmith_tap',
        'tapsmith_test_locator',
        'tapsmith_type',
        'tapsmith_watch',
      ]);

      for (const name of [
        'tapsmith_snapshot', 'tapsmith_screenshot', 'tapsmith_test_locator',
        'tapsmith_tap', 'tapsmith_type', 'tapsmith_swipe', 'tapsmith_press_key',
        'tapsmith_launch_app', 'tapsmith_list_devices', 'tapsmith_watch',
      ]) {
        expect(byName.has(name), `${name} is not registered`).toBe(true);
        expect(byName.get(name)!.description, `${name} has no description`).toBeTruthy();
      }

      // Every device tool takes the same two optional targeting arguments, and
      // neither is ever required — a single-device session must not have to
      // name one.
      for (const name of ['tapsmith_snapshot', 'tapsmith_tap', 'tapsmith_launch_app']) {
        const schema = byName.get(name)!.inputSchema as {
          properties: Record<string, unknown>
          required?: string[]
        };
        expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['device', 'project']));
        expect(schema.required ?? []).not.toContain('device');
        expect(schema.required ?? []).not.toContain('project');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the device tools, and drops only the dispatcher-backed ones, without a dispatcher', async () => {
    // The UI transport builds a server without a dispatcher for probing; the
    // device tools still have to be there, since they do not need one.
    const server = createMcpServer();
    const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('tapsmith_snapshot');
      expect(names).toContain('tapsmith_tap');
      expect(names).not.toContain('tapsmith_watch');
      expect(names).not.toContain('tapsmith_list_tests');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
