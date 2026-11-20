/**
 * In-page DOM helpers for WebView locators, shared by the CDP (Android) and
 * WebKit Inspector (iOS) paths, which both evaluate the same JS.
 *
 * Like Playwright's locators, these see into open shadow roots: Ionic,
 * Stencil, Lit and Shoelace render their native controls inside them. Closed
 * shadow roots stay out of reach (`element.shadowRoot` is null for them), as
 * in Playwright.
 *
 * Order is shadow-including tree order: an element, then the contents of its
 * open shadow root, then its own children. A CSS selector is matched within
 * each tree (the document and every open shadow root) separately, so its
 * combinators do not cross a shadow boundary: `ion-button button` finds
 * nothing, `button` finds the button inside every `ion-button`.
 *
 * @internal
 */

/** Elements whose text is not page text (Stencil puts a `<style>` in every shadow root). */
const SKIP_TEXT_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];

/**
 * A JS expression evaluating to the helper object. Self-contained, so every
 * finder that uses it stays a single expression.
 */
const HELPERS_JS = `(() => {
  const SKIP = new Set(${JSON.stringify(SKIP_TEXT_TAGS)});
  const CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  function all(root) {
    const out = [];
    const stack = [];
    const push = (parent) => { for (let c = parent.lastElementChild; c; c = c.previousElementSibling) stack.push(c); };
    push(root);
    while (stack.length) {
      const el = stack.pop();
      out.push(el);
      push(el);
      if (el.shadowRoot) push(el.shadowRoot);
    }
    return out;
  }
  function queryAll(css) {
    // The document first: an invalid selector throws here, as it always has,
    // even on a page with no elements to match.
    const light = document.querySelectorAll(css);
    const els = all(document);
    const roots = [];
    for (const el of els) if (el.shadowRoot) roots.push(el.shadowRoot);
    if (roots.length === 0) return Array.from(light);
    const hit = new Set(light);
    for (const r of roots) for (const el of r.querySelectorAll(css)) hit.add(el);
    return els.filter((el) => hit.has(el));
  }
  function first(css) {
    return queryAll(css)[0] ?? null;
  }
  function skipText(el) { return SKIP.has(el.nodeName.toUpperCase()); }
  function flatText(node, skipControls) {
    let s = '';
    const visit = (n) => {
      if (n.nodeType === 3) { s += n.data; return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        // Hidden from assistive technology, so not part of a name: an icon's
        // ligature text or SVG <title> (Material Web, ionicons 5).
        if (skipText(n) || (n !== node && n.getAttribute('aria-hidden') === 'true')) return;
        if (skipControls && CONTROLS.has(n.nodeName.toUpperCase())) return;
        if (n.nodeName.toUpperCase() === 'SLOT' && typeof n.assignedNodes === 'function') {
          for (const a of n.assignedNodes({ flatten: true })) visit(a);
          return;
        }
        if (n.shadowRoot) { for (const c of n.shadowRoot.childNodes) visit(c); return; }
      }
      for (const c of n.childNodes) visit(c);
    };
    visit(node);
    return s;
  }
  function labelFor(el) {
    if (!el.id) return null;
    return el.getRootNode().querySelector('label[for=' + JSON.stringify(el.id) + ']');
  }
  function labelledBy(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
    const root = el.getRootNode();
    const refs = ids.map((id) => root.getElementById ? root.getElementById(id) : null).filter(Boolean);
    return refs.length ? refs.map((r) => flatText(r).trim()).join(' ').trim() : null;
  }
  function wrappingLabel(el) {
    const wrapper = el.closest('label');
    // The label's text without its controls', read through slots: a
    // component's label often wraps a <slot> for the text.
    return wrapper ? flatText(wrapper, true).trim() : '';
  }
  function name(el) {
    const by = labelledBy(el);
    if (by !== null) return by;
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const lbl = labelFor(el);
    if (lbl) return flatText(lbl).trim();
    const wrapped = wrappingLabel(el);
    if (wrapped) return wrapped;
    const title = el.getAttribute('title');
    if (title) return title;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    return flatText(el).trim();
  }
  return { all, queryAll, first, skipText, flatText, labelledBy, labelFor, wrappingLabel, name };
})()`;

/**
 * Wrap `body` — an expression that may use `__ts` (the helper object) and
 * `document` — into one self-contained expression.
 */
export function withDomHelpers(body: string): string {
  return `((__ts) => (${body}))(${HELPERS_JS})`;
}

/** Expression: every element matching `css`, open shadow roots included, in tree order. */
export function deepQueryAllJs(css: string): string {
  return withDomHelpers(`__ts.queryAll(${JSON.stringify(css)})`);
}

/** Expression: the first element matching `css`, open shadow roots included, or null. */
export function deepQueryJs(css: string): string {
  return withDomHelpers(`__ts.first(${JSON.stringify(css)})`);
}
