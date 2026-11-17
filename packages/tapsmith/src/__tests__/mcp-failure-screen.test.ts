import { describe, it, expect, vi } from 'vitest';
import type { ElementInfo, EvaluateSelectorsResponse } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import {
  closestNodes,
  closestOnScreen,
  describeNode,
  failureScreenLines,
  heldFailureOf,
  locatorNeedles,
  similarity,
  type HeldFailure,
} from '../mcp/failure-screen.js';
import type { TraceSummary } from '../mcp/tools/trace-utils.js';
import type { TestRunResult } from '../mcp/test-dispatcher.js';

// PILOT-1241: after a run of one test that failed, the device is still on the
// screen where it failed; tapsmith_run_tests says so and lists what on that
// screen is closest to the locator that matched nothing.

const FILE = '/proj/e2e/login.test.ts';
const failure = { fullName: 'Login > signs in', filePath: FILE, error: 'boom', tracePath: '/t/trace.zip' };

function summary(over: Partial<TraceSummary> = {}): TraceSummary {
  return { steps: [], deviceLogs: [], endsOnFailedStep: true, multiDevice: false, ...over };
}

const miss = (r: TestRunResult, read: (p: string) => TraceSummary | undefined) => heldFailureOf(r, read, () => true);
const notMiss = (r: TestRunResult, read: (p: string) => TraceSummary | undefined) => heldFailureOf(r, read, () => false);

function run(over: Partial<TestRunResult> = {}): TestRunResult {
  return { status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 10, failures: [failure], ...over };
}

describe('heldFailureOf', () => {
  it('holds the one failure of a one-test run whose trace ends on the failed step', () => {
    expect(miss(run(), () => summary())).toEqual({ failure, confidence: 'confirmed' });
  });

  it('skipped tests beside it do not matter: they never touched the device', () => {
    expect(miss(run({ skipped: 4 }), () => summary())?.confidence).toBe('confirmed');
  });

  it('claims nothing when another test ran too (it may have moved the screen)', () => {
    expect(miss(run({ passed: 1 }), () => summary())).toBeUndefined();
    const two = run({ failed: 2, failures: [failure, { ...failure, fullName: 'Login > other' }] });
    expect(miss(two, () => summary())).toBeUndefined();
  });

  it('claims nothing when a step ran on the device after the failed one (an afterEach/afterAll hook)', () => {
    expect(miss(run(), () => summary({ endsOnFailedStep: false }))).toBeUndefined();
  });

  it('claims nothing for a device group: which device shows what is unclear', () => {
    expect(miss(run(), () => summary({ multiDevice: true }))).toBeUndefined();
  });

  it('claims nothing for a stopped run', () => {
    expect(miss(run({ status: 'stopped' }), () => summary())).toBeUndefined();
  });

  it('without a trace to read, holds only a locator miss, unchecked', () => {
    const noTrace = { ...failure, tracePath: undefined };
    expect(miss(run({ failures: [noTrace] }), () => summary())).toEqual({ failure: noTrace, confidence: 'unchecked' });
    expect(miss(run(), () => undefined)?.confidence).toBe('unchecked');
    // Any other failure may never have reached the device (a file that did not load).
    expect(notMiss(run({ failures: [noTrace] }), () => summary())).toBeUndefined();
  });

  it('claims nothing when the failure count and the failure list disagree', () => {
    expect(miss(run({ failures: [] }), () => summary())).toBeUndefined();
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
    const result = await closestOnScreen(device(), 'getByText("Sign Inn", { exact: true })');
    expect(result.kind).toBe('matches');
    if (result.kind !== 'matches') return;
    expect(result.elements[0]).toEqual({ description: 'heading "Sign In"', locator: 'device.getByRole("heading", { name: "Sign In" })' });
    // The agent found no locator for the button alone here: listed without one.
    expect(result.elements[1]).toEqual({ description: 'button "Sign in"', locator: undefined });
  });

  it('does not read the screen for a locator with no words', async () => {
    const d = device();
    expect(await closestOnScreen(d, 'getByRole("button")')).toEqual({ kind: 'no-words' });
    expect(d.getUiHierarchy).not.toHaveBeenCalled();
  });

  it('reports a screen it cannot read', async () => {
    expect(await closestOnScreen(device({ hierarchyError: 'agent gone' }), 'getByText("x")')).toEqual({ kind: 'error', message: 'agent gone' });
  });
});

describe('failureScreenLines', () => {
  const held: HeldFailure = { failure, confidence: 'confirmed' };

  it('says the device is held, lists the closest elements and the next step', async () => {
    const lines = (await failureScreenLines({ held, missedLocator: 'getByText("Sign Inn", { exact: true })', client: async () => device() })).join('\n');
    expect(lines).toContain('DEVICE HELD: the device is still on the screen where "Login > signs in" failed');
    expect(lines).toContain('The next tapsmith_run_tests resets the app as usual.');
    expect(lines).toContain('Closest on screen to getByText("Sign Inn", { exact: true }):\n  - heading "Sign In": device.getByRole("heading", { name: "Sign In" })');
    expect(lines).toContain('  - button "Sign in" (no locator finds it alone; tapsmith_snapshot lists it)');
    expect(lines).toContain('NEXT STEP: the locator matched nothing on this screen. Check a replacement with tapsmith_test_locator');
  });

  it('hedges when there was no trace to check', async () => {
    const lines = (await failureScreenLines({ held: { failure, confidence: 'unchecked' }, client: async () => device() })).join('\n');
    expect(lines).toContain('the device was left where "Login > signs in" failed');
    expect(lines).toContain('afterEach or afterAll hook');
  });

  it('only says the device is held for a failure that is not a locator miss', async () => {
    const client = vi.fn(async () => device());
    const lines = await failureScreenLines({ held, client });
    expect(lines).toHaveLength(2);
    expect(client).not.toHaveBeenCalled();
  });

  it('says when nothing on screen is close', async () => {
    const lines = (await failureScreenLines({ held, missedLocator: 'getByText("Checkout")', client: async () => device() })).join('\n');
    expect(lines).toContain('Nothing on screen is close to getByText("Checkout"): tapsmith_snapshot shows what is there.');
  });

  it('keeps the held line when the device cannot be found, and never throws', async () => {
    const lines = (await failureScreenLines({
      held, missedLocator: 'getByText("Sign Inn")', client: async () => { throw new Error('ambiguous device'); },
    })).join('\n');
    expect(lines).toContain('DEVICE HELD');
    expect(lines).toContain('(Could not read the screen for the elements closest to getByText("Sign Inn"): ambiguous device)');
  });

  it('lists no elements for a locator with no words, but still gives the next step', async () => {
    const lines = (await failureScreenLines({ held, missedLocator: 'getByRole("button")', client: async () => device() })).join('\n');
    expect(lines).not.toContain('Closest on screen');
    expect(lines).toContain('NEXT STEP');
  });
});
