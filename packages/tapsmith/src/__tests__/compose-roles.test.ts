import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getNodeRole, parseHierarchyXml, type HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';

// PILOT-828: Jetpack Compose reports a merging control's role (a Material3
// Button, a NavigationBarItem, a toggleable row) on a fake leaf child, which
// the Android agent's dump marks `tapsmith-role-carrier` while writing the
// role on the control itself (agent ComposeRoles.kt). The fixture is a real
// dump (Material3 1.3.2, compose-ui 1.8.2, API 36) of a login screen: an
// OutlinedTextField labelled "Email" with testTag "email_input", a bare
// Checkbox beside the text "Remember me", a toggleable "Keep me signed in"
// row, a Switch beside "Notifications", a "Sign in" Button, an IconButton
// whose Icon is described "Favorite", a disabled Button, a Button with the
// contentDescription "Submit form" around the text "Go", two selectable
// RadioButton rows ("Small" selected, "Large"), a "Tags off" TextButton, a
// CircularProgressIndicator last in the screen's column, and a three-item
// NavigationBar whose "Settings" item is described "Preferences". Each expected count is what the agent's
// getByRole / getByLabel / getByTestId returned on that screen.

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = parseHierarchyXml(readFileSync(path.join(here, 'fixtures/android-compose-m3.xml'), 'utf8'));

const matches = (code: string): HierarchyNode[] => {
  const parsed = parseSelectorString(code);
  expect(parsed, code).not.toBeNull();
  return findMatchingNodes(roots, parsed!);
};

describe('Compose controls in the trace playground agree with the device (PILOT-828)', () => {
  const DEVICE_COUNTS: Array<[string, number]> = [
    ['device.getByRole("button")', 5],
    ['device.getByRole("button", { name: "Sign in" })', 1],
    ['device.getByRole("button", { name: "Favorite" })', 1],
    ['device.getByRole("button", { name: "Disabled", disabled: true })', 1],
    ['device.getByRole("button", { name: "Submit form" })', 1],
    ['device.getByRole("button", { name: "Go" })', 1],
    ['device.getByRole("radiobutton")', 2],
    ['device.getByRole("radiobutton", { name: "Large" })', 1],
    ['device.getByRole("radiobutton", { checked: true })', 1],
    ['device.getByRole("tab")', 3],
    ['device.getByRole("tab", { name: "Items" })', 1],
    // The described item, not also its description's leaf (same bounds).
    ['device.getByRole("tab", { name: "Preferences" })', 1],
    // An unnamed last leaf of a layout container keeps its own role.
    ['device.getByRole("progressbar")', 1],
    ['device.getByRole("tab", { selected: true })', 1],
    ['device.getByRole("switch")', 1],
    ['device.getByRole("checkbox")', 2],
    // A bare Checkbox beside a Text has no accessible name.
    ['device.getByRole("checkbox", { name: "Remember me" })', 0],
    ['device.getByRole("checkbox", { name: "Keep me signed in" })', 1],
    ['device.getByRole("textfield", { name: "Email" })', 1],
    ['device.getByLabel("Email")', 1],
    // A testTag is a test id only with testTagsAsResourceId.
    ['device.getByTestId("email_input")', 0],
    ['device.getByText("Sign in")', 1],
  ];
  for (const [code, expected] of DEVICE_COUNTS) {
    it(`${code} → ${expected}`, () => {
      expect(matches(code).length).toBe(expected);
    });
  }

  it('matches the clickable control, not its role carrier', () => {
    const [button] = matches('device.getByRole("button", { name: "Sign in" })');
    expect(button.attributes.get('clickable')).toBe('true');
    expect(button.attributes.get('class')).toBe('android.view.View');
    for (const tab of matches('device.getByRole("tab")')) {
      expect(tab.attributes.has('tapsmith-role-carrier')).toBe(false);
    }
  });

  it('a carrier reports no role of its own', () => {
    const carriers: HierarchyNode[] = [];
    const walk = (node: HierarchyNode): void => {
      if (node.attributes.get('tapsmith-role-carrier') === 'true') carriers.push(node);
      node.children.forEach(walk);
    };
    roots.forEach(walk);
    // The five buttons', the toggleable row's, the two radio rows' and the
    // three tabs' — not the "Submit form" description's leaf beside a carrier.
    expect(carriers).toHaveLength(11);
    for (const carrier of carriers) expect(carrier.attributes.get('content-desc')).toBe('');
    for (const carrier of carriers) expect(getNodeRole(carrier)).toBe('');
  });
});

describe('getByLabel reads a text field\'s child text, not a spinner\'s (PILOT-828)', () => {
  const XML = `<hierarchy>
  <node index="0" text="" resource-id="" class="android.widget.EditText" content-desc="" bounds="[0,0][500,100]">
    <node index="0" text="Email" resource-id="" class="android.widget.TextView" content-desc="" bounds="[10,10][100,50]" />
  </node>
  <node index="1" text="" resource-id="" class="android.widget.Spinner" content-desc="" bounds="[0,100][500,200]">
    <node index="0" text="Small" resource-id="" class="android.widget.TextView" content-desc="" bounds="[10,110][100,150]" />
  </node>
</hierarchy>`;
  const tree = parseHierarchyXml(XML);
  const count = (code: string): number => findMatchingNodes(tree, parseSelectorString(code)!).length;

  it('a Compose text field is named by its label child', () => {
    expect(count('device.getByLabel("Email")')).toBe(1);
  });

  it('a spinner is not named by the value it shows', () => {
    expect(count('device.getByLabel("Small")')).toBe(0);
  });
});
