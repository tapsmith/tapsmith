import { describe, it, expect } from 'vitest';
import { hasScrollableContent, outsideRegion, pickScrollRegion, scrollRegion, visibleRegionOf } from '../scroll-container.js';

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

  it("ignores iOS 27's screen-sized empty toolbar host: it is no edge cover (PILOT-1251)", () => {
    const xml = ios(
      el('Toolbar', '[0,0][402,874]', 'label="Toolbar" identifier="Toolbar" tapsmith-empty-bar-host="true"', el('Other', '[0,0][402,874]', '')),
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

  it('keeps the previous region when the element is still moving, so its frame matches nothing in the dump', () => {
    // The probe saw Card 15 at x=2200; by the dump the carousel's momentum
    // had carried it to x=1798.
    const xml = ios(
      el('ScrollView', '[0,0][402,874]', '',
        el('CollectionView', '[0,200][402,400]', '', el('Cell', '[1798,200][1998,400]', 'label="Card 15"'))),
    );
    const carousel = { left: 0, top: 200, right: 402, bottom: 400 };

    expect(scrollRegion(xml, { left: 2200, top: 200, right: 2400, bottom: 400 }, carousel)).toEqual(carousel);
  });

  it('does not keep a previous region that is no longer a scrollable on screen', () => {
    const xml = ios(el('Table', '[0,100][402,874]', ''));

    expect(scrollRegion(xml, { left: 0, top: 3000, right: 402, bottom: 3044 }, { left: 0, top: 200, right: 402, bottom: 400 }))
      .toEqual({ left: 0, top: 100, right: 402, bottom: 874 });
  });

  it('clips a nested scrollable to its scrolling ancestor, so the swipe never starts on a header the ancestor scrolled it under', () => {
    // The outer list starts below a fixed header at y=155; carousel B has
    // scrolled up under it, and only y 155-260 of it shows.
    const xml = ios(
      el('Other', '[0,0][402,155]', 'label="Header"'),
      el('ScrollView', '[0,155][402,874]', '',
        el('CollectionView', '[16,60][386,260]', '', el('Cell', '[500,60][700,260]', 'label="Tile 18"'))),
    );

    expect(scrollRegion(xml, { left: 500, top: 60, right: 700, bottom: 260 })).toEqual({ left: 16, top: 155, right: 386, bottom: 260 });
  });

  it('says whether the region is the scrollable nearest the element or a farther one around it', () => {
    // A 40 pt chip row (too small to swipe in) inside a table: the table
    // contains the chip but scrolls the other way.
    const xml = ios(
      el('Table', '[0,100][402,874]', '',
        el('CollectionView', '[0,200][402,240]', '', el('Button', '[500,204][560,236]', 'label="Chip 9"')) +
        el('CollectionView', '[0,300][402,500]', '', el('Cell', '[420,300][620,500]', 'label="Tile 3"'))),
    );

    expect(pickScrollRegion(xml, { left: 420, top: 300, right: 620, bottom: 500 }))
      .toEqual({ region: { left: 0, top: 300, right: 402, bottom: 500 }, source: 'holds' });
    expect(pickScrollRegion(xml, { left: 500, top: 204, right: 560, bottom: 236 }))
      .toEqual({ region: { left: 0, top: 100, right: 402, bottom: 874 }, source: 'ancestor' });
    expect(pickScrollRegion(xml, { left: 0, top: 3000, right: 402, bottom: 3044 }).source).toBe('largest');
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

// PILOT-1324: scrollIntoView() takes a screen that a swipe did not change for
// the end of the content only when the scrollable it swiped in has content to
// scroll along the swipe; a screen still loading its list (a spinner, an empty
// table, a chip bar beside it) is waited for.
describe('hasScrollableContent', () => {
  const full = { left: 0, top: 0, right: 1080, bottom: 2400 };
  const listAt = { left: 0, top: 200, right: 1080, bottom: 2400 };

  it('is false for a screen with nothing scrollable on it (a spinner while a list loads)', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('android.widget.ProgressBar', '[480,1140][600,1260]')),
      statusBar,
    );
    expect(hasScrollableContent(xml, undefined, 'vertical')).toBe(false);
    expect(hasScrollableContent(xml, full, 'vertical')).toBe(false);
  });

  it('is true for the Android view swiped in, marked scrollable, which it is only while its content overflows it', () => {
    const xml = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '', node('androidx.recyclerview.widget.RecyclerView', '[0,200][1080,2400]', scrollable, node('android.widget.TextView', '[0,200][1080,400]', 'text="Row 1"') + node('android.widget.TextView', '[0,400][1080,600]', 'text="Row 2"'))));
    expect(hasScrollableContent(xml, listAt, 'vertical')).toBe(true);
  });

  it('finds the scrollable under the centre of a region its agent trimmed differently', () => {
    const xml = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '', node('androidx.recyclerview.widget.RecyclerView', '[0,200][1080,2400]', scrollable, node('android.widget.TextView', '[0,200][1080,400]', 'text="Row 1"') + node('android.widget.TextView', '[0,400][1080,600]', 'text="Row 2"'))));
    expect(hasScrollableContent(xml, { left: 0, top: 200, right: 1080, bottom: 2274 }, 'vertical')).toBe(true);
  });

  it('is false for a chip bar beside a list still loading: a vertical swipe in a horizontal list moves nothing', () => {
    const chip = (l: number) => node('android.widget.Button', `[${l},220][${l + 300},330]`, 'text="Chip"');
    const chipBar = { left: 0, top: 200, right: 1080, bottom: 350 };
    const xml = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
      node('androidx.recyclerview.widget.RecyclerView', '[0,200][1080,350]', scrollable, chip(20) + chip(340) + chip(660)) +
      node('android.widget.ProgressBar', '[480,1140][600,1260]')));
    expect(hasScrollableContent(xml, chipBar, 'vertical')).toBe(false);
    expect(hasScrollableContent(xml, chipBar, 'horizontal')).toBe(true);
    // A HorizontalScrollView says so by its class, whatever its one child.
    const hsv = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
      node('android.widget.HorizontalScrollView', '[0,200][1080,350]', scrollable, node('android.widget.LinearLayout', '[0,200][2400,350]'))));
    expect(hasScrollableContent(hsv, chipBar, 'vertical')).toBe(false);
  });

  it('is false up and down for a pager showing its one page, which it tells by its class', () => {
    const page = node('android.view.ViewGroup', '[0,350][1080,2400]', '', node('android.widget.ProgressBar', '[480,1140][600,1260]'));
    const pager = { left: 0, top: 350, right: 1080, bottom: 2400 };
    const vp2 = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
      node('androidx.viewpager2.widget.ViewPager2', '[0,350][1080,2400]', '',
        node('androidx.recyclerview.widget.RecyclerView', '[0,350][1080,2400]', scrollable, page))));
    expect(hasScrollableContent(vp2, pager, 'vertical')).toBe(false);
    expect(hasScrollableContent(vp2, pager, 'horizontal')).toBe(true);
    const vp = android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
      node('androidx.viewpager.widget.ViewPager', '[0,350][1080,2400]', scrollable, page)));
    expect(hasScrollableContent(vp, pager, 'vertical')).toBe(false);
  });

  // A scrollable is the end of its content unless it is seen to lie across
  // the swipe, so a list at its end fails promptly (PILOT-929) whatever its rows.
  const listEnd = (children: string) => android(node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
    node('androidx.recyclerview.widget.RecyclerView', '[0,200][1080,2400]', scrollable, children)));
  const cell = (b: string) => node('android.widget.TextView', b, 'text="Cell"');
  it.each([
    ['a two-column grid', cell('[0,200][540,700]') + cell('[540,200][1080,700]') + cell('[0,700][540,1200]') + cell('[540,700][1080,1200]') + cell('[0,1200][540,1700]')],
    ['a chat with bubbles at both edges', cell('[20,220][700,320]') + cell('[380,340][1060,440]') + cell('[20,460][700,560]')],
    ['a list with an inset header', cell('[40,200][1040,280]') + cell('[0,280][1080,480]') + cell('[0,480][1080,680]')],
    ['one tall card', cell('[0,200][1080,2400]')],
    ['rows its class does not name, under a Compose list', cell('[0,200][1080,400]') + cell('[0,400][1080,600]')],
  ])('is true up and down at the end of %s', (_name, children) => {
    expect(hasScrollableContent(listEnd(children), listAt, 'vertical')).toBe(true);
  });

  it('is false for a scrollable inside the system UI', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]'),
      '<node class="android.widget.ScrollView" package="com.android.systemui" bounds="[0,0][1080,600]" scrollable="true" tapsmith-non-app="true"/>',
    );
    expect(hasScrollableContent(xml, { left: 0, top: 0, right: 1080, bottom: 600 }, 'vertical')).toBe(false);
  });

  const table = { left: 0, top: 100, right: 402, bottom: 874 };

  it('is false for an empty iOS table, or a scroll view whose content fits inside it', () => {
    expect(hasScrollableContent(ios(el('Table', '[0,100][402,874]')), table, 'vertical')).toBe(false);
    expect(hasScrollableContent(ios(el('ScrollView', '[0,100][402,874]', '',
      el('Other', '[0,100][402,874]', '', el('ActivityIndicator', '[180,400][222,442]', 'label="In progress"')))), table, 'vertical')).toBe(false);
  });

  it('is true for an iOS scrollable whose content reaches past its frame along the swipe, either way', () => {
    expect(hasScrollableContent(ios(el('Table', '[0,100][402,874]', '',
      el('Cell', '[0,100][402,144]') + el('Cell', '[0,860][402,904]'))), table, 'vertical')).toBe(true);
    // At the end of a list: the rows it went past are above it.
    expect(hasScrollableContent(ios(el('ScrollView', '[0,100][402,874]', '',
      el('Other', '[0,-2400][402,874]'))), table, 'vertical')).toBe(true);
  });

  it('is false for an empty iOS table beside a carousel that does overflow, and for the carousel swiped up and down', () => {
    const xml = ios(
      el('CollectionView', '[0,100][402,300]', '', el('Cell', '[0,100][300,300]') + el('Cell', '[310,100][610,300]')),
      el('Table', '[0,300][402,874]'),
    );
    expect(hasScrollableContent(xml, { left: 0, top: 300, right: 402, bottom: 874 }, 'vertical')).toBe(false);
    expect(hasScrollableContent(xml, { left: 0, top: 100, right: 402, bottom: 300 }, 'vertical')).toBe(false);
    expect(hasScrollableContent(xml, { left: 0, top: 100, right: 402, bottom: 300 }, 'horizontal')).toBe(true);
  });

  it('is false for a dump with no bounds at all', () => {
    expect(hasScrollableContent('<hierarchy/>', full, 'vertical')).toBe(false);
  });
});

// PILOT-1370: an element can be "visible" (on screen) and still out of its
// list's view: iOS frames are not clipped, so a row just below a list, behind
// a bottom tab bar, reaches past the list's edge; and a bar the app lays over
// the list hides the rows under it on both platforms.
describe('visibleRegionOf', () => {
  /** An iPad-like React Native screen: a list above a tab bar, full-screen wrappers drawn after it. */
  const tabScreen = (rowFrame: string, extra = '') => ios(
    el('Other', '[0,0][402,874]', '',
      el('Other', '[0,0][402,800]', '',
        el('ScrollView', '[0,70][402,800]', '',
          el('Other', '[0,70][402,1400]', '', el('Other', rowFrame, 'identifier="counter plus button"'))) +
        // An empty toolbar host and a wrapper over the whole screen: not bars.
        el('Toolbar', '[0,0][402,800]', 'label="Toolbar" identifier="Toolbar" tapsmith-empty-bar-host="true"') +
        el('Other', '[0,0][402,874]', 'identifier=""'),
      ) +
      el('Other', '[0,800][402,874]', '',
        el('Button', '[0,800][201,874]', 'label="Catalog, tab, 1 of 2"') + el('Button', '[201,800][402,874]', 'label="Cart"')) +
      extra,
    ),
  );
  const list = { left: 0, top: 70, right: 402, bottom: 800 };

  it('is the list holding the element when nothing is drawn over it', () => {
    const frame = { left: 100, top: 800, right: 140, bottom: 840 };
    expect(visibleRegionOf(tabScreen('[100,800][140,840]'), frame)?.region).toEqual(list);
  });

  it('leaves out a bar the app draws over the bottom of the list', () => {
    const bar = el('Other', '[0,740][402,800]', '', el('Button', '[0,740][402,800]', 'label="Add to cart"'));
    const frame = { left: 100, top: 750, right: 140, bottom: 790 };
    expect(visibleRegionOf(tabScreen('[100,750][140,790]', bar), frame)?.region).toEqual({ ...list, bottom: 740 });
  });

  it('leaves out a header drawn over the top of the list', () => {
    const header = el('NavigationBar', '[0,70][402,130]', 'label="Catalog"');
    const frame = { left: 100, top: 80, right: 140, bottom: 120 };
    expect(visibleRegionOf(tabScreen('[100,80][140,120]', header), frame)?.region).toEqual({ ...list, top: 130 });
  });

  it('ignores an unnamed overlay, a narrow button and a tall sheet drawn over the list', () => {
    const overlays =
      el('Other', '[0,740][402,800]', '') + // nothing named in it: a background view
      el('Button', '[330,720][390,780]', 'label="Add"') + // a floating button, not across the list
      el('Other', '[0,300][402,800]', '', el('StaticText', '[0,300][402,340]', 'label="Sheet"')); // too tall for a bar
    const frame = { left: 100, top: 750, right: 140, bottom: 790 };
    expect(visibleRegionOf(tabScreen('[100,750][140,790]', overlays), frame)?.region).toEqual(list);
  });

  it('is undefined when the element matches nothing in the dump, or no scrollable holds it', () => {
    expect(visibleRegionOf(tabScreen('[100,800][140,840]'), { left: 1, top: 2, right: 3, bottom: 4 })).toBeUndefined();
    expect(visibleRegionOf(tabScreen('[100,800][140,840]'), { left: 0, top: 800, right: 201, bottom: 874 })).toBeUndefined();
  });

  it('leaves out two bars stacked over the bottom of the list, whichever the tree lists first', () => {
    const miniBar = el('Other', '[0,660][402,720]', '', el('Button', '[0,660][402,720]', 'label="Now playing"'));
    const checkout = el('Other', '[0,720][402,800]', '', el('Button', '[0,720][402,800]', 'label="Checkout"'));
    const frame = { left: 100, top: 670, right: 140, bottom: 710 };
    expect(visibleRegionOf(tabScreen('[100,670][140,710]', miniBar + checkout), frame)?.region).toEqual({ ...list, bottom: 660 });
    expect(visibleRegionOf(tabScreen('[100,670][140,710]', checkout + miniBar), frame)?.region).toEqual({ ...list, bottom: 660 });
  });

  it('leaves out a UIKit navigation bar, which XCUITest lists before the table it is drawn over', () => {
    const xml = ios(el('Other', '[0,0][402,874]', '',
      el('NavigationBar', '[0,24][402,82]', 'label="Native Screens"') +
      el('Other', '[0,0][402,874]', '', el('CollectionView', '[0,0][402,874]', '',
        el('Cell', '[0,40][402,90]', 'label="Row 3"') + el('Cell', '[0,90][402,1400]', 'label="Rest"'))),
    ));
    expect(visibleRegionOf(xml, { left: 0, top: 40, right: 402, bottom: 90 })?.region)
      .toEqual({ left: 0, top: 82, right: 402, bottom: 874 });
  });

  it('does not count the bars of a screen a sheet is presented over', () => {
    // The tab bar of the screen under the sheet is still in the tree, in its
    // own container; the sheet is drawn after it, at the window's level.
    const xml = ios(
      el('Other', '[0,0][402,874]', '',
        el('Other', '[0,0][402,874]', '') + el('TabBar', '[0,790][402,874]', '', el('Button', '[0,790][201,874]', 'label="Home"'))),
      el('Other', '[0,60][402,874]', '', el('Table', '[0,60][402,874]', '',
        el('Cell', '[0,800][402,850]', 'label="Last row"') + el('Cell', '[0,850][402,1400]', 'label="More"'))),
    );
    const view = visibleRegionOf(xml, { left: 0, top: 800, right: 402, bottom: 850 });
    expect(view?.region).toEqual({ left: 0, top: 60, right: 402, bottom: 874 });
    expect(outsideRegion({ left: 0, top: 800, right: 402, bottom: 850 }, view!.region, view)).toBeUndefined();
  });

  it('judges a carousel card below the list by the list, which scrolls the way the card lies', () => {
    const xml = ios(
      el('ScrollView', '[0,70][402,800]', '',
        el('Other', '[0,70][402,1400]', '',
          el('ScrollView', '[0,780][402,900]', '',
            el('Other', '[0,780][900,900]', '',
              el('Button', '[16,790][200,890]', 'label="Card 1"') + el('Button', '[216,790][400,890]', 'label="Card 2"'))))),
    );
    const card = { left: 16, top: 790, right: 200, bottom: 890 };
    const view = visibleRegionOf(xml, card);
    expect(view?.region).toEqual({ left: 0, top: 70, right: 402, bottom: 800 });
    expect(outsideRegion(card, view!.region, view)).toBe('down');
  });

  it('is only the nearest scrollable, never a farther one standing in for a chip bar too small to swipe in', () => {
    const xml = ios(
      el('ScrollView', '[0,70][402,800]', '',
        el('ScrollView', '[0,100][402,140]', '', el('Button', '[360,100][440,140]', 'label="Chip 7"')) +
        el('Other', '[0,140][402,1400]', '')),
    );
    expect(visibleRegionOf(xml, { left: 360, top: 100, right: 440, bottom: 140 })).toBeUndefined();
  });

  it('says which ways its scrollable has content to scroll', () => {
    const view = visibleRegionOf(tabScreen('[100,800][140,840]'), { left: 100, top: 800, right: 140, bottom: 840 });
    expect(view).toMatchObject({ vertical: true, horizontal: false });
  });

  it.each(['Table', 'CollectionView', 'ScrollView'])(
    'counts an iOS %s as scrolling up and down when the target is the only element past its edge',
    (type) => {
      const xml = ios(el('Other', '[0,0][402,874]', '',
        el(type, '[0,100][402,700]', '',
          el('Cell', '[0,100][402,650]', 'label="Row 1"') + el('Cell', '[0,650][402,750]', 'label="Row 2"')) +
        el('TabBar', '[0,700][402,874]', '', el('Button', '[0,700][201,874]', 'label="Home"')),
      ));
      const row = { left: 0, top: 650, right: 402, bottom: 750 };
      const view = visibleRegionOf(xml, row);
      expect(view?.region).toEqual({ left: 0, top: 100, right: 402, bottom: 700 });
      expect(outsideRegion(row, view!.region, view)).toBe('down');
    },
  );

  it("does not take a carousel's cards past the side for its list scrolling sideways", () => {
    const xml = ios(el('Other', '[0,0][402,874]', '',
      el('Table', '[0,100][402,700]', '',
        el('Cell', '[0,100][402,300]', '', el('CollectionView', '[0,110][402,290]', '',
          el('Cell', '[16,110][216,290]', 'label="Card 1"') + el('Cell', '[232,110][432,290]', 'label="Card 2"'))) +
        el('Cell', '[0,650][402,750]', 'label="Row 2"')) +
      el('TabBar', '[0,700][402,874]', '', el('Button', '[0,700][201,874]', 'label="Home"')),
    ));
    const row = { left: 0, top: 650, right: 402, bottom: 750 };
    const view = visibleRegionOf(xml, row);
    expect(view).toMatchObject({ vertical: true, horizontal: false });
    expect(outsideRegion(row, view!.region, view)).toBe('down');
  });

  it('does not nudge sideways in a list for a chip in a chip bar too small to swipe in, with more chips past the side', () => {
    const xml = ios(
      el('ScrollView', '[0,70][402,800]', '',
        el('ScrollView', '[0,100][402,140]', '',
          el('Button', '[360,100][440,140]', 'label="Chip 7"') + el('Button', '[450,100][530,140]', 'label="Chip 8"')) +
        el('Other', '[0,140][402,1400]', '')),
    );
    const chip = { left: 360, top: 100, right: 440, bottom: 140 };
    const view = visibleRegionOf(xml, chip);
    expect(view ? outsideRegion(chip, view.region, view) : undefined).toBeUndefined();
  });

  it.each(['CollectionView', 'ScrollView'])(
    'nudges up a row behind the tab bar of an iOS %s that runs under it, with content ending there',
    (type) => {
      const xml = ios(el('Other', '[0,0][402,874]', '',
        el(type, '[0,0][402,874]', '',
          el('StaticText', '[16,732][386,772]', 'label="Item 13"') + el('StaticText', '[16,772][386,812]', 'label="Item 14"')) +
        el('TabBar', '[0,790][402,874]', '', el('Button', '[0,790][201,874]', 'label="Home"')),
      ));
      const item = { left: 16, top: 772, right: 386, bottom: 812 };
      const view = visibleRegionOf(xml, item);
      expect(view?.region).toEqual({ left: 0, top: 0, right: 402, bottom: 790 });
      expect(outsideRegion(item, view!.region, view)).toBe('down');
    },
  );

  it("on Android, leaves out a bar in another window: the activity's bottom navigation under a sheet", () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,1200][1080,2400]', '',
        node('androidx.recyclerview.widget.RecyclerView', '[0,1200][1080,2400]', scrollable,
          node('android.widget.TextView', '[0,2250][1080,2400]', 'text="Last row"'))),
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('com.google.android.material.bottomnavigation.BottomNavigationView', '[0,2200][1080,2400]', '',
          node('android.widget.TextView', '[0,2200][540,2400]', 'text="Home"'))),
      statusBar,
    );
    expect(visibleRegionOf(xml, { left: 0, top: 2250, right: 1080, bottom: 2400 })?.region)
      .toEqual({ left: 0, top: 1200, right: 1080, bottom: 2400 });
  });

  it('on Android, leaves out a bottom bar laid over the list', () => {
    const xml = android(
      node('android.widget.FrameLayout', '[0,0][1080,2400]', '',
        node('androidx.recyclerview.widget.RecyclerView', '[0,200][1080,2400]', scrollable,
          node('android.widget.TextView', '[0,2250][1080,2350]', 'text="Row 9"')) +
        node('android.view.View', '[0,2200][1080,2400]', '', node('android.widget.Button', '[0,2200][540,2400]', 'text="Home"'))),
      statusBar,
    );
    expect(visibleRegionOf(xml, { left: 0, top: 2250, right: 1080, bottom: 2350 })?.region)
      .toEqual({ left: 0, top: 200, right: 1080, bottom: 2200 });
  });
});

describe('outsideRegion', () => {
  const region = { left: 0, top: 70, right: 402, bottom: 800 };

  it('says which way to scroll an element below, above, or beside the region', () => {
    expect(outsideRegion({ left: 100, top: 800, right: 140, bottom: 840 }, region)).toBe('down');
    expect(outsideRegion({ left: 100, top: 780, right: 140, bottom: 820 }, region)).toBe('down');
    expect(outsideRegion({ left: 100, top: 20, right: 140, bottom: 60 }, region)).toBe('up');
    expect(outsideRegion({ left: 380, top: 100, right: 450, bottom: 140 }, region)).toBe('right');
    expect(outsideRegion({ left: -40, top: 100, right: 20, bottom: 140 }, region)).toBe('left');
  });

  it('only along the axes the container scrolls on: no sideways nudge in a list that scrolls up and down', () => {
    expect(outsideRegion({ left: 380, top: 100, right: 450, bottom: 140 }, region, { vertical: true, horizontal: false }))
      .toBeUndefined();
    expect(outsideRegion({ left: 100, top: 800, right: 140, bottom: 840 }, region, { vertical: false, horizontal: true }))
      .toBeUndefined();
  });

  it('is undefined inside the region (within rounding), or for a frame spanning it', () => {
    expect(outsideRegion({ left: 0, top: 70, right: 402, bottom: 120 }, region)).toBeUndefined();
    expect(outsideRegion({ left: 0, top: 760, right: 402, bottom: 803 }, region)).toBeUndefined();
    expect(outsideRegion({ left: 0, top: 0, right: 402, bottom: 900 }, region)).toBeUndefined();
  });
});
