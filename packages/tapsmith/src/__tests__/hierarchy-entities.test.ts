import { describe, it, expect } from 'vitest';
import { decodeXmlEntities } from '../xml-entities.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { formatWithFixtureMatches } from './hierarchy-oracle.js';

// PILOT-658: every hierarchy producer (stock UIAutomator dump, the Android and
// iOS agents, the WebView DOM walker) XML-escapes attribute values. The shared
// parser must decode them, or the MCP snapshot shows `&amp;` and builds
// suggestions that match nothing, and the playground cannot match `&` (PILOT-619).

describe('decodeXmlEntities (PILOT-658)', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe('a & b <c> "d" \'e\'');
  });

  it('decodes decimal and hex character references, including astral code points', () => {
    expect(decodeXmlEntities('THE&#10;END')).toBe('THE\nEND');
    expect(decodeXmlEntities('it&#39;s &#x41;&#X42;')).toBe("it's AB");
    expect(decodeXmlEntities('&#x1F600;')).toBe('\u{1F600}');
    expect(decodeXmlEntities('a&#13;&#10;b&#9;c')).toBe('a\r\nb\tc');
  });

  it('decodes in a single pass, so an escaped entity stays literal', () => {
    expect(decodeXmlEntities('&amp;lt; &amp;#10; &amp;amp;')).toBe('&lt; &#10; &amp;');
  });

  it('leaves unknown, malformed and out-of-range references verbatim', () => {
    for (const s of ['&nbsp;', 'AT&T', '& ', '&#;', '&#x;', '&#0;', '&#x110000;', '&#xD800;', '&#99999999999;', '&amp']) {
      expect(decodeXmlEntities(s)).toBe(s);
    }
  });

  it('returns strings without references unchanged', () => {
    expect(decodeXmlEntities('')).toBe('');
    expect(decodeXmlEntities('plain text')).toBe('plain text');
  });
});

describe('parseHierarchyXml decodes attribute values (PILOT-658)', () => {
  it('decodes Android dump attributes', () => {
    const [root] = parseHierarchyXml(
      '<hierarchy><node class="android.widget.TextView" text="Support &amp; legal" ' +
      'content-desc="say &quot;hi&quot; &lt;3 it&#39;s" bounds="[0,0][10,10]" /></hierarchy>',
    );
    const node = root.children[0];
    expect(node.attributes.get('text')).toBe('Support & legal');
    expect(node.attributes.get('content-desc')).toBe('say "hi" <3 it\'s');
    expect(node.attributes.get('bounds')).toBe('[0,0][10,10]');
  });

  it('keeps a raw newline inside an attribute (the iOS agent does not escape one)', () => {
    const [root] = parseHierarchyXml('<XCUIElementTypeStaticText label="THE\nEND" />');
    expect(root.attributes.get('label')).toBe('THE\nEND');
  });
});

const SCREEN_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <node index="0" class="android.widget.TextView" text="Support &amp; legal" clickable="true" bounds="[0,100][1080,200]" />
    <node index="1" class="android.widget.TextView" text="9 October 2026&#10;5 pages" bounds="[0,200][1080,300]" />
    <node index="2" class="android.widget.TextView" text="THE&#10;END" tapsmith-role="heading" bounds="[0,300][1080,400]" />
    <node index="3" class="android.widget.Button" content-desc="Open &lt;settings&gt;" clickable="true" bounds="[0,400][1080,500]" />
    <node index="4" class="android.widget.TextView" text="Say &quot;hi&quot; &amp; it&#39;s fine" bounds="[0,500][1080,600]" />
    <node index="5" class="android.widget.TextView" text="Line&#13;&#10;break" bounds="[0,600][1080,700]" />
    <node index="6" class="android.widget.EditText" hint="Name &amp; surname" clickable="true" bounds="[0,700][1080,800]" />
    <node index="7" class="android.widget.EditText" hint="Email" clickable="true" bounds="[0,800][1080,900]" />
  </node>
</hierarchy>`;

describe('MCP snapshot formatter with XML-escaped text (PILOT-658)', () => {
  const roots = parseHierarchyXml(SCREEN_XML);
  const { tree, locators } = formatWithFixtureMatches(roots);

  it('shows decoded text in the tree, one line per node', () => {
    expect(tree).not.toMatch(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i);
    expect(tree).toContain('"Support & legal"');
    expect(tree).toContain('"Say \\"hi\\" & it\'s fine"');
    // A newline is shown escaped so the node stays on one tree line.
    expect(tree).toContain('heading "THE\\nEND"');
    expect(tree).toContain('"9 October 2026\\n5 pages"');
    expect(tree).toContain('"Line\\r\\nbreak"');
    expect(tree).toContain('placeholder="Name & surname"');
    expect(tree.split('\n').every((l) => /^\s*- /.test(l))).toBe(true);
  });

  it('builds suggestions from decoded values, escaped as JS string literals', () => {
    const all = locators.join('\n');
    expect(all).not.toMatch(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i);
    expect(all).toContain('"Support & legal"');
    expect(all).toContain('device.getByRole("heading", { name: "THE\\nEND" })');
    expect(all).toContain('"Open <settings>"');
    expect(all).toContain('"Say \\"hi\\" & it\'s fine"');
    expect(all).toContain('"Line\\r\\nbreak"');
    expect(all).toContain('"Name & surname"');
  });

  it('every suggestion is valid JS whose string values equal the decoded attribute', () => {
    expect(locators.length).toBe(8);
    for (const line of locators) {
      const code = line.replace(/^\[\d+\] /, '');
      // Parses as JavaScript: no raw newline / CR inside a string literal.
      expect(() => new Function('device', `return ${code};`)).not.toThrow();
    }
  });

  it('every suggestion resolves to exactly one node of the parsed tree', () => {
    for (const line of locators) {
      const code = line.replace(/^\[\d+\] /, '');
      const parsed = parseSelectorString(code);
      expect(parsed, code).not.toBeNull();
      expect(findMatchingNodes(roots, parsed!).length, code).toBe(1);
    }
  });
});

describe('playground matches decoded text (PILOT-619 entity half)', () => {
  const roots = parseHierarchyXml(SCREEN_XML);
  const count = (code: string) => findMatchingNodes(roots, parseSelectorString(code)!).length;

  it('matches the decoded string and RegExp, and not the encoded one', () => {
    expect(count('device.getByText("Support & legal")')).toBe(1);
    expect(count('device.getByText(/Support & legal/)')).toBe(1);
    expect(count('device.getByText("Support &amp; legal")')).toBe(0);
    expect(count('device.getByDescription("Open <settings>")')).toBe(1);
  });
});
