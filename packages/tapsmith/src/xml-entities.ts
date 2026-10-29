/**
 * XML entity decoding for UI hierarchy dumps.
 *
 * Every hierarchy producer — the stock UIAutomator dump (which also writes a
 * newline as `&#10;`), the Android and iOS agents, and the WebView DOM walker —
 * XML-escapes attribute values. XML 1.0 has a closed set of references: the
 * five predefined entities plus decimal and hex character references, so this
 * covers all of them without a full XML parser (whose strictness the lenient
 * hierarchy parser deliberately avoids).
 *
 * Decoding is a single pass, so `&amp;lt;` becomes the literal text `&lt;`.
 * Anything that is not a well-formed reference to a valid code point (an
 * HTML-only entity like `&nbsp;`, a bare `&`, `&#0;`, a lone surrogate) is
 * left verbatim rather than guessed at.
 */

const PREDEFINED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const REFERENCE_RE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;

export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(REFERENCE_RE, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return PREDEFINED[name];
    const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

/** A Unicode scalar value other than NUL (XML forbids `&#0;`; lone surrogates are not characters). */
function isValidCodePoint(cp: number): boolean {
  return Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}
