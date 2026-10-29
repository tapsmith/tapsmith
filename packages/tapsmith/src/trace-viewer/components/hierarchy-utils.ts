import { decodeXmlEntities } from '../../xml-entities.js';
import { ANDROID_ROLE_CLASSES } from '../../roles.js';
import { isHooksMarkerCarrier } from './non-app-nodes.js';

// ─── Types ───

export interface HierarchyNode {
  tagName: string
  attributes: Map<string, string>
  children: HierarchyNode[]
  depth: number
}

export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

// ─── XML Parser ───

/**
 * Parse a hierarchy dump into a node tree. Attribute values are returned
 * XML-entity-decoded — `Support &amp; legal` reads back as
 * `Support & legal` — so every consumer (MCP snapshot and test-locator, the
 * trace-viewer and UI-mode hierarchy tree and locator playground) sees the
 * text the app shows and the runtime matches against.
 */
export function parseHierarchyXml(xml: string): HierarchyNode[] {
  const roots: HierarchyNode[] = [];
  const stack: HierarchyNode[] = [];

  // A tag name may end in `(<n>)`: the iOS agent names an element type it
  // has no name for by its raw value, e.g. `XCUIElementType(2)`.
  const tagRe = /<(\/?)([a-zA-Z_][\w.]*(?:\(\d+\))?)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2];
    const attrsStr = match[3];
    const isSelfClosing = match[4] === '/';

    if (isClosing) {
      if (stack.length > 0) stack.pop();
      continue;
    }

    const attributes = new Map<string, string>();
    const attrRe = /([\w:.-]+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
      attributes.set(attrMatch[1], decodeXmlEntities(attrMatch[2]));
    }

    const node: HierarchyNode = {
      tagName,
      attributes,
      children: [],
      depth: stack.length,
    };

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }

    if (!isSelfClosing) {
      stack.push(node);
    }
  }

  return roots;
}

// ─── Bounds Parser ───

export function parseBounds(boundsStr: string): Bounds | null {
  const match = boundsStr.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  return {
    left: parseInt(match[1], 10),
    top: parseInt(match[2], 10),
    right: parseInt(match[3], 10),
    bottom: parseInt(match[4], 10),
  };
}

// ─── Role Mapping ───

export const ANDROID_CLASS_TO_ROLE: Record<string, string> = {
  'android.widget.Button': 'button',
  'android.widget.ImageButton': 'button',
  // Also React Native's accessibilityRole="togglebutton" (PILOT-664).
  'android.widget.ToggleButton': 'button',
  'com.google.android.material.button.MaterialButton': 'button',
  'androidx.appcompat.widget.AppCompatButton': 'button',
  'android.widget.EditText': 'textfield',
  'android.widget.AutoCompleteTextView': 'textfield',
  'com.google.android.material.textfield.TextInputEditText': 'textfield',
  'androidx.appcompat.widget.AppCompatEditText': 'textfield',
  'android.widget.CheckBox': 'checkbox',
  'androidx.appcompat.widget.AppCompatCheckBox': 'checkbox',
  'com.google.android.material.checkbox.MaterialCheckBox': 'checkbox',
  'android.widget.Switch': 'switch',
  'androidx.appcompat.widget.SwitchCompat': 'switch',
  'com.google.android.material.switchmaterial.SwitchMaterial': 'switch',
  'android.widget.ImageView': 'image',
  'androidx.appcompat.widget.AppCompatImageView': 'image',
  'android.widget.TextView': 'text',
  'androidx.appcompat.widget.AppCompatTextView': 'text',
  'com.google.android.material.textview.MaterialTextView': 'text',
  'android.widget.SearchView': 'searchfield',
  'androidx.appcompat.widget.SearchView': 'searchfield',
  'android.widget.RadioButton': 'radiobutton',
  'androidx.appcompat.widget.AppCompatRadioButton': 'radiobutton',
  'android.widget.Spinner': 'spinner',
  'androidx.appcompat.widget.AppCompatSpinner': 'spinner',
  'android.widget.ProgressBar': 'progressbar',
  'android.widget.SeekBar': 'seekbar',
  'com.google.android.material.slider.Slider': 'seekbar',
  'android.widget.RadioGroup': 'radiogroup',
  'android.widget.NumberPicker': 'spinbutton',
  'android.widget.Chronometer': 'timer',
};

// No XCUIElementTypeTextView: the iOS agent's getByRole("textfield") does not
// find a multi-line text view, so the playground must not offer it (PILOT-666).
export const IOS_TYPE_TO_ROLE: Record<string, string> = {
  'XCUIElementTypeButton': 'button',
  'XCUIElementTypeTextField': 'textfield',
  'XCUIElementTypeSecureTextField': 'textfield',
  'XCUIElementTypeSwitch': 'switch',
  'XCUIElementTypeCheckBox': 'checkbox',
  'XCUIElementTypeImage': 'image',
  'XCUIElementTypeStaticText': 'text',
  'XCUIElementTypeSearchField': 'searchfield',
  'XCUIElementTypeSlider': 'seekbar',
  'XCUIElementTypeProgressIndicator': 'progressbar',
  'XCUIElementTypeActivityIndicator': 'progressbar',
  'XCUIElementTypePicker': 'spinner',
  'XCUIElementTypeRadioButton': 'radiobutton',
  'XCUIElementTypeStepper': 'spinbutton',
  'XCUIElementTypeMenu': 'menu',
  'XCUIElementTypeMenuBar': 'menubar',
  'XCUIElementTypeMenuItem': 'menuitem',
  'XCUIElementTypeRadioGroup': 'radiogroup',
};

export const WEBVIEW_TAG_TO_ROLE: Record<string, string> = {
  button: 'button',
  a: 'link',
  input: 'textfield',
  textarea: 'textfield',
  select: 'combobox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  img: 'image',
  ul: 'list', ol: 'list',
  li: 'listitem',
  progress: 'progressbar',
  dialog: 'dialog',
};

/**
 * The attribute the Android agent marks a Jetpack Compose role carrier with:
 * the fake leaf Compose appends to a control to carry its role, which the
 * control itself reports (`tapsmith-role`) and no getByRole matches
 * (agent ComposeRoles.kt).
 */
export const COMPOSE_ROLE_CARRIER_ATTRIBUTE = 'tapsmith-role-carrier';

/** Whether a node is a Compose role carrier ({@link COMPOSE_ROLE_CARRIER_ATTRIBUTE}). */
export function isComposeRoleCarrier(node: HierarchyNode): boolean {
  return node.attributes.get(COMPOSE_ROLE_CARRIER_ATTRIBUTE) === 'true';
}

export function getNodeRole(node: HierarchyNode): string {
  // A Compose role carrier lends its role to its parent and has none itself.
  if (isComposeRoleCarrier(node)) return '';
  // Agent-injected role (trait-based: heading, alert, link, combobox, etc.)
  const agentRole = node.attributes.get('tapsmith-role');
  if (agentRole) return agentRole;

  // WebView nodes
  if (node.attributes.get('webview') === 'true') {
    const explicitRole = node.attributes.get('webview-role');
    if (explicitRole) return explicitRole;
    const tag = node.attributes.get('webview-tag') ?? '';
    return WEBVIEW_TAG_TO_ROLE[tag] ?? '';
  }

  const className = node.attributes.get('class');
  if (className) return ANDROID_CLASS_TO_ROLE[className] ?? '';
  const iosType = node.attributes.get('type') ?? node.tagName;
  return IOS_TYPE_TO_ROLE[iosType] ?? '';
}

// ─── getByLabel Fields ───

/**
 * The element types the iOS agent's getByLabel finds (its
 * `LabelMatch.inputTypes`, ios-agent LabelMatchTests): by element type, not by
 * reported role — a text field keeps its type whatever trait role it reports,
 * and a search field is not one of them.
 */
export const IOS_LABEL_FIELD_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeTextField',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeTextView',
  'XCUIElementTypeSwitch',
  'XCUIElementTypeSlider',
  'XCUIElementTypeStepper',
  'XCUIElementTypePicker',
  'XCUIElementTypeCheckBox',
  'XCUIElementTypeRadioButton',
]);

/**
 * The classes the Android agent's getByLabel walks (its `labelInputClassPattern`):
 * the classes of these roles in its role map, which roles.test.ts pins to
 * ANDROID_ROLE_CLASSES (the roles themselves are pinned by
 * label-conformance.test.ts). A view that only reports one of the roles (an RN
 * `accessibilityRole="checkbox"` ViewGroup) is not walked.
 */
export const ANDROID_LABEL_FIELD_ROLES: readonly string[] = ['textfield', 'checkbox', 'switch', 'radiobutton', 'seekbar', 'spinner'];
const ANDROID_LABEL_FIELD_CLASSES: ReadonlySet<string> = new Set(
  ANDROID_LABEL_FIELD_ROLES.flatMap((role) => ANDROID_ROLE_CLASSES[role] ?? []),
);

/** Whether the runtime's getByLabel can find this node: a native input of a type or class the agent looks at. */
export function isLabelField(node: HierarchyNode): boolean {
  if (node.attributes.get('webview') === 'true') return false;
  const className = node.attributes.get('class');
  if (className !== undefined) return ANDROID_LABEL_FIELD_CLASSES.has(className);
  return IOS_LABEL_FIELD_TYPES.has(node.attributes.get('type') ?? node.tagName);
}

/**
 * The `aria-label` attribute of a WebView node — what `webview.getByLabel`
 * matches. The node's content-desc is its computed accessible name (also
 * from aria-labelledby or a `<label>`), which getByLabel does not read.
 * A dump that predates the attribute falls back to content-desc.
 */
export function webViewAriaLabel(node: HierarchyNode): string {
  return node.attributes.get('webview-aria-label') ?? node.attributes.get('content-desc') ?? '';
}

// ─── Geometry ───

export function getNodeBounds(node: HierarchyNode): Bounds | null {
  const boundsStr = node.attributes.get('bounds');
  if (!boundsStr) return null;
  return parseBounds(boundsStr);
}

// ─── Hit Testing ───

function boundsContains(bounds: Bounds, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function boundsArea(bounds: Bounds): number {
  return (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
}

export function hitTest(roots: HierarchyNode[], x: number, y: number): HierarchyNode | null {
  let best: HierarchyNode | null = null;
  let bestArea = Infinity;
  let bestIsWebView = false;

  function walk(node: HierarchyNode) {
    const bounds = getNodeBounds(node);
    // The hooks marker and its carrier are screen-sized and invisible: never
    // what a pick means.
    if (bounds && boundsContains(bounds, x, y) && !isHooksMarkerCarrier(node)) {
      const area = boundsArea(bounds);
      const isWv = node.attributes.get('webview') === 'true';
      // Prefer WebView DOM nodes over native nodes at similar coordinates —
      // UIAutomator2/XCUITest also expose web content as native elements,
      // but the WebView DOM nodes produce better selectors (CSS-based).
      const shouldReplace = isWv && !bestIsWebView
        ? area <= bestArea * 1.5   // WebView node wins unless much larger
        : !isWv && bestIsWebView
          ? false                   // Never replace a WebView node with native
          : area <= bestArea;        // Same category: smallest wins (equal picks deeper node)
      if (shouldReplace) {
        best = node;
        bestArea = area;
        bestIsWebView = isWv;
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }
  return best;
}

/** The node reached by `path` (child indices from the roots), if it exists. */
export function nodeAtPath(roots: HierarchyNode[], path: number[]): HierarchyNode | undefined {
  let nodes = roots;
  let node: HierarchyNode | undefined;
  for (const index of path) {
    node = nodes[index];
    if (!node) return undefined;
    nodes = node.children;
  }
  return node;
}

/** Child indices from the roots to `target`, or undefined if it is not in the tree. */
export function pathToNode(roots: HierarchyNode[], target: HierarchyNode): number[] | undefined {
  const walk = (nodes: HierarchyNode[], prefix: number[]): number[] | undefined => {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i] === target) return [...prefix, i];
      const found = walk(nodes[i].children, [...prefix, i]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(roots, []);
}
