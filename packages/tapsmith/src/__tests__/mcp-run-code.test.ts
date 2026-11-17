import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Selector } from '../selectors.js';
import type { ElementInfo, TapsmithGrpcClient } from '../grpc-client.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';
import { beginTestRun, closeMcpWebViews, endTestRun } from '../mcp/sdk-device.js';
import { Device } from '../device.js';
import type { WebViewHandle } from '../webview-handle.js';
import { summarizeResult } from '../mcp/events.js';
import { formatToolArgs } from '../ui-mode/components/tool-args.js';

// PILOT-1240: tapsmith_run_code runs test statements on the device through
// the real MCP server and the SDK's own objects. Only the daemon is faked
// (mcp-device-tools.test.ts has the same seam), so what a statement does is
// what the SDK does with the agent's answers.

const hoisted = vi.hoisted(() => ({ client: null as unknown as TapsmithGrpcClient }));

vi.mock('../mcp/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/connection.js')>()),
  resolveDeviceTarget: async (request?: { device?: string }) => ({ client: hoisted.client, device: request?.device }),
  listAllDevices: async () => ({ devices: [], unusable: [] }),
  getSessionDeviceSerials: () => null,
}));

const { createMcpServer } = await import('../mcp/index.js');

// ─── Fakes ───

function makeElement(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1', className: 'XCUIElementTypeButton', text: '', contentDescription: '', resourceId: '',
    enabled: true, visible: true, clickable: true, focusable: false, scrollable: false, hint: '',
    checked: false, selected: false, focused: false, role: '', viewportRatio: 1.0,
    ...overrides,
  };
}

function ok() {
  return { requestId: '1', success: true, errorType: '', errorMessage: '' };
}

/** Buttons on an iOS screen, as the agent dumps them, and the agent's matching for them. */
function buttonsScreen(labels: string[]) {
  const elements = labels.map((label, i) => makeElement({
    elementId: `b${i}`, role: 'button', text: label,
    bounds: { left: 0, top: 100 * i, right: 390, bottom: 100 * i + 80 },
  }));
  const rows = elements.map((e) => `<XCUIElementTypeButton type="XCUIElementTypeButton" label="${e.text}" clickable="true" bounds="[${e.bounds!.left},${e.bounds!.top}][${e.bounds!.right},${e.bounds!.bottom}]" />`).join('\n');
  const xml = `<hierarchy><XCUIElementTypeApplication type="XCUIElementTypeApplication">\n${rows}\n</XCUIElementTypeApplication></hierarchy>`;
  const agent = (sel: Selector): ElementInfo[] => {
    const k = sel.kind;
    if (k.type === 'role') {
      if (k.value.role !== 'button') return [];
      const name = k.value.name;
      return elements.filter((e) => name === undefined || (typeof name === 'string' && (k.value.exact ? e.text === name : e.text.toLowerCase().includes(name.toLowerCase()))));
    }
    if (k.type === 'textContains') return elements.filter((e) => e.text.toLowerCase().includes(k.value.toLowerCase()));
    if (k.type === 'text') return elements.filter((e) => e.text === k.value);
    return [];
  };
  return { xml, elements, agent };
}

function makeDaemon(screen: { xml: string; agent: (sel: Selector) => ElementInfo[] } = buttonsScreen(['Sign in', 'Register'])) {
  const calls: string[] = [];
  const action = (name: string) => vi.fn(async (..._args: unknown[]) => {
    calls.push(name);
    return ok();
  });
  const daemon = {
    calls,
    findElements: vi.fn(async (selector: Selector) => ({ requestId: '1', elements: screen.agent(selector), errorMessage: '' })),
    evaluateSelectors: vi.fn(async (selectors: Selector[]) => ({
      requestId: '1', errorMessage: '', results: selectors.map((s) => ({ elements: screen.agent(s), errorMessage: '' })),
    })),
    getUiHierarchy: vi.fn(async () => ({ requestId: '1', hierarchyXml: screen.xml, errorMessage: '' })),
    listDevices: vi.fn(async () => ({ requestId: '1', devices: [{ serial: 'SIM-1', platform: 'ios' }], unusable: [] })),
    getCurrentPackage: vi.fn(async () => ({ requestId: '1', packageName: 'com.example' })),
    tap: action('tap'),
    longPress: action('longPress'),
    doubleTap: action('doubleTap'),
    typeText: action('typeText'),
    swipe: action('swipe'),
    pressKey: action('pressKey'),
    tapXY: action('tapXY'),
    openDeepLink: action('openDeepLink'),
  };
  return { ...daemon, client: daemon as unknown as TapsmithGrpcClient };
}

function makeDispatcher(): TestDispatcher {
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
    classifyUnmatchedFile: () => undefined,
    refreshTestFiles: async () => {},
    toggleWatch: () => ({ enabled: true }),
  };
}

async function runCode(code: string, extra: Record<string, unknown> = {}): Promise<CallToolResult> {
  const server = createMcpServer({ dispatcher: makeDispatcher() });
  const client = new Client({ name: 'run-code-probe', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    return await client.callTool({ name: 'tapsmith_run_code', arguments: { code, ...extra } }) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function text(res: CallToolResult): string {
  return res.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
}

let daemon: ReturnType<typeof makeDaemon>;
beforeEach(() => {
  daemon = makeDaemon();
  hoisted.client = daemon.client;
});

// ─── Tests ───

describe('tapsmith_run_code', () => {
  it('is listed with its arguments', async () => {
    const server = createMcpServer({ dispatcher: makeDispatcher() });
    const client = new Client({ name: 'list', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    const tool = tools.find((t) => t.name === 'tapsmith_run_code');
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['code', 'device', 'project', 'timeout']);
    expect(tool?.inputSchema.required).toEqual(['code']);
  });

  it('answers a passing assertion with its test line', async () => {
    const res = await runCode('await expect(device.getByRole("button", { name: "Sign in" })).toBeVisible();');
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe(
      'Statement 1 of 1 (line 1): OK\nTest line: await expect(device.getByRole("button", { name: "Sign in" })).toBeVisible();',
    );
  });

  it('answers a failing assertion with the error a test gets, within the timeout', async () => {
    const started = Date.now();
    const res = await runCode('await expect(device.getByText("Welcome back")).toBeVisible();', { timeout: 300 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Statement 1 of 1 \(line 1\) failed: Expected element getByText\("Welcome back"\) to be visible, but it was not\./);
    expect(text(res)).not.toContain('Test line');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('runs statements in order and stops at the first failure, saying which did not run', async () => {
    const res = await runCode([
      'await device.getByRole("button", { name: "Sign in" }).tap();',
      'await device.getByText("Nowhere").tap();',
      'await device.swipe("up");',
      'await device.pressKey("back");',
    ].join('\n'), { timeout: 200 });
    expect(res.isError).toBe(true);
    const out = text(res);
    expect(out).toMatch(/^Statement 1 of 4 \(line 1\): OK\nTest line: await device\.getByRole\("button", \{ name: "Sign in" \}\)\.tap\(\);\n/);
    expect(out).toMatch(/Statement 2 of 4 \(line 2\) failed: /);
    // A miss points the agent at its own tools, with the locator to check.
    expect(out).toContain('tapsmith_test_locator');
    expect(out).toMatch(/Not run: statements 3–4 \(lines 3–4\)\.$/);
    expect(daemon.calls).toEqual(['tap']);
  });

  it('runs nothing when any statement is refused, and says where', async () => {
    const res = await runCode('await device.getByText("Sign in").tap();\nconst x = device.getByText("Register");');
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Invalid statement at line 2, column 1 .*variables are not supported.*Nothing was run\.$/s);
    expect(daemon.calls).toEqual([]);
    expect(daemon.findElements).not.toHaveBeenCalled();
    expect(daemon.listDevices).not.toHaveBeenCalled();
  });

  it('is refused while a test run holds the device', async () => {
    beginTestRun();
    try {
      const res = await runCode('await device.swipe("up");');
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/A test run is in progress.*Nothing was run\./s);
      expect(daemon.calls).toEqual([]);
    } finally {
      endTestRun();
    }
  });

  it('stops before the next statement when a test run starts meanwhile', async () => {
    daemon.swipe.mockImplementation(async () => {
      daemon.calls.push('swipe');
      beginTestRun();
      return ok();
    });
    try {
      const res = await runCode('await device.swipe("up");\nawait device.pressKey("back");');
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/^Statement 1 of 2 \(line 1\): OK\nTest line: await device\.swipe\("up"\);\nStatement 2 of 2 \(line 2\) was not run: A test run is in progress/);
      expect(daemon.calls).toEqual(['swipe']);
    } finally {
      endTestRun();
    }
  });

  it('runs device calls and answers with them as a test writes them', async () => {
    const res = await runCode('await page.openDeepLink("myapp://settings"); await this.device.tapXY(10, 20)');
    expect(text(res)).toBe([
      'Statement 1 of 2 (line 1): OK',
      'Test line: await device.openDeepLink("myapp://settings");',
      'Statement 2 of 2 (line 1): OK',
      'Test line: await device.tapXY(10, 20);',
    ].join('\n'));
    expect(daemon.openDeepLink).toHaveBeenCalledWith('myapp://settings', undefined);
    expect(daemon.tapXY).toHaveBeenCalledWith(10, 20);
  });

  it('checks a positional long press with the device agent and writes the locator that matches it alone', async () => {
    const screen = buttonsScreen(['Apple', 'Banana', 'Cherry']);
    daemon = makeDaemon(screen);
    hoisted.client = daemon.client;
    const res = await runCode('await device.getByRole("button").nth(1).longPress(800);');
    expect(text(res)).toBe(
      'Statement 1 of 1 (line 1): OK\nTest line: await device.getByRole("button", { name: "Banana" }).longPress(800);\n'
      + '(device.getByRole("button").nth(1) picks its element by position; the device agent matched this locator '
      + 'to that same element alone, so the line uses it instead.)',
    );
    // Checked before the press, which went to the element the position picked.
    expect(daemon.evaluateSelectors.mock.invocationCallOrder[0]).toBeLessThan(daemon.longPress.mock.invocationCallOrder[0]);
    expect((daemon.longPress.mock.calls[0] as unknown[])[3]).toBe('b1');
  });

  it('reports a positional setChecked line unverified when its stale retry picks another element', async () => {
    const screen = buttonsScreen(['Apple', 'Banana', 'Cherry']);
    let elements = screen.elements;
    const agent = (sel: Selector): ElementInfo[] => {
      const k = sel.kind;
      if (k.type === 'role' && k.value.role === 'button') {
        const name = k.value.name;
        return elements.filter((e) => name === undefined || (typeof name === 'string' && e.text.toLowerCase().includes(name.toLowerCase())));
      }
      return [];
    };
    daemon = makeDaemon({ ...screen, agent });
    hoisted.client = daemon.client;
    let taps = 0;
    daemon.tap.mockImplementation(async (_sel: unknown, _t: unknown, id: unknown) => {
      taps++;
      if (taps === 1) {
        // The first tap's cached id went stale, and the list shifted: a new
        // row on top moves every position down by one.
        elements = [makeElement({ elementId: 'new', role: 'button', text: 'Date', bounds: { left: 0, top: 0, right: 390, bottom: 40 } }), ...elements];
        return { requestId: '1', success: false, errorType: 'ACTION_FAILED', errorMessage: 'stale element reference' };
      }
      elements = elements.map((e) => (e.elementId === id ? { ...e, checked: true } : e));
      return ok();
    });
    const res = await runCode('await device.getByRole("button").nth(1).setChecked(true);');
    expect(taps).toBe(2);
    expect(text(res)).toMatch(/^Statement 1 of 1 \(line 1\): OK\nTest line: none, the locator could not be verified \(.*picked a different element/s);
  });

  it('checks a double tap\'s locator as it resolves: strict, no extra round trip', async () => {
    const res = await runCode('await device.getByText("Register").doubleTap();');
    expect(text(res)).toBe('Statement 1 of 1 (line 1): OK\nTest line: await device.getByText("Register").doubleTap();');
    expect(daemon.getUiHierarchy).not.toHaveBeenCalled();
    expect(daemon.evaluateSelectors).not.toHaveBeenCalled();
  });

  it('refuses a non-unique locator as a test does (strict mode), with no line', async () => {
    daemon = makeDaemon(buttonsScreen(['Buy', 'Buy']));
    hoisted.client = daemon.client;
    const res = await runCode('await device.getByText("Buy").tap();', { timeout: 200 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/strict mode violation/);
    expect(daemon.calls).toEqual([]);
  });

  it('flags a positional assertion as position-dependent', async () => {
    daemon = makeDaemon(buttonsScreen(['Buy', 'Buy']));
    hoisted.client = daemon.client;
    const res = await runCode('await expect(device.getByText("Buy").first()).toBeVisible();');
    expect(text(res)).toMatch(
      /^Statement 1 of 1 \(line 1\): OK\nTest line \(position-dependent\): await expect\(device\.getByText\("Buy"\)\.first\(\)\)\.toBeVisible\(\); \/\/ position-dependent: not checked/,
    );
  });

  it('gives each statement the tool\'s timeout, and a statement\'s own { timeout } wins', async () => {
    let started = Date.now();
    await runCode('await expect(device.getByText("Nowhere")).toBeVisible();', { timeout: 300 });
    expect(Date.now() - started).toBeLessThan(4_000);
    started = Date.now();
    const res = await runCode('await expect(device.getByText("Nowhere")).toBeVisible({ timeout: 200 });', { timeout: 60_000 });
    expect(res.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('reports an SDK refusal of a value as that statement failing', async () => {
    const res = await runCode('await device.getByRole("dialogue").tap();');
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Statement 1 of 1 \(line 1\) failed: .*Unknown role "dialogue"/s);
  });

  describe('webview.* statements', () => {
    afterEach(async () => {
      await closeMcpWebViews();
      vi.restoreAllMocks();
    });

    it('acts in the page and asserts there, with the WebView declaration the lines need', async () => {
      const locator = { click: vi.fn(async () => {}), fill: vi.fn(async () => {}), _nthIndex: undefined };
      const page = { getByText: vi.fn(() => locator), locator: vi.fn(() => locator), _setTimeoutMs: vi.fn() };
      const connect = vi.spyOn(Device.prototype, '_webviewOfApp').mockResolvedValue(page as unknown as WebViewHandle);
      const res = await runCode('await webview.locator("#email").fill("a@b.c");\nawait this.webview.getByText("Go").click();');
      // The page's waits get the default 5 s, as the other tools' do.
      expect(page._setTimeoutMs).toHaveBeenLastCalledWith(5_000);
      expect(text(res)).toBe([
        'Statement 1 of 2 (line 1): OK',
        'Test line: await webview.locator("#email").fill("a@b.c");',
        'Statement 2 of 2 (line 2): OK',
        'Test line: await webview.getByText("Go").click();',
        '(Declare `const webview = await device.webview();` before this line in the test.)',
      ].join('\n'));
      expect(connect).toHaveBeenCalledWith('com.example');
      expect(locator.fill).toHaveBeenCalledWith('a@b.c');
      expect(locator.click).toHaveBeenCalledTimes(1);
      expect(daemon.calls).toEqual([]);
    });

    it('gives the page\'s waits the tool\'s timeout', async () => {
      const locator = { click: vi.fn(async () => {}), _nthIndex: undefined };
      const page = { getByText: vi.fn(() => locator), _setTimeoutMs: vi.fn() };
      vi.spyOn(Device.prototype, '_webviewOfApp').mockResolvedValue(page as unknown as WebViewHandle);
      await runCode('await expect(webview.getByText("Loaded")).toBeVisible();', { timeout: 20_000 }).catch(() => {});
      expect(page._setTimeoutMs).toHaveBeenCalledWith(20_000);
    });

    it('is refused, before connecting, while a test run holds the device', async () => {
      const connect = vi.spyOn(Device.prototype, '_webviewOfApp');
      beginTestRun();
      try {
        const res = await runCode('await webview.getByText("Go").click();');
        expect(res.isError).toBe(true);
        expect(connect).not.toHaveBeenCalled();
      } finally {
        endTestRun();
      }
    });
  });

  it('is summarised in the activity feed by how many statements passed', () => {
    expect(summarizeResult('tapsmith_run_code', 'Statement 1 of 2 (line 1): OK\nTest line: x\nStatement 2 of 2 (line 2) failed: boom')).toBe('1/2 passed');
    expect(summarizeResult('tapsmith_run_code', 'Invalid statement at line 1, column 1: nope')).toBe('Invalid statement at line 1, column 1: nope');
    expect(formatToolArgs('tapsmith_run_code', { code: 'await device.swipe("up");\n\nawait device.pressKey("back");' }))
      .toBe('await device.swipe("up"); (+1 more lines)');
    expect(formatToolArgs('tapsmith_run_code', { code: 'await device.swipe("up");' })).toBe('await device.swipe("up");');
  });
});
