import { describe, it, expect } from 'vitest';
import { mirrorPointToLogical, logicalBoundsToMirrorCss } from '../ui-mode/components/mirror-coords.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import { handleHoverFromScreenshot, handlePickFromScreenshot, isWebViewOverlayPending } from '../trace-viewer/components/selector-pick.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { disambiguateSelectors } from '../trace-viewer/components/selector-uniqueness.js';

describe('mirrorPointToLogical', () => {
  // iPhone-ish: 1179×2556 px frame at dpr 3, mirrored into a 300×650 CSS box.
  const rect = { left: 20, top: 10, width: 300, height: 650 };

  it('maps a CSS point to logical points on iOS (dpr 3)', () => {
    // Horizontal centre of the canvas → centre of the logical screen.
    const p = mirrorPointToLogical(20 + 150, 10 + 325, rect, 1179, 2556, 3);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(1179 / 3 / 2); // 196.5
    expect(p!.y).toBeCloseTo(2556 / 3 / 2); // 426
  });

  it('is the identity scale on Android (dpr 1, bounds already px)', () => {
    const p = mirrorPointToLogical(20, 10, rect, 1080, 2400, 1);
    expect(p).toEqual({ x: 0, y: 0 });
    const q = mirrorPointToLogical(20 + 300, 10 + 650, rect, 1080, 2400, 1);
    expect(q).toEqual({ x: 1080, y: 2400 });
  });

  it('clamps points outside the canvas rect', () => {
    const p = mirrorPointToLogical(-500, 99999, rect, 1080, 2400, 1);
    expect(p).toEqual({ x: 0, y: 2400 });
  });

  it('returns null for zero-size rect or missing frame', () => {
    expect(mirrorPointToLogical(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 1080, 2400, 1)).toBeNull();
    expect(mirrorPointToLogical(0, 0, rect, 0, 0, 1)).toBeNull();
  });
});

describe('logicalBoundsToMirrorCss', () => {
  it('scales logical bounds into the CSS canvas box (dpr 3)', () => {
    // Logical screen 393×852 (1179×2556 px @3x) → 393×852 CSS box: 1 pt = 1 CSS px.
    const css = logicalBoundsToMirrorCss(
      { left: 10, top: 20, right: 110, bottom: 70 },
      393, 852, 1179, 2556, 3,
    );
    expect(css.left).toBeCloseTo(10);
    expect(css.top).toBeCloseTo(20);
    expect(css.width).toBeCloseTo(100);
    expect(css.height).toBeCloseTo(50);
  });

  it('scales device-pixel bounds on Android (dpr 1)', () => {
    const css = logicalBoundsToMirrorCss(
      { left: 0, top: 0, right: 540, bottom: 1200 },
      270, 600, 1080, 2400, 1,
    );
    expect(css).toEqual({ left: 0, top: 0, width: 135, height: 300 });
  });

  it('round-trips with mirrorPointToLogical', () => {
    // A CSS point inside the rendered box of some logical bounds must
    // hit-test back inside those bounds.
    const rect = { left: 0, top: 0, width: 300, height: 650 };
    const bounds = { left: 50, top: 100, right: 150, bottom: 200 }; // logical pts
    const css = logicalBoundsToMirrorCss(bounds, rect.width, rect.height, 1179, 2556, 3);
    const centre = { x: css.left + css.width / 2, y: css.top + css.height / 2 };
    const logical = mirrorPointToLogical(centre.x, centre.y, rect, 1179, 2556, 3);
    expect(logical).not.toBeNull();
    expect(logical!.x).toBeGreaterThan(bounds.left);
    expect(logical!.x).toBeLessThan(bounds.right);
    expect(logical!.y).toBeGreaterThan(bounds.top);
    expect(logical!.y).toBeLessThan(bounds.bottom);
  });
});

describe('isWebViewOverlayPending', () => {
  const withoutOverlay = `<hierarchy>
    <XCUIElementTypeApplication type="XCUIElementTypeApplication" bounds="[0,0][393,852]">
      <XCUIElementTypeButton label="Back" bounds="[16,62][106,106]" />
      <XCUIElementTypeWebView type="XCUIElementTypeWebView" bounds="[0,120][393,852]">
        <XCUIElementTypeTextField placeholderValue="Enter your email" bounds="[24,300][369,348]" />
      </XCUIElementTypeWebView>
    </XCUIElementTypeApplication>
  </hierarchy>`;

  it('true for a point inside a WebView with no DOM overlay in the tree', () => {
    const roots = parseHierarchyXml(withoutOverlay);
    expect(isWebViewOverlayPending(roots, 196, 324)).toBe(true);
  });

  it('false outside the WebView container', () => {
    const roots = parseHierarchyXml(withoutOverlay);
    expect(isWebViewOverlayPending(roots, 60, 84)).toBe(false); // Back button
  });

  it('false once the DOM overlay is present', () => {
    const withOverlay = withoutOverlay.replace(
      '</XCUIElementTypeApplication>',
      '<webview.input bounds="[24,300][369,348]" webview-tag="input" webview="true" />\n</XCUIElementTypeApplication>',
    );
    const roots = parseHierarchyXml(withOverlay);
    expect(isWebViewOverlayPending(roots, 196, 324)).toBe(false);
  });

  it("another WebView's overlay does not suppress deferral (scoped to the pick point)", () => {
    // Two WebViews; only the first has its DOM overlay. A pick inside the
    // second must still be treated as pending.
    const twoWebViews = `<hierarchy>
      <XCUIElementTypeApplication type="XCUIElementTypeApplication" bounds="[0,0][393,852]">
        <XCUIElementTypeWebView type="XCUIElementTypeWebView" bounds="[0,100][393,400]" />
        <XCUIElementTypeWebView type="XCUIElementTypeWebView" bounds="[0,500][393,800]" />
        <webview.body bounds="[0,100][393,400]" webview-tag="body" webview="true" />
      </XCUIElementTypeApplication>
    </hierarchy>`;
    const roots = parseHierarchyXml(twoWebViews);
    expect(isWebViewOverlayPending(roots, 196, 250)).toBe(false); // first: overlay present
    expect(isWebViewOverlayPending(roots, 196, 650)).toBe(true);  // second: overlay pending
  });

  it('detects Android WebView containers by class attribute', () => {
    const android = `<hierarchy>
      <node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
        <node class="android.webkit.WebView" bounds="[0,300][1080,2400]" />
      </node>
    </hierarchy>`;
    const roots = parseHierarchyXml(android);
    expect(isWebViewOverlayPending(roots, 540, 1200)).toBe(true);
    expect(isWebViewOverlayPending(roots, 540, 150)).toBe(false);
  });
});

describe('live mirror pick end-to-end (pure)', () => {
  // iOS-style hierarchy: bounds in logical points on a 393×852 screen.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppHierarchy>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" bounds="[0,0][393,852]">
    <XCUIElementTypeOther type="XCUIElementTypeOther" bounds="[0,0][393,852]">
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Welcome back" bounds="[24,120][369,160]" />
      <XCUIElementTypeButton type="XCUIElementTypeButton" label="Sign in" clickable="true" bounds="[24,700][369,752]" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppHierarchy>`;

  it('flags suggestions as mayNotMatch when the live screen changes under a pick', () => {
    const roots = parseHierarchyXml(xml);
    const pick = handlePickFromScreenshot(roots, 196, 726)!;

    // Same-screen disambiguation: suggestions resolve, no stale flags.
    const fresh = disambiguateSelectors(roots, pick.node, generateSelectors(pick.node));
    expect(fresh.some((s) => s.mayNotMatch)).toBe(false);

    // Live refresh delivers a different screen — the picked button is gone.
    const newScreen = parseHierarchyXml(`<hierarchy>
      <XCUIElementTypeApplication type="XCUIElementTypeApplication" bounds="[0,0][393,852]">
        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Signed in" bounds="[24,120][369,160]" />
      </XCUIElementTypeApplication>
    </hierarchy>`);
    const stale = disambiguateSelectors(newScreen, pick.node, generateSelectors(pick.node));
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((s) => s.mayNotMatch)).toBe(true);
    expect(stale.every((s) => s.label.includes('may not match'))).toBe(true);
  });

  it('a click on the mirror resolves to the element under the cursor', () => {
    const roots = parseHierarchyXml(xml);
    // Click the middle of the Sign in button in a 393×852 CSS mirror of a
    // 1179×2556 px frame (dpr 3): CSS coords equal logical points here.
    const rect = { left: 0, top: 0, width: 393, height: 852 };
    const point = mirrorPointToLogical(196, 726, rect, 1179, 2556, 3);
    expect(point).not.toBeNull();
    const result = handlePickFromScreenshot(roots, point!.x, point!.y);
    expect(result).not.toBeNull();
    expect(result!.node.attributes.get('label')).toBe('Sign in');
    expect(result!.selector).toBe('device.getByRole("button", { name: "Sign in" })');
    expect(result!.bounds).toEqual({ left: 24, top: 700, right: 369, bottom: 752 });
  });
});

describe('handleHoverFromScreenshot', () => {
  // An unnamed row (no label, id or role) holding a named text: a click on
  // the row picks the text, so the hover outlines the text.
  const roots = parseHierarchyXml(`<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.view.ViewGroup" bounds="[0,0][240,100]">
    <node class="android.widget.TextView" text="Notifications" bounds="[10,10][60,40]" />
  </node>
</hierarchy>`);

  it('outlines the element a pick at the point takes, not the raw element under it', () => {
    const picked = handlePickFromScreenshot(roots, 150, 50);
    expect(picked?.node.attributes.get('text')).toBe('Notifications');
    expect(handleHoverFromScreenshot(roots, 150, 50)).toEqual({ left: 10, top: 10, right: 60, bottom: 40 });
    // Again on the same node (worked out once): the same outline.
    expect(handleHoverFromScreenshot(roots, 200, 80)).toEqual({ left: 10, top: 10, right: 60, bottom: 40 });
  });

  it('outlines nothing off every element', () => {
    expect(handleHoverFromScreenshot(roots, 239, 300)).toBeNull();
  });
});
