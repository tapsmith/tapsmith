import { describe, it, expect, vi } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import type { ElementInfo, EvaluateSelectorsResponse } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import { agentValidatedSuggestions } from '../mcp/agent-suggestions.js';

// PILOT-848: a suggestion is offered only when the AGENT resolves it to the
// node it is attached to. The fake agent below answers each selector from a
// rule, the way the real one would from the screen.

type Bounds = { left: number; top: number; right: number; bottom: number };
const B = (left: number, top: number, right: number, bottom: number): Bounds => ({ left, top, right, bottom });
const fmt = (b: Bounds) => `[${b.left},${b.top}][${b.right},${b.bottom}]`;

function node(className: string, text: string, bounds: Bounds): HierarchyNode {
  return {
    tagName: 'node',
    attributes: new Map([['class', className], ['text', text], ['clickable', 'true'], ['bounds', fmt(bounds)]]),
    children: [],
    depth: 0,
  };
}

function el(bounds: Bounds, text = '', className = 'android.widget.Button'): ElementInfo {
  return { elementId: '', className, text, bounds } as ElementInfo;
}

type Rule = (sel: Selector) => ElementInfo[] | Error;

function agent(rule: Rule) {
  const evaluateSelectors = vi.fn(async (selectors: Selector[]): Promise<EvaluateSelectorsResponse> => ({
    requestId: 'r',
    errorMessage: '',
    results: selectors.map((s) => {
      const r = rule(s);
      return r instanceof Error ? { elements: [], errorMessage: r.message } : { elements: r, errorMessage: '' };
    }),
  }));
  return { evaluateSelectors };
}

const isRole = (s: Selector, name: string, exact = false) =>
  s.kind.type === 'role' && s.kind.value.name === name && Boolean(s.kind.value.exact) === exact;
const isText = (s: Selector, value: string) =>
  (s.kind.type === 'text' || s.kind.type === 'textContains') && s.kind.value === value;

const saveBounds = B(0, 0, 100, 50);
const save = node('android.widget.Button', 'Save', saveBounds);

const codes = (byNode: Map<HierarchyNode, { code: string }[]>, n: HierarchyNode) => (byNode.get(n) ?? []).map((s) => s.code);

describe('agentValidatedSuggestions', () => {
  it('offers a candidate the agent resolves to exactly this node, best first', async () => {
    const a = agent((s) => (isRole(s, 'Save') || isText(s, 'Save') ? [el(saveBounds, 'Save')] : []));
    const { byNode, errorMessage } = await agentValidatedSuggestions(a, [save]);
    expect(errorMessage).toBeUndefined();
    expect(codes(byNode, save)).toEqual([
      'device.getByRole("button", { name: "Save" })',
      'device.getByText("Save")',
    ]);
  });

  it('drops a candidate the agent resolves to a different element', async () => {
    // e.g. Compose: the TS rules thought it was a switch, the agent finds it elsewhere (PILOT-833).
    const a = agent((s) => {
      if (isRole(s, 'Save')) return [el(B(0, 200, 100, 250), 'Save')];
      if (isText(s, 'Save')) return [el(saveBounds, 'Save')];
      return [];
    });
    const { byNode } = await agentValidatedSuggestions(a, [save]);
    expect(codes(byNode, save)).toEqual(['device.getByText("Save")']);
  });

  it('drops a candidate whose own entry failed', async () => {
    const a = agent((s) => {
      if (isRole(s, 'Save')) return new Error('Invalid selector');
      if (isText(s, 'Save')) return [el(saveBounds, 'Save')];
      return [];
    });
    const { byNode } = await agentValidatedSuggestions(a, [save]);
    expect(codes(byNode, save)).toEqual(['device.getByText("Save")']);
  });

  it('upgrades an ambiguous candidate to a variant the agent resolves uniquely', async () => {
    const other = el(B(0, 100, 100, 150), 'Save draft');
    const a = agent((s) => {
      if (isRole(s, 'Save', true)) return [el(saveBounds, 'Save')];
      if (isRole(s, 'Save')) return [el(saveBounds, 'Save'), other];
      if (s.kind.type === 'text' && s.kind.value === 'Save') return [el(saveBounds, 'Save')];
      if (isText(s, 'Save')) return [el(saveBounds, 'Save'), other];
      return [];
    });
    const { byNode } = await agentValidatedSuggestions(a, [save]);
    expect(codes(byNode, save)).toEqual([
      'device.getByRole("button", { name: "Save", exact: true })',
      'device.getByText("Save", { exact: true })',
    ]);
  });

  it('pins a still-ambiguous candidate by its position in the agent\'s match order', async () => {
    const before = el(B(0, 0, 100, 40), 'Save');
    const at = el(saveBounds, 'Save');
    const after = el(B(0, 300, 100, 340), 'Save');
    const a = agent((s) => (s.kind.type === 'className' ? [] : [before, at, after]));
    const nodeAt = node('android.widget.Button', 'Save', saveBounds);
    const { byNode } = await agentValidatedSuggestions(a, [nodeAt]);
    expect(codes(byNode, nodeAt)[0]).toBe('device.getByRole("button", { name: "Save" }).nth(1)');

    const last = agent((s) => (s.kind.type === 'className' ? [] : [before, after, at]));
    const { byNode: lastBy } = await agentValidatedSuggestions(last, [nodeAt]);
    expect(codes(lastBy, nodeAt)[0]).toBe('device.getByRole("button", { name: "Save" }).last()');
  });

  it('counts an element listed twice (iOS parent + inner child) once, as the runtime does', async () => {
    const a = agent((s) => (isRole(s, 'Save') ? [el(saveBounds, 'Save', 'XCUIElementTypeOther'), el(saveBounds, 'Save')] : []));
    const { byNode } = await agentValidatedSuggestions(a, [save]);
    expect(codes(byNode, save)[0]).toBe('device.getByRole("button", { name: "Save" })');
  });

  it('asks the agent once for an unambiguous screen, each distinct selector once', async () => {
    const other = node('android.widget.Button', 'Cancel', B(0, 100, 100, 150));
    const a = agent(() => []);
    await agentValidatedSuggestions(a, [save, other, save]);
    expect(a.evaluateSelectors).toHaveBeenCalledTimes(1);
    const sent = a.evaluateSelectors.mock.calls[0][0].map((s) => JSON.stringify(s));
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('does not call the agent when there is nothing to check', async () => {
    const a = agent(() => []);
    const { byNode } = await agentValidatedSuggestions(a, []);
    expect(byNode.size).toBe(0);
    expect(a.evaluateSelectors).not.toHaveBeenCalled();
  });

  it('reports a failed batch and offers nothing rather than guessing', async () => {
    const a = {
      evaluateSelectors: vi.fn(async () => ({ requestId: 'r', results: [], errorMessage: 'Unknown method: evaluateSelectors' })),
    };
    const { byNode, errorMessage } = await agentValidatedSuggestions(a, [save]);
    expect(errorMessage).toBe('Unknown method: evaluateSelectors');
    expect(codes(byNode, save)).toEqual([]);
  });

  it('reports a thrown RPC failure the same way', async () => {
    const a = { evaluateSelectors: vi.fn(async () => { throw new Error('14 UNAVAILABLE: connection refused'); }) };
    const { errorMessage } = await agentValidatedSuggestions(a, [save]);
    expect(errorMessage).toContain('UNAVAILABLE');
  });

  it('evaluates the pinning variants only for candidates the agent found ambiguous, in a second call', async () => {
    const other = el(B(0, 100, 100, 150), 'Save draft');
    const a = agent((s) => (isRole(s, 'Save') || isText(s, 'Save') ? [el(saveBounds, 'Save'), other] : []));
    const cancel = node('android.widget.Button', 'Cancel', B(0, 300, 100, 350));
    await agentValidatedSuggestions(a, [save, cancel]);
    expect(a.evaluateSelectors).toHaveBeenCalledTimes(2);
    const second = a.evaluateSelectors.mock.calls[1][0];
    expect(second.length).toBeGreaterThan(0);
    // Only Save's ladders were ambiguous; Cancel's variants are never sent.
    expect(second.every((s: Selector) => JSON.stringify(s).includes('Save'))).toBe(true);
  });

  it('checks a big screen in chunks, and keeps what was checked when a later chunk fails', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => node('android.widget.TextView', `Row ${i}`, B(0, i * 60, 100, i * 60 + 50)));
    let calls = 0;
    const a = {
      evaluateSelectors: vi.fn(async (selectors: Selector[]): Promise<EvaluateSelectorsResponse> => {
        calls++;
        expect(selectors.length).toBeLessThanOrEqual(40);
        if (calls > 1) return { requestId: 'r', results: [], errorMessage: 'Agent command timed out' };
        return {
          requestId: 'r',
          errorMessage: '',
          results: selectors.map((s) => {
            const row = rows.find((r) => JSON.stringify(s).includes(`"${r.attributes.get('text')}"`));
            return { elements: row ? [el(parseB(row), row.attributes.get('text')!, 'android.widget.TextView')] : [], errorMessage: '' };
          }),
        };
      }),
    };
    const { byNode, errorMessage, stoppedAt } = await agentValidatedSuggestions(a, rows);
    expect(a.evaluateSelectors.mock.calls.length).toBeGreaterThan(1);
    expect(errorMessage).toBe('Agent command timed out');
    expect(stoppedAt).toBe('candidates');
    // The best-ranked candidates went first, so rows still got suggestions.
    expect(byNode.size).toBeGreaterThan(0);
  });
});

function parseB(n: HierarchyNode): Bounds {
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(n.attributes.get('bounds')!)!;
  return B(+m[1], +m[2], +m[3], +m[4]);
}

describe('when checking stops', () => {
  it('says the variants stage stopped when only the pinning variants were not checked', async () => {
    const other = el(B(0, 100, 100, 150), 'Save draft');
    let calls = 0;
    const a = {
      evaluateSelectors: vi.fn(async (selectors: Selector[]): Promise<EvaluateSelectorsResponse> => {
        calls++;
        if (calls > 1) return { requestId: 'r', results: [], errorMessage: 'timed out' };
        return {
          requestId: 'r',
          errorMessage: '',
          results: selectors.map((s) => ({ elements: isRole(s, 'Save') || isText(s, 'Save') ? [el(saveBounds, 'Save'), other] : [], errorMessage: '' })),
        };
      }),
    };
    const { byNode, stoppedAt } = await agentValidatedSuggestions(a, [save]);
    expect(stoppedAt).toBe('variants');
    // Still offered, pinned by the agent's order.
    expect(codes(byNode, save)[0]).toBe('device.getByRole("button", { name: "Save" }).first()');
  });

  it('starts no new chunk once the budget is spent', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => node('android.widget.TextView', `Row ${i}`, B(0, i * 60, 100, i * 60 + 50)));
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const a = agent(() => []);
      a.evaluateSelectors.mockImplementationOnce(async (selectors: Selector[]) => {
        now += 25_000; // the first chunk alone outlasts the 20 s budget
        return { requestId: 'r', errorMessage: '', results: selectors.map(() => ({ elements: [], errorMessage: '' })) };
      });
      const { errorMessage, stoppedAt } = await agentValidatedSuggestions(a, rows);
      expect(a.evaluateSelectors).toHaveBeenCalledTimes(1);
      expect(stoppedAt).toBe('candidates');
      expect(errorMessage).toMatch(/^checking took longer than 20 s; \d+ candidate\(s\) were not checked$/);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('which agent match is the node', () => {
  const row = node('android.widget.TextView', 'Wi-Fi', B(0, 100, 400, 200));

  it('takes a match clipped by a scrolling ancestor when class and text agree', async () => {
    // Android's dump clips to the window only; finds also clip to the list.
    const clipped = el(B(0, 150, 400, 200), 'Wi-Fi', 'android.widget.TextView');
    const a = agent((s) => (isText(s, 'Wi-Fi') ? [clipped] : []));
    const { byNode } = await agentValidatedSuggestions(a, [row]);
    expect(codes(byNode, row)).toContain('device.getByText("Wi-Fi")');
  });

  it('does not take a smaller element inside the node that only shares its class', async () => {
    const inner = el(B(0, 150, 400, 200), 'Other text', 'android.widget.TextView');
    const a = agent((s) => (isText(s, 'Wi-Fi') ? [inner] : []));
    const { byNode } = await agentValidatedSuggestions(a, [row]);
    expect(codes(byNode, row)).toEqual([]);
  });

  it('does not take a same-bounds element of another class with other text', async () => {
    const wrapper = el(B(0, 100, 400, 200), 'Settings row', 'android.view.ViewGroup');
    const a = agent((s) => (isText(s, 'Wi-Fi') ? [wrapper] : []));
    const { byNode } = await agentValidatedSuggestions(a, [row]);
    expect(codes(byNode, row)).toEqual([]);
  });

  it('takes a same-bounds element with the same text (the runtime\'s same target)', async () => {
    const innerText = el(B(0, 100, 400, 200), 'Wi-Fi', 'android.widget.Button');
    const a = agent((s) => (isText(s, 'Wi-Fi') ? [innerText] : []));
    const { byNode } = await agentValidatedSuggestions(a, [row]);
    expect(codes(byNode, row)).toContain('device.getByText("Wi-Fi")');
  });

  it('prefers the match of the node\'s own class when two share its bounds', async () => {
    const wrapper = el(B(0, 100, 400, 200), 'Wi-Fi', 'android.view.ViewGroup');
    const self = el(B(0, 100, 400, 200), 'Wi-Fi!', 'android.widget.TextView');
    // Both at the node's bounds: the one of the node's class is the node, so
    // the positional suffix points at it (index 1), not the wrapper.
    const a = agent((s) => (isText(s, 'Wi-Fi') ? [wrapper, self] : []));
    const { byNode } = await agentValidatedSuggestions(a, [row]);
    expect(codes(byNode, row)).toContain('device.getByText("Wi-Fi").last()');
  });

  it('takes a clipped container row whose name is its accessibility label, not its text', async () => {
    // An RN Pressable row: the dump has its name in content-desc and no text;
    // the agent reports it as contentDescription (its text aggregates children).
    const pressable: HierarchyNode = {
      tagName: 'node',
      attributes: new Map([['class', 'android.view.ViewGroup'], ['text', ''], ['content-desc', 'Wi-Fi'],
        ['clickable', 'true'], ['bounds', fmt(B(0, 100, 400, 200))]]),
      children: [],
      depth: 0,
    };
    const clipped = { ...el(B(0, 150, 400, 200), 'Wi-Fi On', 'android.view.ViewGroup'), contentDescription: 'Wi-Fi' } as ElementInfo;
    const a = agent((s) => (JSON.stringify(s).includes('"Wi-Fi"') ? [clipped] : []));
    const { byNode } = await agentValidatedSuggestions(a, [pressable]);
    expect(codes(byNode, pressable)).toContain('device.getByDescription("Wi-Fi")');
  });

  it('breaks a tie between same-size same-class matches on the name', async () => {
    const outer = el(B(0, 100, 400, 200), 'Network', 'android.widget.TextView');
    const self = el(B(0, 100, 400, 200), 'Wi-Fi', 'android.widget.TextView');
    const a = agent((s) => (s.kind.type === 'className' ? [outer, self] : []));
    const { byNode } = await agentValidatedSuggestions(a, [row]);
    expect(codes(byNode, row)).toEqual(['device.locator({ className: "android.widget.TextView" }).last()']);
  });

  it('identifies nothing when same-size same-class matches cannot be told apart', async () => {
    // A clickable RN view wrapping another of the same size, neither named.
    const box = (): HierarchyNode => ({
      tagName: 'node',
      attributes: new Map([['class', 'android.view.ViewGroup'], ['clickable', 'true'], ['bounds', fmt(B(0, 100, 400, 200))]]),
      children: [],
      depth: 0,
    });
    const inner = box();
    const wrapper = el(B(0, 100, 400, 200), 'A', 'android.view.ViewGroup');
    const child = el(B(0, 100, 400, 200), 'B', 'android.view.ViewGroup');
    const a = agent(() => [wrapper, child]);
    const { byNode } = await agentValidatedSuggestions(a, [inner]);
    expect(codes(byNode, inner)).toEqual([]);
  });

  it('identifies an iOS node scrolled partly above the screen (negative coordinates)', async () => {
    const cell: HierarchyNode = {
      tagName: 'XCUIElementTypeCell',
      attributes: new Map([['type', 'XCUIElementTypeCell'], ['label', 'Inbox'], ['clickable', 'true'], ['bounds', '[0,-20][390,24]']]),
      children: [],
      depth: 0,
    };
    const a = agent((s) => (JSON.stringify(s).includes('"Inbox"') ? [el(B(0, -20, 390, 24), 'Inbox', 'XCUIElementTypeCell')] : []));
    const { byNode } = await agentValidatedSuggestions(a, [cell]);
    expect(codes(byNode, cell).length).toBeGreaterThan(0);
  });

  it('never ties a node without real bounds to a match', async () => {
    const hidden = node('android.widget.TextView', 'Wi-Fi', B(0, 0, 0, 0));
    const a = agent((s) => (isText(s, 'Wi-Fi') ? [el(B(0, 0, 0, 0), 'Wi-Fi', 'android.widget.TextView')] : []));
    const { byNode } = await agentValidatedSuggestions(a, [hidden]);
    expect(codes(byNode, hidden)).toEqual([]);
  });
});
