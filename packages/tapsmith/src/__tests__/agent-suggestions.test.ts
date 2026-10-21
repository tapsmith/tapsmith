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

  it('asks the agent once for the whole screen, each distinct selector once', async () => {
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
});
