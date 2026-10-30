import { describe, it, expect } from 'vitest';
import { scrollRegion } from '../scroll-container.js';

// PILOT-934: scrollIntoView() swipes inside the scroll container that holds
// its element, so a swipe cannot start outside a dialog (dismissing it) or on
// a header above the list (moving nothing, PILOT-348). The container is
// picked from the hierarchy dump it already reads before each swipe.

/** An Android node; `attrs` adds attributes such as `scrollable="true"`. */
const node = (cls: string, b: string, attrs = '', children = '') =>
  `<node class="${cls}" package="dev.app" bounds="${b}" ${attrs}${children ? `>${children}</node>` : '/>'}`;
const android = (...windows: string[]) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${windows.join('')}</hierarchy>`;
const statusBar = '<node class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][1080,63]" tapsmith-non-app="true"/>';
const scrollable = 'scrollable="true"';

/** An iOS element; iOS lists off-screen elements with their real frames. */
const el = (type: string, b: string, attrs = '', children = '') =>
  `<XCUIElementType${type} type="XCUIElementType${type}" bounds="${b}" ${attrs}${children ? `>${children}</XCUIElementType${type}>` : '/>'}`;
const ios = (...children: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><hierarchy>${el('Application', '[0,0][402,874]', 'label="App"', el('Window', '[0,0][402,874]', '', children.join('')))}</hierarchy>`;

describe('scrollRegion — Android (the element is not in the tree)', () => {
  it('picks the scrollable in a dialog window over the activity, not the larger list under it', () => {
    // The ticket's Compose Dialog: its own window, smaller than the activity's.
    const xml = android(
      node('android.view.View', '[90,700][990,1700]', '', node('android.view.View', '[90,820][990,1600]', scrollable,
        node('android.widget.TextView', '[130,840][950,900]', 'text="Sort"'))),
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('androidx.compose.ui.platform.ComposeView', '[0,0][1080,2400]', '',
          node('android.view.View', '[0,200][1080,2280]', scrollable))),
      statusBar,
    );

    expect(scrollRegion(xml)).toEqual({ left: 90, top: 820, right: 990, bottom: 1600 });
  });

  it('picks the list below a fixed header, so the swipe never starts in the header (PILOT-348)', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('android.widget.TextView', '[0,63][1080,563]', 'text="30 items"') +
        node('android.widget.ScrollView', '[0,563][1080,2400]', scrollable)),
      statusBar,
    );

    expect(scrollRegion(xml)).toEqual({ left: 0, top: 563, right: 1080, bottom: 2400 });
  });

  it('cuts off the part of the list a keyboard or a system bar covers', () => {
    const ime = '<node class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" bounds="[0,1500][1080,2400]" tapsmith-non-app="true"/>';
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('androidx.recyclerview.widget.RecyclerView', '[0,0][1080,2400]', scrollable)),
      ime,
      statusBar,
    );

    expect(scrollRegion(xml)).toEqual({ left: 0, top: 63, right: 1080, bottom: 1500 });
  });

  it('picks the largest scrollable: the page, not a carousel inside it', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('android.widget.ScrollView', '[0,63][1080,2400]', scrollable,
          node('android.widget.HorizontalScrollView', '[0,300][1080,700]', scrollable))),
    );

    expect(scrollRegion(xml)).toEqual({ left: 0, top: 63, right: 1080, bottom: 2400 });
  });

  it('picks an overlay drawn over the list in the same window, which takes the touch at the list\'s centre', () => {
    // A bottom sheet drawn by the app in the activity's window (later in the
    // tree, so on top) covering the middle of the list.
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('android.widget.ScrollView', '[0,63][1080,2400]', scrollable) +
        node('android.view.ViewGroup', '[0,1000][1080,2400]', '',
          node('android.widget.ScrollView', '[0,1100][1080,2300]', scrollable))),
    );

    expect(scrollRegion(xml)).toEqual({ left: 0, top: 1100, right: 1080, bottom: 2300 });
  });

  it('leaves out a scrollable too small to swipe in', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('android.widget.HorizontalScrollView', '[0,300][1080,330]', scrollable)),
    );

    expect(scrollRegion(xml)).toBeUndefined();
  });

  it('is undefined when nothing on screen scrolls, so the screen is swiped as before', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '', node('android.widget.TextView', '[0,100][1080,200]', 'text="Hi"')),
      statusBar,
    );

    expect(scrollRegion(xml)).toBeUndefined();
  });

  it('never picks a scrollable inside a non-app window', () => {
    const shade = '<node class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][1080,900]" tapsmith-non-app="true">' +
      '<node class="android.widget.ScrollView" package="com.android.systemui" bounds="[0,100][1080,800]" scrollable="true"/></node>';
    const xml = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', ''), shade);

    expect(scrollRegion(xml)).toBeUndefined();
  });
});

describe('scrollRegion — iOS (the element\'s frame is known)', () => {
  const row = (label: string, top: number) => el('Cell', `[0,${top}][402,${top + 44}]`, `label="${label}"`);

  it('picks the scroll view that holds an off-screen row, clipped to the screen', () => {
    // A sheet's scroll view, with the page's own scroll view behind it.
    const xml = ios(
      el('ScrollView', '[0,0][402,874]', '', row('Page row', 100)),
      el('ScrollView', '[20,400][382,800]', '', row('Visible', 420) + row('Max Calories', 1200)),
    );

    expect(scrollRegion(xml, { left: 0, top: 1200, right: 402, bottom: 1244 })).toEqual({ left: 20, top: 400, right: 382, bottom: 800 });
  });

  it('picks the nearest scrollable ancestor: a carousel on screen holding the element', () => {
    const xml = ios(
      el('ScrollView', '[0,0][402,874]', '',
        el('CollectionView', '[0,200][402,400]', '', el('Cell', '[600,200][800,400]', 'label="Card 4"'))),
    );

    expect(scrollRegion(xml, { left: 600, top: 200, right: 800, bottom: 400 })).toEqual({ left: 0, top: 200, right: 402, bottom: 400 });
  });

  it('goes past a scrollable ancestor that is itself off screen, to the one that can bring it on', () => {
    const xml = ios(
      el('ScrollView', '[0,0][402,874]', '',
        el('CollectionView', '[0,1400][402,1600]', '', el('Cell', '[0,1400][200,1600]', 'label="Card 1"'))),
    );

    expect(scrollRegion(xml, { left: 0, top: 1400, right: 200, bottom: 1600 })).toEqual({ left: 0, top: 0, right: 402, bottom: 874 });
  });

  it('matches the element\'s frame to within a point (frames are rounded)', () => {
    const xml = ios(
      el('Table', '[0,100][402,874]', '', row('Row 40', 2000)),
      el('ScrollView', '[0,0][402,100]', ''),
    );

    expect(scrollRegion(xml, { left: 1, top: 2001, right: 402, bottom: 2044 })).toEqual({ left: 0, top: 100, right: 402, bottom: 874 });
  });

  it('cuts off the part a keyboard covers', () => {
    const xml = ios(
      el('Table', '[0,0][402,874]', '', row('Row 40', 2000)),
      el('Keyboard', '[0,550][402,874]', 'tapsmith-non-app="true"'),
    );

    expect(scrollRegion(xml, { left: 0, top: 2000, right: 402, bottom: 2044 })).toEqual({ left: 0, top: 0, right: 402, bottom: 550 });
  });

  it('falls back to the largest scrollable on screen when the element is not in the dump', () => {
    const xml = ios(
      el('ScrollView', '[0,0][402,120]', ''),
      el('CollectionView', '[0,120][402,874]', ''),
    );

    expect(scrollRegion(xml, { left: 0, top: 3000, right: 402, bottom: 3044 })).toEqual({ left: 0, top: 120, right: 402, bottom: 874 });
    expect(scrollRegion(xml)).toEqual({ left: 0, top: 120, right: 402, bottom: 874 });
  });
});
