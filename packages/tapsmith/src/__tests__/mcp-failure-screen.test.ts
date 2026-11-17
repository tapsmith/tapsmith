import { describe, it, expect, vi } from 'vitest';
import type { ElementInfo, EvaluateSelectorsResponse } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import {
  closestNodes,
  closestOnScreen,
  describeNode,
  failureCandidateOf,
  failureScreenReport,
  locatorNeedles,
  sameScreen,
  similarity,
  type FailureCandidate,
} from '../mcp/failure-screen.js';
import type { TraceSummary } from '../mcp/tools/trace-utils.js';
import type { TestRunResult } from '../mcp/test-dispatcher.js';

// PILOT-1241: after a run of one test that failed, the device is normally
// still on the screen where it failed; tapsmith_run_tests checks that against
// the failure's trace, says so, and lists what on that screen is closest to
// the locator that matched nothing.

const FILE = '/proj/e2e/login.test.ts';
const failure = { fullName: 'Login > signs in', filePath: FILE, error: 'boom', tracePath: '/t/trace.zip' };
const FAILURE_XML = '<hierarchy><node class="android.widget.TextView" text="Sign In"/></hierarchy>';

function summary(over: Partial<TraceSummary> = {}): TraceSummary {
  return { steps: [], deviceLogs: [], failureHierarchyXml: FAILURE_XML, multiDevice: false, ...over };
}

function run(over: Partial<TestRunResult> = {}): TestRunResult {
  return { status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 10, failures: [failure], ...over };
}

describe('failureCandidateOf', () => {
  it('takes the one failure of a one-test run, with the screen its trace captured at the failed step', () => {
    expect(failureCandidateOf(run(), () => summary())).toEqual({ failure, failureHierarchyXml: FAILURE_XML });
    expect(failureCandidateOf(run(), () => summary({ failureHierarchyXml: undefined }))).toEqual({ failure, failureHierarchyXml: undefined });
  });

  it('skipped tests beside it do not matter here: the screen check catches one that moved the device', () => {
    expect(failureCandidateOf(run({ skipped: 4 }), () => summary())).toBeDefined();
  });

  it('takes nothing when another test ran too (which failure the screen shows is unclear)', () => {
    expect(failureCandidateOf(run({ passed: 1 }), () => summary())).toBeUndefined();
    const two = run({ failed: 2, failures: [failure, { ...failure, fullName: 'Login > other' }] });
    expect(failureCandidateOf(two, () => summary())).toBeUndefined();
  });

  it('takes nothing without a trace', () => {
    expect(failureCandidateOf(run({ failures: [{ ...failure, tracePath: undefined }] }), () => summary())).toBeUndefined();
    expect(failureCandidateOf(run(), () => undefined)).toBeUndefined();
  });

  it('takes nothing for a device group: which device shows what is unclear', () => {
    expect(failureCandidateOf(run(), () => summary({ multiDevice: true }))).toBeUndefined();
  });

  it('takes nothing for a stopped run, or when the failure count and the failure list disagree', () => {
    expect(failureCandidateOf(run({ status: 'stopped' }), () => summary())).toBeUndefined();
    expect(failureCandidateOf(run({ failures: [] }), () => summary())).toBeUndefined();
  });
});

const screenOf = (...texts: string[]) =>
  `<hierarchy><node class="android.widget.FrameLayout">${texts.map((t) => `<node class="android.widget.TextView" text="${t}"/>`).join('')}</node></hierarchy>`;

describe('sameScreen', () => {
  const login = ['Sign In', 'Email', 'Password', 'Sign in', 'Forgot password?'];

  it('is the same screen when it shows the same things', () => {
    expect(sameScreen(screenOf(...login), screenOf(...login))).toBe(true);
  });

  it('tolerates one thing changing on a screen of several (a clock, a typed field)', () => {
    expect(sameScreen(screenOf(...login), screenOf(...login.slice(0, 4), 'Forgot password'))).toBe(true);
  });

  it('is another screen when most of it differs', () => {
    expect(sameScreen(screenOf(...login), screenOf('Test Screens', 'Login Form', 'List', 'Toggles'))).toBe(false);
    expect(sameScreen(screenOf(...login), screenOf('Sign In', 'Email'))).toBe(false);
  });

  it('leaves out WebView DOM nodes, which a trace captured with a WebView active adds and a live read lacks', () => {
    const dom = login.map((t) => `<webview.p webview="true" text="${t} (web)"/>`).join('');
    const withDom = screenOf(...login).replace('</node></hierarchy>', `${dom}</node></hierarchy>`);
    expect(sameScreen(withDom, screenOf(...login))).toBe(true);
  });

  it('never judges a screen with nothing to compare the same', () => {
    expect(sameScreen('<hierarchy/>', '<hierarchy/>')).toBe(false);
    expect(sameScreen(screenOf(...login), '<hierarchy/>')).toBe(false);
  });
});

describe('locatorNeedles', () => {
  it('reads the words a locator looks for', () => {
    expect(locatorNeedles('getByText("Sign Inn", { exact: true })')).toEqual(['Sign Inn']);
    expect(locatorNeedles("getByDescription('Forgot password')")).toEqual(['Forgot password']);
  });

  it('leaves out a getByRole role name, keeping the accessible name', () => {
    expect(locatorNeedles('getByRole("button", { name: "Sign in" })')).toEqual(['Sign in']);
    expect(locatorNeedles('getByRole("button")')).toEqual([]);
  });

  it('reads every step of a chained locator, unescaping', () => {
    expect(locatorNeedles('getByRole("list").getByText("Milk \\"2%\\"")')).toEqual(['Milk "2%"']);
    expect(locatorNeedles('getByRole("listitem").filter({ hasText: "Milk" }).getByRole("button", { name: "Delete" })'))
      .toEqual(['Milk', 'Delete']);
  });

  it('has no words for a RegExp', () => {
    expect(locatorNeedles('getByText(/sign in/i)')).toEqual([]);
  });
});

describe('similarity', () => {
  it('is 1 for the same words in another case, and high for a typo', () => {
    expect(similarity('Sign In', 'sign in')).toBe(1);
    expect(similarity('Sign In', 'Sign Inn')).toBeGreaterThan(0.8);
  });

  it('is high when one contains the other', () => {
    expect(similarity('Sign in to continue', 'Sign in')).toBeGreaterThan(0.75);
  });

  it('is low for unrelated words, and 0 for an empty one', () => {
    expect(similarity('Settings', 'Sign In')).toBeLessThan(0.5);
    expect(similarity('', 'Sign In')).toBe(0);
  });
});

const ANDROID_SCREEN = `<?xml version="1.0"?><hierarchy>
<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
  <node class="android.widget.TextView" text="Sign In" tapsmith-role="heading" bounds="[63,273][1017,373]"/>
  <node class="android.widget.EditText" text="" hint="Email" clickable="true" bounds="[63,400][1017,500]"/>
  <node class="android.widget.Button" text="Sign in" clickable="true" bounds="[63,600][1017,700]"/>
  <node class="android.widget.TextView" text="Settings" bounds="[63,800][1017,900]"/>
  <node class="android.view.View" content-desc="Forgot password" clickable="true" bounds="[63,1000][1017,1100]"/>
</node></hierarchy>`;

describe('closestNodes', () => {
  const nodes = () => {
    const roots = parseHierarchyXml(ANDROID_SCREEN);
    const out: ReturnType<typeof parseHierarchyXml> = [];
    const walk = (n: (typeof out)[number]) => { if (n.attributes.get('bounds') !== '[0,0][1080,2400]') out.push(n); n.children.forEach(walk); };
    roots.forEach(walk);
    return out;
  };

  it('ranks the closest first and leaves out what is not close', () => {
    const found = closestNodes(nodes(), ['Sign Inn']).map(describeNode);
    expect(found).toEqual(['heading "Sign In"', 'button "Sign in"']);
  });

  it('matches a content description and a hint, not only text', () => {
    expect(closestNodes(nodes(), ['Forgot pasword']).map(describeNode)).toEqual(['android.view.View "Forgot password"']);
    expect(closestNodes(nodes(), ['E-mail']).map(describeNode)).toEqual(['textfield "Email"']);
  });

  it('lists at most the limit, and nothing without words', () => {
    expect(closestNodes(nodes(), ['Sign'], 1)).toHaveLength(1);
    expect(closestNodes(nodes(), [])).toEqual([]);
  });
});

function el(bounds: string, text: string): ElementInfo {
  const [l, t, r, b] = bounds.match(/\d+/g)!.map(Number);
  return { elementId: '', className: 'android.widget.TextView', text, bounds: { left: l, top: t, right: r, bottom: b } } as ElementInfo;
}

/** A fake device: the screen above, and an agent that finds "Sign In" text by its exact words. */
function device(over: { hierarchyError?: string } = {}) {
  const evaluateSelectors = vi.fn(async (selectors: Selector[]): Promise<EvaluateSelectorsResponse> => ({
    requestId: 'r',
    errorMessage: '',
    results: selectors.map((s) => {
      const words = s.kind.type === 'role' ? s.kind.value.name : 'value' in s.kind ? s.kind.value : undefined;
      if (words === 'Sign In') return { elements: [el('[63,273][1017,373]', 'Sign In')], errorMessage: '' };
      return { elements: [], errorMessage: '' };
    }),
  }));
  const getUiHierarchy = vi.fn(async () => ({ requestId: 'r', hierarchyXml: over.hierarchyError ? '' : ANDROID_SCREEN, errorMessage: over.hierarchyError ?? '' }));
  return { evaluateSelectors, getUiHierarchy };
}

describe('closestOnScreen', () => {
  it('lists the closest elements with a locator the agent resolved to each alone', async () => {
    const result = await closestOnScreen(device(), ANDROID_SCREEN, 'getByText("Sign Inn", { exact: true })');
    expect(result.kind).toBe('matches');
    if (result.kind !== 'matches') return;
    expect(result.elements[0]).toEqual({ description: 'heading "Sign In"', locator: 'device.getByRole("heading", { name: "Sign In" })' });
    // The agent found no locator for the button alone here: listed without one.
    expect(result.elements[1]).toEqual({ description: 'button "Sign in"', locator: undefined });
  });

  it('lists an element reported twice (inside a same-label container, as iOS reports some) once', async () => {
    const NESTED = `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][400,800]">
      <node class="android.view.ViewGroup" text="Sign In" tapsmith-role="heading" bounds="[24,140][378,173]">
        <node class="android.widget.TextView" text="Sign In" tapsmith-role="heading" bounds="[24,140][378,173]"/>
      </node>
      <node class="android.widget.Button" text="Sign in" clickable="true" bounds="[24,400][378,444]"/>
    </node></hierarchy>`;
    const evaluateSelectors = vi.fn(async (selectors: Selector[]): Promise<EvaluateSelectorsResponse> => ({
      requestId: 'r', errorMessage: '',
      results: selectors.map((s) => {
        const words = s.kind.type === 'role' ? s.kind.value.name : 'value' in s.kind ? s.kind.value : undefined;
        if (s.kind.type === 'role' && s.kind.value.role === 'heading' && words === 'Sign In') {
          return { elements: [{ elementId: '', className: 'android.widget.TextView', text: 'Sign In', bounds: { left: 24, top: 140, right: 378, bottom: 173 } } as ElementInfo], errorMessage: '' };
        }
        if (s.kind.type === 'role' && s.kind.value.role === 'button' && words === 'Sign in') {
          return { elements: [{ elementId: '', className: 'android.widget.Button', text: 'Sign in', bounds: { left: 24, top: 400, right: 378, bottom: 444 } } as ElementInfo], errorMessage: '' };
        }
        return { elements: [], errorMessage: '' };
      }),
    }));
    const result = await closestOnScreen({ evaluateSelectors }, NESTED, 'getByText("Sign Inn")');
    if (result.kind !== 'matches') throw new Error(result.kind);
    expect(result.elements.map((e) => e.locator)).toEqual([
      'device.getByRole("heading", { name: "Sign In" })',
      'device.getByRole("button", { name: "Sign in" })',
    ]);
  });

  it('asks the agent nothing for a locator with no words', async () => {
    const d = device();
    expect(await closestOnScreen(d, ANDROID_SCREEN, 'getByRole("button")')).toEqual({ kind: 'no-words' });
    expect(d.evaluateSelectors).not.toHaveBeenCalled();
  });
});

describe('failureScreenReport', () => {
  const candidate: FailureCandidate = { failure, failureHierarchyXml: ANDROID_SCREEN };
  const text = (r: { lines: string[] }) => r.lines.join('\n');

  it('says the device is held, lists the closest elements and the next step', async () => {
    const report = await failureScreenReport({ candidate, missedLocator: 'getByText("Sign Inn", { exact: true })', client: async () => device() });
    const t = text(report);
    expect(report.hasNextStep).toBe(true);
    expect(t).toContain('DEVICE HELD: the device is still on the screen where "Login > signs in" failed');
    expect(t).toContain('The next tapsmith_run_tests resets the app as usual.');
    expect(t).toContain('Closest on screen to getByText("Sign Inn", { exact: true }):\n  - heading "Sign In": device.getByRole("heading", { name: "Sign In" })');
    expect(t).toContain('  - button "Sign in" (no checked locator; tapsmith_snapshot lists it)');
    expect(t).not.toContain('stopped checking');
    expect(t).toContain('NEXT STEP: the locator matched nothing on this screen. Check a replacement with tapsmith_test_locator');
  });

  it('claims nothing when the screen differs from the failure\'s, but still lists what is closest on the device\'s screen', async () => {
    // A step is captured when it starts: the app may have moved on while it
    // waited, a hook may have moved it, or this is another device. Only the
    // device's screen matching the capture counts as held.
    const moved = { ...candidate, failureHierarchyXml: screenOf('Test Screens', 'Login Form', 'List', 'Toggles') };
    const report = await failureScreenReport({ candidate: moved, missedLocator: 'getByText("Sign Inn")', client: async () => device() });
    const t = text(report);
    expect(t).not.toContain('DEVICE HELD');
    expect(t).toContain('The device\'s screen differs from the one the failure\'s trace captured when the step where "Login > signs in" failed started.');
    expect(t).toContain('Check with tapsmith_snapshot what the device shows now');
    expect(t).toContain('Closest on the device\'s screen now to getByText("Sign Inn"):\n  - heading "Sign In"');
    expect(t).toContain('NEXT STEP: the locator matched nothing. Once tapsmith_snapshot shows the screen the test failed on');
    expect(report.hasNextStep).toBe(true);
  });

  it('claims nothing when the trace has no screen at the failed step', async () => {
    const report = await failureScreenReport({ candidate: { failure }, client: async () => device() });
    expect(text(report)).not.toContain('DEVICE HELD');
    expect(text(report)).toContain('could not be checked against it');
    expect(report.hasNextStep).toBe(false);
  });

  it('only says the device is held for a failure that is not a locator miss', async () => {
    const d = device();
    const report = await failureScreenReport({ candidate, client: async () => d });
    expect(report.lines).toHaveLength(2);
    expect(report.hasNextStep).toBe(false);
    expect(d.evaluateSelectors).not.toHaveBeenCalled();
  });

  it('says when nothing on screen is close', async () => {
    const report = await failureScreenReport({ candidate, missedLocator: 'getByText("Checkout")', client: async () => device() });
    expect(text(report)).toContain('Nothing on screen is close to getByText("Checkout"): tapsmith_snapshot shows what is there.');
  });

  it('says nothing when the device cannot be found, read, or shows nothing, and never throws', async () => {
    const lost = await failureScreenReport({ candidate, missedLocator: 'getByText("Sign Inn")', client: async () => { throw new Error('ambiguous device'); } });
    expect(lost).toEqual({ lines: [], hasNextStep: false });
    const unreadable = await failureScreenReport({ candidate, missedLocator: 'getByText("Sign Inn")', client: async () => device({ hierarchyError: 'agent gone' }) });
    expect(unreadable).toEqual({ lines: [], hasNextStep: false });
    // A screen with nothing on it (an app still launching) is not one to judge.
    const d = device();
    d.getUiHierarchy.mockResolvedValue({ requestId: 'r', hierarchyXml: '<hierarchy/>', errorMessage: '' });
    expect(await failureScreenReport({ candidate, missedLocator: 'getByText("Sign Inn")', client: async () => d })).toEqual({ lines: [], hasNextStep: false });
  });

  it('says when the device agent stopped checking the closest elements\' locators', async () => {
    const d = device();
    d.evaluateSelectors.mockRejectedValue(new Error('agent gone'));
    const t = text(await failureScreenReport({ candidate, missedLocator: 'getByText("Sign Inn")', client: async () => d }));
    expect(t).toContain('DEVICE HELD');
    expect(t).toContain('Closest on screen to getByText("Sign Inn"):\n  - heading "Sign In" (no checked locator; tapsmith_snapshot lists it)');
    expect(t).toContain('(The device agent stopped checking locators for these: agent gone)');
  });

  it('lists no elements for a locator with no words, but still gives the next step', async () => {
    const report = await failureScreenReport({ candidate, missedLocator: 'getByRole("button")', client: async () => device() });
    expect(text(report)).not.toContain('Closest on screen');
    expect(report.hasNextStep).toBe(true);
  });
});
