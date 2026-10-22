import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { selectorToProto } from '../selectors.js';
import type { Selector } from '../selectors.js';
import type { DeviceInfoProto, ElementInfo, TapsmithGrpcClient } from '../grpc-client.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';
import { summarizeResult } from '../mcp/events.js';
import { formatToolArgs } from '../ui-mode/components/tool-args.js';
import { Device } from '../device.js';
import { closeMcpWebViews, sdkDeviceFor, WEBVIEW_IDLE_CLOSE_MS, withEvaluatedLocator } from '../mcp/sdk-device.js';
import type { WebViewHandle } from '../webview-handle.js';

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
  evaluateSelectors: ReturnType<typeof vi.fn>
  tap: ReturnType<typeof vi.fn>
  typeText: ReturnType<typeof vi.fn>
  clearText: ReturnType<typeof vi.fn>
  clearAndType: ReturnType<typeof vi.fn>
  getCurrentPackage: ReturnType<typeof vi.fn>
  listDevices: ReturnType<typeof vi.fn>
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
  /** What the agent matches per selector when evaluating; default: `elements`. */
  evaluate?: (selector: Selector) => ElementInfo[] | Error
  /** What findElements matches per selector; default: `elements`. */
  find?: (selector: Selector) => ElementInfo[]
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
    findElements: vi.fn(async (selector: Selector) => ({
      requestId: '1',
      elements: options.find ? options.find(selector) : (options.elements ?? []),
      errorMessage: options.findError ?? '',
    })),
    listDevices: vi.fn(async () => ({ requestId: '1', devices: [], unusable: [] })),
    getCurrentPackage: vi.fn(async () => ({ requestId: '1', packageName: 'com.example' })),
    evaluateSelectors: vi.fn(async (selectors: Selector[]) => ({
      requestId: '1',
      errorMessage: options.findError ?? '',
      results: options.findError ? [] : selectors.map((sel) => {
        const r = options.evaluate ? options.evaluate(sel) : (options.elements ?? []);
        return r instanceof Error ? { elements: [], errorMessage: r.message } : { elements: r, errorMessage: '' };
      }),
    })),
    tap: action('tap'),
    typeText: action('typeText'),
    clearText: action('clearText'),
    clearAndType: action('clearAndType'),
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
  <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Sign in to continue to DreamSpinner" clickable="false" bounds="[0,100][390,140]" />
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Sign in" clickable="true" bounds="[20,200][370,250]" />
</XCUIElementTypeApplication>`;

/** The sign-in screen's two elements as the agent reports them. */
const SIGN_IN_TEXT = { text: 'Sign in to continue to DreamSpinner', className: 'XCUIElementTypeStaticText', bounds: { left: 0, top: 100, right: 390, bottom: 140 } };
const SIGN_IN_BUTTON = { text: 'Sign in', className: 'XCUIElementTypeButton', role: 'button', bounds: { left: 20, top: 200, right: 370, bottom: 250 } };

/** A fake agent for the sign-in screen: substring text matches both, the rest is exact. */
function signInAgent(sel: Selector): ElementInfo[] {
  const k = sel.kind;
  const all = [SIGN_IN_TEXT, SIGN_IN_BUTTON];
  let hits: typeof all = [];
  if (k.type === 'textContains') hits = all.filter((e) => e.text.toLowerCase().includes(k.value.toLowerCase()));
  else if (k.type === 'text') hits = all.filter((e) => e.text === k.value);
  else if (k.type === 'role') hits = k.value.role === 'button' && (!k.value.name || k.value.name === 'Sign in') ? [SIGN_IN_BUTTON] : [];
  else if (k.type === 'className') hits = all.filter((e) => e.className === k.value);
  return hits.map((h) => makeElement({ elementId: '', ...h }));
}

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
    hoisted.client = makeDaemon({ hierarchyXml: SIGN_IN_XML, evaluate: signInAgent }).client;
    const res = await callTool('tapsmith_snapshot');
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('Sign in to continue to DreamSpinner');
    expect(out).toContain('## Suggested Locators');
    expect(out).toContain('device.getByRole("button", { name: "Sign in" })');
  });

  it('offers only what the agent resolves to that element (PILOT-848)', async () => {
    // The agent finds no button here (as on Compose, PILOT-833): the role
    // suggestion the hierarchy alone would make must not be offered.
    const daemon = makeDaemon({
      hierarchyXml: SIGN_IN_XML,
      evaluate: (sel) => (sel.kind.type === 'role' ? [] : signInAgent(sel)),
    });
    hoisted.client = daemon.client;
    const out = text(await callTool('tapsmith_snapshot'));
    expect(out).not.toContain('getByRole("button"');
    // The ambiguous substring is upgraded to the exact text the agent resolves uniquely.
    expect(out).toContain('device.getByText("Sign in", { exact: true })');
    expect(daemon.findElements).not.toHaveBeenCalled();
  });

  it('says the screen may have changed when the agent resolves nothing to its element', async () => {
    // The dump and the agent's check saw different screens (a transition):
    // every candidate resolves elsewhere.
    const moved = (sel: Selector) => signInAgent(sel).map((e) => ({ ...e, bounds: { ...e.bounds!, top: e.bounds!.top + 300, bottom: e.bounds!.bottom + 300 } }));
    hoisted.client = makeDaemon({ hierarchyXml: SIGN_IN_XML, evaluate: moved }).client;
    const res = await callTool('tapsmith_snapshot');
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('button "Sign in"');
    expect(out).not.toContain('## Suggested Locators');
    expect(out).toContain('the screen may have been changing. Take the snapshot again.');
  });

  it('says some listed elements were not on screen when the agent checked them (the screen changed)', async () => {
    // The dump shows the sign-in screen; by the check the static text is gone.
    const gone = (sel: Selector) => signInAgent(sel).filter((e) => e.text !== 'Sign in to continue to DreamSpinner');
    hoisted.client = makeDaemon({ hierarchyXml: SIGN_IN_XML, evaluate: gone }).client;
    const out = text(await callTool('tapsmith_snapshot'));
    expect(out).toContain('## Suggested Locators');
    expect(out).toContain('(1 listed element was not on screen when the device agent checked it, so it has no suggested locator; the screen may have changed. Take the snapshot again.)');
  });

  it('checks a big iOS screen in one call (an iOS agent captures once per call)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      `  <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Row ${i}" bounds="[0,${i * 50}][390,${i * 50 + 40}]" />`).join('\n');
    // Shaped like the iOS agent's dump: wrapped in <hierarchy>, like Android's.
    const daemon = makeDaemon({ hierarchyXml: `<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy>\n<XCUIElementTypeApplication type="XCUIElementTypeApplication">\n${rows}\n</XCUIElementTypeApplication>\n</hierarchy>` });
    hoisted.client = daemon.client;
    await callTool('tapsmith_snapshot');
    expect(daemon.evaluateSelectors.mock.calls[0][0].length).toBeGreaterThan(40);
  });

  it('says nothing about refs when the screen has no element to suggest for', async () => {
    hoisted.client = makeDaemon({ hierarchyXml: '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][10,10]" /></hierarchy>' }).client;
    expect(text(await callTool('tapsmith_snapshot'))).not.toContain('No suggested locators');
  });

  it('keeps the activity-feed count right when checking stopped partway', async () => {
    const daemon = makeDaemon({ hierarchyXml: SIGN_IN_XML, evaluate: signInAgent });
    let calls = 0;
    const real = daemon.evaluateSelectors.getMockImplementation() as (selectors: Selector[]) => Promise<unknown>;
    daemon.evaluateSelectors.mockImplementation(async (selectors: Selector[]) => {
      calls++;
      // The first chunk is answered; checking stops at the next one.
      return calls === 1 ? real(selectors) : { requestId: '1', results: [], errorMessage: 'Agent command timed out' };
    });
    hoisted.client = daemon.client;
    const out = text(await callTool('tapsmith_snapshot'));
    // The candidates were all checked; only the variants that would pin the
    // ambiguous ones were not, so those fall back to a position.
    expect(out).toContain('(Some suggestions are pinned by position (.first()/.nth()/.last()) because the device agent stopped checking more specific ones: Agent command timed out)');
    expect(out).not.toContain('Some elements have no suggested locator');
    const refs = out.split('\n').filter((l) => /^\[\d+\] /.test(l)).length;
    expect(refs).toBeGreaterThan(0);
    expect(summarizeResult('tapsmith_snapshot', out)).toMatch(new RegExp(`, ${refs} locators$`));
  });

  it('says why there are no refs when the agent cannot check them, and still shows the tree', async () => {
    const daemon = makeDaemon({ hierarchyXml: SIGN_IN_XML });
    daemon.evaluateSelectors.mockResolvedValue({ requestId: '1', results: [], errorMessage: 'Unknown method: evaluateSelectors' });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_snapshot');
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('button "Sign in"');
    expect(out).not.toContain('## Suggested Locators');
    expect(out).toContain('(No suggested locators: the device agent stopped checking them: Unknown method: evaluateSelectors)');
  });

  // The section heading is a literal in two places: emitted by snapshot.ts and
  // parsed back out by summarizeResult (mcp/events.ts) for the activity feed.
  // Each side has its own test with its own copy of the string, so editing one
  // leaves both green while the feed silently reports 0 locators. Pipe the real
  // snapshot output through the real summariser so the two stay tied.
  it('produces output the activity-feed summariser can still count', async () => {
    hoisted.client = makeDaemon({ hierarchyXml: SIGN_IN_XML, evaluate: signInAgent }).client;
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

  it('taps the match a .filter() chain narrows to, as a test would (PILOT-660, PILOT-848)', async () => {
    // PILOT-660 refused chains because the parser dropped them; built by the
    // SDK they narrow exactly as in a test, so the draft "Save" is tapped.
    const daemon = makeDaemon({
      elements: [
        makeElement({ elementId: 'el-1', text: 'Save' }),
        makeElement({ elementId: 'el-2', text: 'Save draft' }),
      ],
    });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Save").filter({ hasText: "draft" })' });
    expect(res.isError).toBeFalsy();
    expect(daemon.tap).toHaveBeenCalledTimes(1);
    expect(daemon.tap.mock.calls[0][2]).toBe('el-2');
  });

  it('refuses a string that is not a locator and taps nothing', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Save' })] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Save").tap()' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('.tap()');
    expect(daemon.findElements).not.toHaveBeenCalled();
    expect(daemon.tap).not.toHaveBeenCalled();
  });

  it('does not send an agent whose WebView connection failed to inspect the screen', async () => {
    hoisted.client = makeDaemon().client;
    vi.spyOn(Device.prototype, 'webview').mockRejectedValue(new Error('Timed out waiting for WebView (15000ms): no debuggable WebView'));
    const res = await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toContain('tapsmith_snapshot');
    vi.restoreAllMocks();
  });

  it('keeps a tap within the 5 s budget (only typing gets longer)', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Go' })] });
    hoisted.client = daemon.client;
    await callTool('tapsmith_tap', { locator: 'device.getByText("Go")' });
    expect(daemon.tap.mock.calls[0][1] as number).toBeLessThanOrEqual(5_000);
  });

  it('points an agent that missed its target at the inspection tools', async () => {
    const daemon = makeDaemon({ elements: [] });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_tap', { locator: 'device.getByText("Nope")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('tapsmith_snapshot');
  }, 15_000);

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

  it('gives the action itself a test\'s budget once its element is there', async () => {
    // Typing a long string on iOS outlasts 5 s; a wrong locator should not.
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Bio' })] });
    hoisted.client = daemon.client;
    await callTool('tapsmith_type', { locator: 'device.getByText("Bio")', text: 'x'.repeat(150) });
    const budget = daemon.typeText.mock.calls[0][2] as number;
    expect(budget).toBeGreaterThan(25_000);
  });

  it('clears and types in one step when asked', async () => {
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Email' })] });
    hoisted.client = daemon.client;
    await callTool('tapsmith_type', {
      locator: 'device.getByText("Email")',
      text: 'new',
      clear: true,
    });
    expect(daemon.calls).toEqual(['clearAndType']);
    expect(daemon.clearAndType.mock.calls[0][1]).toBe('new');
  });

  it('replaces a field found by its current text, resolving it once', async () => {
    // Clearing and then typing re-resolved the locator after the clear had
    // removed the very text it matched on, leaving the field empty.
    // The field keeps "old value" until something clears it.
    const field = makeElement({ elementId: 'el-1', text: 'old value' });
    const daemon = makeDaemon({ find: () => (daemon.calls.some((c) => c.startsWith('clear')) ? [] : [field]) });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_type', { locator: 'device.getByText("old value")', text: 'new', clear: true });
    expect(text(res)).toBe('OK');
    expect(daemon.clearAndType).toHaveBeenCalledTimes(1);
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
    expect(daemon.clearAndType.mock.calls[0][0]).toBeUndefined();
    expect(daemon.clearAndType.mock.calls[0][4]).toBe('el-2');
  });

  it('reports a clear-and-type that failed, and types nothing separately', async () => {
    // Typing after a failed clear appends to the old value, and "OK" hid it:
    // the agent believed the field held exactly the new text (PILOT-267).
    const daemon = makeDaemon({ elements: [makeElement({ text: 'Email' })] });
    daemon.clearAndType.mockResolvedValueOnce({
      requestId: '1', success: false, errorType: 'ACTION_FAILED', errorMessage: 'field is read-only',
    });
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_type', {
      locator: 'device.getByText("Email")',
      text: 'new',
      clear: true,
    });
    expect(res.isError).toBe(true);
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

// ─── The SDK Device behind the tools (PILOT-848) ───

describe('sdkDeviceFor', () => {
  const daemonListing = (platforms: string[]) => ({
    listDevices: vi.fn(async () => ({
      requestId: '1', unusable: [],
      devices: platforms.map((platform, i) => ({ serial: `d${i}`, model: '', state: 'device', isEmulator: true, platform, osVersion: '' })),
    })),
  }) as unknown as TapsmithGrpcClient;
  const platformOf = (d: Device) => (d as unknown as { _platform: string })._platform;

  it('takes the platform of the resolved serial', async () => {
    expect(platformOf(await sdkDeviceFor(daemonListing(['android', 'ios']), 'd1'))).toBe('ios');
  });

  it('on iOS, connects WebViews through the serial even when it is not listed', async () => {
    const client = daemonListing(['ios', 'ios']);
    (client as unknown as { getCurrentPackage: () => Promise<unknown> }).getCurrentPackage = async () => ({ requestId: '1', packageName: 'com.example' });
    const device = await sdkDeviceFor(client, 'SIM-B');
    const page = { getByText: vi.fn(() => ({})), _setTimeoutMs: vi.fn() };
    const webview = vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page as unknown as WebViewHandle);
    try {
      await withEvaluatedLocator(device, client, 'webview.getByText("x")', async () => {});
      expect((webview.mock.contexts[0] as unknown as { _simulatorUdid?: string })._simulatorUdid).toBe('SIM-B');
    } finally {
      webview.mockRestore();
    }
  });

  it('without a serial, takes the platform every listed device shares', async () => {
    expect(platformOf(await sdkDeviceFor(daemonListing(['ios', 'ios']), undefined))).toBe('ios');
    expect(platformOf(await sdkDeviceFor(daemonListing(['android', 'ios']), undefined))).toBe('android');
  });

  it('never takes another device\'s identity for an unlisted serial, and keeps no guess', async () => {
    const client = daemonListing(['android', 'ios']);
    const first = await sdkDeviceFor(client, 'gone');
    expect(platformOf(first)).toBe('android');
    expect((first as unknown as { _simulatorUdid?: string })._simulatorUdid).toBeUndefined();
    expect(await sdkDeviceFor(client, 'gone')).not.toBe(first);
  });

  it('keeps no platform taken from other devices for an unlisted serial', async () => {
    const client = daemonListing(['ios', 'ios']);
    expect(await sdkDeviceFor(client, 'unlisted')).not.toBe(await sdkDeviceFor(client, 'unlisted'));
  });

  it('builds one Device per client and serial', async () => {
    const client = daemonListing(['android']);
    expect(await sdkDeviceFor(client, 'd0')).toBe(await sdkDeviceFor(client, 'd0'));
  });
});

// ─── WebView locators (PILOT-848) ───

describe('webview.* locators in the action tools', () => {
  // The page side is the SDK's WebView code; the seam is device.webview().
  afterEach(async () => {
    await closeMcpWebViews();
    vi.restoreAllMocks();
  });
  function fakePage(value = '') {
    const locator = { click: vi.fn(async () => {}), fill: vi.fn(async () => {}), inputValue: vi.fn(async () => value) };
    const page = { getByText: vi.fn(() => locator), getByPlaceholder: vi.fn(() => locator), _setTimeoutMs: vi.fn() };
    const webview = vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page as unknown as WebViewHandle);
    return { locator, page, webview };
  }

  it('clicks a webview locator in the page, connecting to the app in the foreground', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const { locator, page, webview } = fakePage();
    const res = await callTool('tapsmith_tap', { locator: 'webview.getByText("Submit", { exact: true })' });
    expect(text(res)).toBe('OK');
    expect(webview).toHaveBeenCalledWith('com.example');
    expect(page.getByText).toHaveBeenCalledWith('Submit', { exact: true });
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(daemon.tap).not.toHaveBeenCalled();
  });

  it('connects an iOS WebView through the listed simulator', async () => {
    const daemon = makeDaemon();
    daemon.listDevices = vi.fn(async () => ({ requestId: '1', unusable: [], devices: [{ serial: 'SIM-1', model: '', state: 'Booted', isEmulator: true, platform: 'ios', osVersion: '' }] }));
    hoisted.client = daemon.client;
    const { webview } = fakePage();
    await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    const connectingDevice = webview.mock.contexts[0] as unknown as { _platform: string; _simulatorUdid?: string };
    expect(connectingDevice._platform).toBe('ios');
    expect(connectingDevice._simulatorUdid).toBe('SIM-1');
  });

  it('keeps one WebView connection for a burst of calls, with its own connect budget', async () => {
    // Reconnecting costs ~10 s on iOS, so calls in a row share a connection.
    hoisted.client = makeDaemon().client;
    const { page, webview } = fakePage();
    const dispose = vi.spyOn(Device.prototype, '_disposeWebViewManager');
    await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    expect(webview.mock.contexts[1]).toBe(webview.mock.contexts[0]);
    expect(dispose).not.toHaveBeenCalled();
    expect((webview.mock.contexts[0] as unknown as { _defaultTimeoutMs: number })._defaultTimeoutMs).toBe(15_000);
    expect(page._setTimeoutMs).toHaveBeenCalledWith(5_000);
  });

  it('closes an idle WebView connection, but never under a call still using it', async () => {
    // An open session would wedge a test connecting to the same page (PILOT-288).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      hoisted.client = makeDaemon().client;
      fakePage();
      const dispose = vi.spyOn(Device.prototype, '_disposeWebViewManager');
      await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
      vi.advanceTimersByTime(WEBVIEW_IDLE_CLOSE_MS - 1);
      expect(dispose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connects again when another app is current', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const { webview } = fakePage();
    const dispose = vi.spyOn(Device.prototype, '_disposeWebViewManager');
    await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    daemon.getCurrentPackage = vi.fn(async () => ({ requestId: '1', packageName: 'com.other' }));
    await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(webview.mock.contexts[1]).not.toBe(webview.mock.contexts[0]);
    expect(webview).toHaveBeenLastCalledWith('com.other');
  });

  it('closes the device tools\' WebView before a test run starts', async () => {
    hoisted.client = makeDaemon().client;
    fakePage();
    const dispose = vi.spyOn(Device.prototype, '_disposeWebViewManager');
    await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    await closeMcpWebViews();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('types into a page field: appends without clear, replaces with it', async () => {
    hoisted.client = makeDaemon().client;
    const { locator } = fakePage('sam@');
    await callTool('tapsmith_type', { locator: 'webview.getByPlaceholder("Email")', text: 'example.com' });
    expect(locator.fill).toHaveBeenLastCalledWith('sam@example.com');
    await callTool('tapsmith_type', { locator: 'webview.getByPlaceholder("Email")', text: 'new', clear: true });
    expect(locator.fill).toHaveBeenLastCalledWith('new');
  });

  it('counts a webview locator in the page for tapsmith_test_locator', async () => {
    hoisted.client = makeDaemon().client;
    const { locator } = fakePage();
    (locator as unknown as { count: () => Promise<number> }).count = vi.fn(async () => 2);
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', { locator: 'webview.getByText("Submit")' })));
    expect(result).toMatchObject({ matched: true, count: 2 });
    expect(result.strictModeWarning).toBeDefined();
  });

  it.each(['android', 'ios'])('refuses to guess a WebView when the current app is unknown (%s)', async (platform) => {
    // Both platforms fall back to the first WebView found (Chrome, Safari).
    const daemon = makeDaemon();
    daemon.getCurrentPackage = vi.fn(async () => ({ requestId: '1', packageName: '' }));
    daemon.listDevices = vi.fn(async () => ({ requestId: '1', unusable: [], devices: [{ serial: 'd', model: '', state: 'device', isEmulator: true, platform, osVersion: '' }] }));
    hoisted.client = daemon.client;
    const webview = vi.spyOn(Device.prototype, 'webview');
    const res = await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('current');
    expect(webview).not.toHaveBeenCalled();
  });

  it('reports a page failure as an error, not OK', async () => {
    hoisted.client = makeDaemon().client;
    const { locator } = fakePage();
    locator.click.mockRejectedValueOnce(new Error('strict mode violation: webview.getByText("Go") resolved to 2 elements'));
    const res = await callTool('tapsmith_tap', { locator: 'webview.getByText("Go")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('strict mode violation');
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
    expect(text(res)).toContain('unsupported option "level" for .getByRole()');
    expect(daemon.findElements).not.toHaveBeenCalled();
  });

  it('resolves a chained call scoped to its parent, as a test would (PILOT-660, PILOT-848)', async () => {
    const list = makeElement({ elementId: 'list', role: 'list', bounds: { left: 0, top: 0, right: 400, bottom: 500 } });
    const inside = makeElement({ elementId: 'in', text: 'Row 2', bounds: { left: 0, top: 100, right: 400, bottom: 150 } });
    const outside = makeElement({ elementId: 'out', text: 'Row 2', bounds: { left: 0, top: 700, right: 400, bottom: 750 } });
    hoisted.client = makeDaemon({ find: (sel) => (sel.kind.type === 'role' ? [list] : [inside, outside]) }).client;
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', { locator: 'device.getByRole("list").getByText("Row 2")' })));
    expect(result).toMatchObject({ matched: true, count: 1, elements: [{ text: 'Row 2', bounds: '[0,100][400,150]' }] });
    expect(result.strictModeWarning).toBeUndefined();
  });

  it('re-reads a stale snapshot instead of reporting it, as count() does', async () => {
    let reads = 0;
    const row = makeElement({ elementId: 'r', text: 'Row' });
    const daemon = makeDaemon();
    daemon.findElements.mockImplementation(async () => (reads++ === 0
      ? { requestId: '1', elements: [], errorMessage: 'element is stale (UI changed) during the read' }
      : { requestId: '1', elements: [row], errorMessage: '' }));
    hoisted.client = daemon.client;
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', { locator: 'device.getByText("Row")' })));
    expect(result).toMatchObject({ matched: true, count: 1 });
  });

  it('applies .filter() as the SDK does', async () => {
    const milk = makeElement({ elementId: 'a', role: 'listitem', text: 'Milk 2L' });
    const bread = makeElement({ elementId: 'b', role: 'listitem', text: 'Bread' });
    hoisted.client = makeDaemon({ find: () => [milk, bread] }).client;
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', { locator: 'device.getByRole("listitem").filter({ hasText: "Milk" })' })));
    expect(result).toMatchObject({ matched: true, count: 1, elements: [{ text: 'Milk 2L' }] });
  });

  it('never runs a string that is not a locator', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const res = await callTool('tapsmith_test_locator', { locator: 'device.constructor.constructor("return process")()' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('constructor');
    expect(daemon.findElements).not.toHaveBeenCalled();
  });

  it('surfaces a daemon error instead of reporting no match', async () => {
    hoisted.client = makeDaemon({ findError: 'agent not responding' }).client;
    const res = await callTool('tapsmith_test_locator', { locator: 'device.getByText("Sign in")' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('agent not responding');
  });

  it('reads the matches once, without waiting for one to appear', async () => {
    const daemon = makeDaemon();
    hoisted.client = daemon.client;
    const started = Date.now();
    const result = JSON.parse(text(await callTool('tapsmith_test_locator', { locator: 'device.getByText("Not here yet")' })));
    expect(result).toMatchObject({ matched: false, count: 0 });
    expect(daemon.findElements).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
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
