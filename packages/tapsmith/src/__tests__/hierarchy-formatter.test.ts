import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import type { GeneratedSelector } from '../trace-viewer/components/selector-generation.js';
import { formatHierarchy, semanticNodes } from '../mcp/hierarchy-formatter.js';

// The formatter renders whatever the agent validated (PILOT-848): it never
// decides a match itself.

function node(attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return { tagName: 'node', attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

const save = node({ class: 'android.widget.Button', text: 'Save', clickable: 'true' });
const title = node({ class: 'android.widget.TextView', text: 'Settings' });
const root = node({ class: 'android.widget.FrameLayout' }, [title, save]);

const s = (code: string, priority = 1): GeneratedSelector => ({ code, label: 'x', priority });

describe('formatHierarchy', () => {
  it('refs each node with its best validated suggestion', () => {
    const { tree, locators } = formatHierarchy([root], new Map([
      [save, [s('device.getByRole("button", { name: "Save" })'), s('device.getByText("Save")', 6)]],
    ]));
    expect(locators).toEqual(['[1] device.getByRole("button", { name: "Save" })']);
    expect(tree).toBe('- text "Settings"\n- [1] button "Save"');
  });

  it('lists a node with no validated suggestion without a ref', () => {
    const { tree, locators } = formatHierarchy([root], new Map());
    expect(locators).toEqual([]);
    expect(tree).toBe('- text "Settings"\n- button "Save"');
  });
});

describe('semanticNodes', () => {
  it('returns the nodes the tree lists, in tree order', () => {
    expect(semanticNodes([root])).toEqual([title, save]);
  });
});
