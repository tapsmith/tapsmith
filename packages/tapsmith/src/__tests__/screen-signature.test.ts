import { describe, it, expect } from 'vitest';
import { onScreenSignature } from '../screen-signature.js';

// PILOT-929: scrollIntoView() compares what is on screen before and after a
// swipe. iOS also lists off-screen elements (UITableView keeps recycled cells
// in the tree above the screen and relabels them as it scrolls), so a whole
// dump keeps changing at the end of a list; only the on-screen part says
// whether the swipe moved anything.

const ios = (cells: string) => `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <Application label="App" type="Application" visible="true" bounds="[0,0][402,874]">
    <Table label="" type="Table" visible="true" bounds="[0,0][402,874]">
${cells}
    </Table>
  </Application>
</hierarchy>
`;
const cell = (label: string, top: number) =>
  `      <Cell label="${label}" type="Cell" visible="true" bounds="[0,${top}][402,${top + 44}]"/>`;

describe('onScreenSignature', () => {
  it('ignores an element entirely off the screen, so recycled cells above it do not count as a change', () => {
    const before = ios([cell('Row 11', -300), cell('Row 99', 700), cell('Row 100', 760)].join('\n'));
    const after = ios([cell('Row 15', -300), cell('Row 99', 700), cell('Row 100', 760)].join('\n'));

    expect(onScreenSignature(before)).toBe(onScreenSignature(after));
  });

  it('ignores an element entirely below or right of the screen', () => {
    const before = ios([cell('Row 1', 0), `      <Cell label="A" type="Cell" visible="true" bounds="[0,900][402,944]"/>`,
      `      <Cell label="B" type="Cell" visible="true" bounds="[500,10][600,54]"/>`].join('\n'));
    const after = ios([cell('Row 1', 0), `      <Cell label="X" type="Cell" visible="true" bounds="[0,900][402,944]"/>`,
      `      <Cell label="Y" type="Cell" visible="true" bounds="[500,10][600,54]"/>`].join('\n'));

    expect(onScreenSignature(before)).toBe(onScreenSignature(after));
  });

  it('sees an on-screen element move', () => {
    const before = ios([cell('Row 99', 700), cell('Row 100', 760)].join('\n'));
    const after = ios([cell('Row 99', 650), cell('Row 100', 710)].join('\n'));

    expect(onScreenSignature(before)).not.toBe(onScreenSignature(after));
  });

  it('sees an on-screen element change its text', () => {
    expect(onScreenSignature(ios(cell('Row 1', 100)))).not.toBe(onScreenSignature(ios(cell('Row 2', 100))));
  });

  it('counts an element partly on screen as on screen', () => {
    expect(onScreenSignature(ios(cell('Row 1', -20)))).not.toBe(onScreenSignature(ios(cell('Row 2', -20))));
  });

  it('takes the screen as the union of the top-level windows (Android lists one node per window)', () => {
    const android = (label: string) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" bounds="[0,0][1080,63]"/>
  <node index="0" text="" class="android.widget.FrameLayout" bounds="[0,63][1080,2400]">
    <node index="0" text="${label}" class="android.widget.TextView" bounds="[0,2300][1080,2390]"/>
  </node>
</hierarchy>`;

    expect(onScreenSignature(android('Item 30'))).not.toBe(onScreenSignature(android('Item 31')));
  });

  it('keeps elements without bounds', () => {
    const a = '<hierarchy><Application bounds="[0,0][10,10]"><Other label="a"/></Application></hierarchy>';
    const b = '<hierarchy><Application bounds="[0,0][10,10]"><Other label="b"/></Application></hierarchy>';

    expect(onScreenSignature(a)).not.toBe(onScreenSignature(b));
  });

  it('falls back to the whole dump when no element has bounds', () => {
    expect(onScreenSignature('<hierarchy><a x="1"/></hierarchy>')).not.toBe(onScreenSignature('<hierarchy><a x="2"/></hierarchy>'));
  });
});
