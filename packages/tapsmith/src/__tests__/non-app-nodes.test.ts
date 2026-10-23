import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseHierarchyXml, hitTest } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { HOOKS_MARKER_PREFIX } from '../hooks-marker.js';

// PILOT-756 / PILOT-830: what no user locator matches — the iOS application
// element and keyboard, Android System UI bars and the IME (the window roots
// the agent marks `tapsmith-non-app`), and @tapsmith/react-native's hooks
// marker. The agents apply the same rule (ios-agent NonAppElements, Android
// NonAppNodes); this is the trace viewer's copy of it.

const count = (xml: string, code: string): number => {
  const parsed = parseSelectorString(code);
  expect(parsed, code).not.toBeNull();
  return findMatchingNodes(parseHierarchyXml(xml), parsed!).length;
};

const MARKER = 'tapsmith-hooks:1;epoch=3;nav=2;boot=c0ffee42;url=myapp:///';

const IOS = `<hierarchy>
  <XCUIElementType(2) label="Tapsmith Test App" identifier="" value="" placeholderValue="" type="XCUIElementType(2)" bounds="[0,0][393,852]">
    <XCUIElementTypeWindow label="" identifier="" value="" placeholderValue="" type="XCUIElementTypeWindow" bounds="[0,0][393,852]">
      <XCUIElementTypeStaticText label="Tapsmith Test App" identifier="" value="" placeholderValue="" type="XCUIElementTypeStaticText" tapsmith-role="heading" bounds="[100,60][293,80]" />
      <XCUIElementTypeButton label="Done" identifier="" value="" placeholderValue="" type="XCUIElementTypeButton" bounds="[300,100][380,140]" />
      <XCUIElementTypeStaticText label="Delete draft" identifier="" value="" placeholderValue="" type="XCUIElementTypeStaticText" bounds="[20,150][200,170]" />
      <XCUIElementTypeStaticText label="${MARKER}" identifier="tapsmith-hooks" value="" placeholderValue="" type="XCUIElementTypeStaticText" bounds="[0,0][393,852]" />
      <XCUIElementTypeStaticText label="${MARKER}" identifier="" value="" placeholderValue="" type="XCUIElementTypeStaticText" bounds="[300,840][389,850]" />
      <XCUIElementTypeToolbar label="" identifier="" value="" placeholderValue="" type="XCUIElementTypeToolbar" bounds="[0,500][393,544]">
        <XCUIElementTypeButton label="Next" identifier="" value="" placeholderValue="" type="XCUIElementTypeButton" bounds="[320,505][390,540]" />
      </XCUIElementTypeToolbar>
    </XCUIElementTypeWindow>
    <XCUIElementTypeWindow label="" identifier="" value="" placeholderValue="" type="XCUIElementTypeWindow" bounds="[0,544][393,852]">
      <XCUIElementType(19) label="" identifier="" value="" placeholderValue="" type="XCUIElementType(19)" bounds="[0,544][393,852]">
        <XCUIElementType(20) label="delete" identifier="" value="" placeholderValue="" type="XCUIElementType(20)" bounds="[340,700][390,740]" />
        <XCUIElementTypeButton label="Done" identifier="" value="" placeholderValue="" type="XCUIElementTypeButton" bounds="[300,800][390,840]" />
        <XCUIElementTypeButton label="Next" identifier="" value="" placeholderValue="" type="XCUIElementTypeButton" bounds="[10,800][90,840]" />
      </XCUIElementType(19)>
    </XCUIElementTypeWindow>
  </XCUIElementType(2)>
</hierarchy>`;

const ANDROID = `<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" bounds="[0,0][1080,63]" tapsmith-non-app="true">
    <node index="0" text="10:06" class="android.widget.TextView" package="com.android.systemui" content-desc="" bounds="[40,10][140,55]" />
    <node index="1" text="" class="android.widget.ImageView" package="com.android.systemui" content-desc="Back" bounds="[900,10][960,55]" />
  </node>
  <node index="0" text="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" bounds="[0,0][1080,2400]">
    <node index="0" text="Back" class="android.widget.Button" package="com.example.app" content-desc="" bounds="[0,100][200,200]" />
    <node index="1" text="Meeting at 10:06" class="android.widget.TextView" package="com.example.app" content-desc="" bounds="[0,300][600,350]" />
    <node index="2" text="" class="android.widget.Button" package="com.example.app" content-desc="" bounds="[0,0][1080,2400]">
      <node index="0" text="${MARKER}" resource-id="tapsmith-hooks" class="android.widget.TextView" package="com.example.app" content-desc="" bounds="[0,0][1080,2400]" />
    </node>
  </node>
  <node index="0" text="" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" content-desc="" bounds="[0,1600][1080,2400]" tapsmith-non-app="true">
    <node index="0" text="Done" class="android.widget.Button" package="com.google.android.inputmethod.latin" content-desc="" bounds="[900,2200][1060,2380]" />
  </node>
  <node index="0" text="" class="android.widget.FrameLayout" package="com.android.permissioncontroller" content-desc="" bounds="[0,800][1080,1600]">
    <node index="0" text="Allow" class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" bounds="[100,1400][500,1500]" />
  </node>
</hierarchy>`;

// The agent names these types since PILOT-756; older traces carry the raw
// `XCUIElementType(<n>)` spelling, which the parser reads too.
const IOS_NAMED = IOS
  .replaceAll('XCUIElementType(2)', 'XCUIElementTypeApplication')
  .replaceAll('XCUIElementType(19)', 'XCUIElementTypeKeyboard')
  .replaceAll('XCUIElementType(20)', 'XCUIElementTypeKey');

describe('iOS: the application element, the keyboard and the hooks marker never match', () => {
  it('parses raw-numbered element types (traces recorded before the agent named them)', () => {
    const [app] = parseHierarchyXml(IOS)[0].children;
    expect(app.tagName).toBe('XCUIElementType(2)');
    expect(app.children).toHaveLength(2);
  });

  it('applies the same rule to the named spelling', () => {
    expect(count(IOS_NAMED, 'device.getByText("App")')).toBe(1);
    expect(count(IOS_NAMED, 'device.getByText("Done", { exact: true })')).toBe(1);
    expect(count(IOS_NAMED, 'device.getByText("delete", { exact: true })')).toBe(0);
  });

  it('does not match the application element by its app-name label', () => {
    expect(count(IOS, 'device.getByText("Tapsmith Test App")')).toBe(1);
    expect(count(IOS, 'device.getByText("App")')).toBe(1);
  });

  it('does not match keyboard keys or buttons inside the keyboard', () => {
    expect(count(IOS, 'device.getByText("Done", { exact: true })')).toBe(1);
    expect(count(IOS, 'device.getByRole("button", { name: "Done" })')).toBe(1);
    expect(count(IOS, 'device.getByText("Delete")')).toBe(1);
    expect(count(IOS, 'device.getByText("delete", { exact: true })')).toBe(0);
  });

  it('keeps an input accessory toolbar above the keyboard matchable', () => {
    expect(count(IOS, 'device.getByRole("button", { name: "Next" })')).toBe(1);
  });

  it('does not match either copy of the hooks marker, by any locator', () => {
    for (const code of [
      'device.getByText("nav")',
      'device.getByText("epoch=3")',
      'device.getByText(/boot/)',
      `device.getByText(${JSON.stringify(MARKER)}, { exact: true })`,
      'device.getByTestId("tapsmith-hooks")',
    ]) {
      expect(count(IOS, code), code).toBe(0);
    }
  });

  it('does not land a pick on the screen-sized marker', () => {
    const roots = parseHierarchyXml(IOS);
    // A blank spot: only the window, the root and the marker carrier contain it.
    const hit = hitTest(roots, 50, 400);
    expect(hit?.attributes.get('label')).not.toContain(HOOKS_MARKER_PREFIX);
  });
});

describe('Android: System UI bars, the IME and the hooks marker never match', () => {
  it('does not match status bar or navigation bar nodes', () => {
    expect(count(ANDROID, 'device.getByText("10:06")')).toBe(1);
    expect(count(ANDROID, 'device.getByText(/^\\d{1,2}:\\d{2}$/)')).toBe(0);
    expect(count(ANDROID, 'device.getByRole("image")')).toBe(0);
  });

  it('does not match keys in the input method window', () => {
    expect(count(ANDROID, 'device.getByText("Done", { exact: true })')).toBe(0);
  });

  it("keeps another app's window (a permission dialog) matchable", () => {
    expect(count(ANDROID, 'device.getByText("Allow", { exact: true })')).toBe(1);
  });

  it('does not match the hooks marker, nor read it into a container name', () => {
    expect(count(ANDROID, 'device.getByText("nav")')).toBe(0);
    expect(count(ANDROID, 'device.getByTestId("tapsmith-hooks")')).toBe(0);
    // A view wrapping the marker takes no name from it.
    expect(count(ANDROID, 'device.getByRole("button", { name: "epoch" })')).toBe(0);
    expect(count(ANDROID, 'device.getByRole("button", { name: "Back" })')).toBe(1);
  });
});

describe('every copy of the hooks marker prefix agrees', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const sources: Array<[string, RegExp]> = [
    ['ios-agent/TapsmithAgent/NonAppElements.swift', /static let hooksMarkerPrefix = "([^"]+)"/],
    ['agent/app/src/main/kotlin/dev/tapsmith/agent/NonAppNodes.kt', /const val HOOKS_MARKER_PREFIX = "([^"]+)"/],
    ['packages/tapsmith-react-native/src/protocol.ts', /export const MARKER_PREFIX = '([^']+)'/],
    ['packages/tapsmith-core/src/app_reset.rs', /pub const HOOKS_MARKER_PREFIX: &str = "([^"]+)"/],
  ];
  for (const [file, re] of sources) {
    it(file, () => {
      const match = re.exec(readFileSync(path.join(repo, file), 'utf8'));
      expect(match?.[1]).toBe(HOOKS_MARKER_PREFIX);
    });
  }
});
