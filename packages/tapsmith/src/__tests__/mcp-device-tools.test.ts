import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { selectorToProto } from '../selectors.js';
import type { DeviceInfoProto, ElementInfo, TapsmithGrpcClient } from '../grpc-client.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';
import { summarizeResult } from '../mcp/events.js';
import { formatToolArgs } from '../ui-mode/components/tool-args.js';

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
  unusable: [] as DeviceInfoProto[],
  sessionSerials: null as Set<string> | null,
  requests: [] as Array<{ device?: string; project?: { name: string; platform?: string } }>,
}));

vi.mock('../mcp/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/connection.js')>()),
  resolveDeviceTarget: async (request?: { device?: string; project?: { name: string; platform?: string } }) => {
    hoisted.requests.push(request ?? {});
    return { client: hoisted.client, device: request?.device };
  },
  listAllDevices: async () => ({ devices: hoisted.devices, unusable: hoisted.unusable }),
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
    deviceChoiceError: async () => null,
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
  hoisted.unusable = [];
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

  // The section heading is a literal in two places: emitted by snapshot.ts and
  // parsed back out by summarizeResult (mcp/events.ts) for the activity feed.
  // Each side has its own test with its own copy of the string, so editing one
  // leaves both green while the feed silently reports 0 locators. Pipe the real
  // snapshot output through the real summariser so the two stay tied.
  it('produces output the activity-feed summariser can still count', async () => {
    hoisted.client = makeDaemon({ hierarchyXml: SIGN_IN_XML }).client;
    const out = text(await callTool('tapsmith_snapshot'));

    // Parse the count rather than substring-matching it: '10 locators' contains
    // '0 locators', so a negative substring assertion would fire on a fixture that
    // happens to suggest a multiple of ten.
    const summary = summarizeResult('tapsmith_snapshot', out);
    const counts = /^(\d+) elements, (\d+) locators$/.exec(summary);
    expect(counts, `summariser could not parse: ${summary}`).not.toBeNull();
    expect(Number(counts![2])).toBeGreaterThan(0);
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

  it('taps with getByRole\'s state filters, not without them (PILOT-655)', async () => {
    // The parser used to drop `selected`, so the agent tapped whichever
    // "Space" card came first, selected or not.
    const daemon = makeDaemon({ elements: [makeElement({ contentDescription: 'Space', role: 'button', selected: true })] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByRole("button", { name: "Space", exact: true, selected: true })' });
    expect(res.isError).toBeFalsy();
    const expected = { role: { role: 'button', name: 'Space', exact: true, selected: true } };
    expect(selectorToProto(daemon.findElements.mock.calls[0][0])).toEqual(expected);
    expect(selectorToProto(daemon.tap.mock.calls[0][0])).toEqual(expected);
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

  it('refuses a chained locator rather than tapping the unscoped getter (PILOT-660)', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Save' })] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Save").filter({ hasText: "draft" })' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('unsupported chained call .filter()');
    expect(daemon.findElements).not.toHaveBeenCalled();
    expect(daemon.tap).not.toHaveBeenCalled();
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

  it('reports a failure the daemon gave no message for, rather than OK', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Login' })] });
    daemon.tap.mockResolvedValueOnce({ requestId: '1', success: false, errorType: '', errorMessage: '' });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Login")' });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toBe('OK');
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

  it('reports a clear that failed, and types nothing into the stale text', async () => {
    // Typing after a failed clear appends to the old value, and "OK" hid it:
    // the agent believed the field held exactly the new text (PILOT-267).
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Email' })] });
    daemon.clearText.mockResolvedValueOnce({
      requestId: '1', success: false, errorType: 'ACTION_FAILED', errorMessage: 'field is read-only',
    });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_type', {
      locator: 'device.getByText("Email")',
      text: 'new',
      clear: true,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('clear');
    expect(text(res)).toContain('field is read-only');
    expect(daemon.typeText).not.toHaveBeenCalled();
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

  it('reports a launch failure the daemon gave no message for, rather than OK', async () => {
    const daemon = makeDaemon();
    daemon.launchApp.mockResolvedValueOnce({ requestId: '1', success: false, errorType: '', errorMessage: '' });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_launch_app', { package: 'com.example.app' });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toBe('OK');
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
      usable: true,
    }]);
  });

  // PILOT-457: an agent asking why nothing runs saw an empty list while a
  // phone sat there with its USB-debugging prompt unanswered.
  it('reports attached but unusable devices with adb\'s state and the fix', async () => {
    hoisted.devices = [deviceInfo()];
    hoisted.unusable = [deviceInfo({ serial: 'R5CR1234XYZ', model: '', state: 'unauthorized', isEmulator: false, osVersion: '' })];
    const listed = JSON.parse(text(await callTool('tapsmith_list_devices'))) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ serial: 'emulator-5554', usable: true });
    expect(listed[0]).not.toHaveProperty('fix');
    expect(listed[1]).toEqual({
      serial: 'R5CR1234XYZ',
      model: '',
      platform: 'android',
      os_version: '',
      is_emulator: false,
      state: 'unauthorized',
      usable: false,
      fix: 'Accept the USB debugging prompt on the device',
    });
  });

  it('gives no adb fix for a device the daemon only knows is Disconnected', async () => {
    hoisted.unusable = [deviceInfo({ serial: 'GONE', state: 'Disconnected' })];
    const listed = JSON.parse(text(await callTool('tapsmith_list_devices'))) as Array<Record<string, unknown>>;
    expect(listed).toEqual([expect.objectContaining({ serial: 'GONE', usable: false })]);
    expect(listed[0]).not.toHaveProperty('fix');
  });

  it('scopes unusable devices to the session like usable ones', async () => {
    hoisted.devices = [deviceInfo({ serial: 'emulator-5556' })];
    hoisted.unusable = [deviceInfo({ serial: 'R5CR1234XYZ', state: 'unauthorized' })];
    hoisted.sessionSerials = new Set(['emulator-5556']);
    const listed = JSON.parse(text(await callTool('tapsmith_list_devices'))) as Array<{ serial: string }>;
    expect(listed.map((d) => d.serial)).toEqual(['emulator-5556']);
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

  // The tool name is a literal in two places: the registration in
  // mcp/tools/test-locator.ts and the `case` summarizeResult (mcp/events.ts)
  // switches on for the activity feed. ONE constant is used for both calls below
  // on purpose: renaming the tool in source makes callTool fail, and updating this
  // constant to match then makes summarizeResult fall through to its default arm —
  // so the divergence cannot be repaired into a false green.
  it('produces a result the activity-feed summariser recognises by name', async () => {
    const TOOL = 'tapsmith_test_locator';
    hoisted.client = makeDaemon({
      elements: [makeElement({ text: 'Sign in', role: 'button' })],
    }).client;
    const out = text(await callTool(TOOL, { locator: 'device.getByText("Sign in")' }));

    expect(summarizeResult(TOOL, out)).toBe('matched 1 element');
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

  it('names the option it refuses instead of running the locator without it (PILOT-655)', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'A' })] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_test_locator', { locator: 'device.getByRole("heading", { name: "A", level: 2 })' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Invalid locator: "device.getByRole("heading", { name: "A", level: 2 })": unsupported option "level".');
    expect(daemon.findElements).not.toHaveBeenCalled();
  });

  it('refuses a chained call instead of counting the unscoped getter (PILOT-660)', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ role: 'list' }), makeElement({ elementId: 'el-2', role: 'list' })] });
    hoisted.client = daemon.client;
    const locator = 'device.getByRole("list").getByText("x")';
    const res = await callTool('tapsmith_test_locator', { locator });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(`Invalid locator: "${locator}": unsupported chained call .getByText() — `
      + 'a locator string here is one getter, optionally followed by .first(), .last() or .nth(n).');
    expect(daemon.findElements).not.toHaveBeenCalled();
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

      // UI mode's Device Activity feed reads the target argument out of the
      // event it is sent, so the key is a literal shared between each tool's
      // schema and formatToolArgs. Read the key the tool ACTUALLY advertises
      // and feed the reader that — renaming the argument on one side alone
      // then blanks the row here instead of silently in the live feed.
      for (const name of ['tapsmith_tap', 'tapsmith_type']) {
        const props = (byName.get(name)!.inputSchema as { properties: Record<string, unknown> }).properties;
        const targetArg = Object.keys(props).find((k) => k !== 'device' && k !== 'project' && k !== 'text' && k !== 'clear');
        expect(targetArg, `${name} advertises no target argument`).toBeDefined();
        expect(formatToolArgs(name, { [targetArg!]: 'device.getByText("Login")' }))
          .toBe('device.getByText("Login")');
      }

      // Same tie for the feed's other summarised row, which reads a different key.
      const runProps = (byName.get('tapsmith_run_tests')!.inputSchema as {
        properties: Record<string, { type?: string }>
      }).properties;
      const filesArg = Object.keys(runProps).find((k) => runProps[k]?.type === 'array');
      expect(filesArg, 'tapsmith_run_tests advertises no array argument').toBeDefined();
      expect(formatToolArgs('tapsmith_run_tests', { [filesArg!]: ['/proj/e2e/login.test.ts'] }))
        .toBe('Running login.test.ts');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports the installed package version to the client, not a placeholder', async () => {
    // Both transports build their server here, so this covers UI mode too.
    const pkgPath = path.resolve(fileURLToPath(import.meta.url), '../../../package.json');
    const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    const server = createMcpServer({ dispatcher: makeDispatcher() });
    const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getServerVersion()?.version).toBe(version);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('tells an agent every form tapsmith_run_tests accepts for `files`', async () => {
    // Both dispatchers resolve absolute, project-relative and glob paths
    // (matchRequestedFiles); a description naming fewer steers agents away
    // from forms that work (PILOT-267).
    const server = createMcpServer({ dispatcher: makeDispatcher() });
    const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const runTests = (await client.listTools()).tools.find((t) => t.name === 'tapsmith_run_tests');
      const files = (runTests?.inputSchema.properties?.files ?? {}) as { description?: string };
      expect(files.description).toMatch(/absolute/i);
      // "Project root" read as the repo root sent agents to `e2e/tests/…`
      // when the config lives in e2e/; the resolution base is rootDir.
      expect(files.description).toMatch(/relative to the config's directory \(rootDir\)/i);
      expect(files.description).toMatch(/working directory/i);
      expect(files.description).toMatch(/glob/i);
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
