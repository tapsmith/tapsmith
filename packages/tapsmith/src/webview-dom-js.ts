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
 * The ARIA roles an element can have (Playwright's `validRoles`, Copyright
 * (c) Microsoft Corporation, Apache License 2.0; see THIRD_PARTY_NOTICES): what a
 * `role` attribute token must be to count, and the names webview.getByRole takes.
 */
export const ARIA_ROLES: readonly string[] = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion',
  'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'mark',
  'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist',
  'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
];

/**
 * Tapsmith's own role names, which `device.getByRole` uses too, and the ARIA
 * roles each finds in a WebView. Every other name is an ARIA role
 * ({@link ARIA_ROLES}), matched as Playwright matches it.
 */
export const WEBVIEW_ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  textfield: ['textbox', 'searchbox', 'spinbutton'],
  image: ['img'],
};

/**
 * Why webview.getByRole rejects `role`, or null when it takes it: the
 * runtime's error, which the Locator Playground shows too.
 */
export function unknownWebViewRoleMessage(role: string): string | null {
  if (webViewRolesFor(role)) return null;
  const aliases = Object.entries(WEBVIEW_ROLE_ALIASES).map(([alias, roles]) => `${alias} (${roles.join(', ')})`).join(', ');
  return `webview.getByRole(): unknown role ${JSON.stringify(role)}. WebView roles are ARIA roles (${ARIA_ROLES.join(', ')}), ` +
    `or Tapsmith's ${aliases}. For an element with a role attribute that is not an ARIA role, use webview.locator('[role="…"]').`;
}

/** The ARIA roles a webview.getByRole role name finds (case-insensitive), or undefined for an unknown name. */
export function webViewRolesFor(role: string): readonly string[] | undefined {
  const wanted = role.toLowerCase();
  // Own properties only: "constructor" is no alias.
  if (Object.prototype.hasOwnProperty.call(WEBVIEW_ROLE_ALIASES, wanted)) return WEBVIEW_ROLE_ALIASES[wanted];
  return ARIA_ROLES.includes(wanted) ? [wanted] : undefined;
}

/**
 * A JS expression evaluating to the helper object. Self-contained, so every
 * finder that uses it stays a single expression.
 */
const HELPERS_JS = `(() => {
  const SKIP = new Set(${JSON.stringify(SKIP_TEXT_TAGS)});
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
  // No element children. Not el.children: Stencil's scoped components
  // (ion-input) patch it to list only their slotted content.
  function isLeaf(el) { return el.firstElementChild === null; }
  // Hidden from assistive technology, which getByRole skips: Playwright's
  // isElementHiddenForAria (hiddenForAria below). An <option> of a dropdown
  // <select> has no box but is not hidden.
  function a11yHidden(el) {
    return hiddenForAria(el);
  }
  // ─── Roles, accessible names and labels, as Playwright computes them ───
  // Derived from Playwright v1.62.0's packages/injected/src/roleUtils.ts and
  // selectorUtils.ts (Copyright (c) Microsoft Corporation, Apache License
  // 2.0; see THIRD_PARTY_NOTICES), so webview.getByRole and webview.getByLabel
  // find what page.getByRole and page.getByLabel find. Modified by the
  // Tapsmith contributors: translated into this in-page script and adapted to
  // Tapsmith's locator options. Left out: CSS ::before/::after content,
  // aria-owns, and aria-describedby (no description matching).
  const tagOf = (el) => (el.localName || '').toUpperCase();
  const parentOrHost = (el) => el.parentElement || (el.parentNode && el.parentNode.nodeType === 11 ? el.parentNode.host : null);
  function closestCrossShadow(el, css) {
    for (let n = el; n;) {
      const hit = n.closest(css);
      if (hit) return hit;
      n = n.getRootNode().host || null;
    }
    return null;
  }
  function idRefs(el, ref) {
    if (!ref) return [];
    const root = el.getRootNode();
    if (!root.getElementById) return [];
    const out = [];
    for (const id of ref.split(' ').filter(Boolean)) {
      const hit = root.getElementById(id);
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  }
  function labelledByEls(el) {
    const ref = el.getAttribute('aria-labelledby');
    if (ref === null) return null;
    const refs = idRefs(el, ref);
    return refs.length ? refs : null;
  }
  const VALID_ROLES = new Set(${JSON.stringify(ARIA_ROLES)});
  const NAMING_PROHIBITED = ['caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph', 'presentation', 'strong', 'subscript', 'superscript'];
  const GLOBAL_ARIA = [['aria-atomic'], ['aria-busy'], ['aria-controls'], ['aria-current'], ['aria-describedby'], ['aria-details'],
    ['aria-dropeffect'], ['aria-flowto'], ['aria-grabbed'], ['aria-hidden'], ['aria-keyshortcuts'], ['aria-label', NAMING_PROHIBITED],
    ['aria-labelledby', NAMING_PROHIBITED], ['aria-live'], ['aria-owns'], ['aria-relevant'], ['aria-roledescription', ['generic']]];
  const hasGlobalAria = (el, forRole) => GLOBAL_ARIA.some(([attr, prohibited]) => !(prohibited && prohibited.includes(forRole || '')) && el.hasAttribute(attr));
  const hasTabIndex = (el) => !Number.isNaN(Number(String(el.getAttribute('tabindex'))));
  const nativelyDisabled = (el) => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(tagOf(el)) && el.hasAttribute('disabled');
  function nativelyFocusable(el) {
    const t = tagOf(el);
    if (['BUTTON', 'DETAILS', 'SELECT', 'TEXTAREA'].includes(t)) return true;
    if (t === 'A' || t === 'AREA') return el.hasAttribute('href');
    if (t === 'INPUT') return !el.hidden;
    return false;
  }
  const focusable = (el) => !nativelyDisabled(el) && (nativelyFocusable(el) || hasTabIndex(el));
  const hasExplicitName = (el) => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
  const NOT_LANDMARK_INSIDE = 'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';
  const INPUT_TYPE_ROLE = { button: 'button', checkbox: 'checkbox', image: 'button', number: 'spinbutton', radio: 'radio', range: 'slider', reset: 'button', submit: 'button' };
  const IMPLICIT = {
    A: (e) => e.hasAttribute('href') ? 'link' : null,
    AREA: (e) => e.hasAttribute('href') ? 'link' : null,
    ARTICLE: 'article', ASIDE: 'complementary', BLOCKQUOTE: 'blockquote', BUTTON: 'button', CAPTION: 'caption',
    CODE: 'code', DATALIST: 'listbox', DD: 'definition', DEL: 'deletion', DETAILS: 'group', DFN: 'term',
    DIALOG: 'dialog', DT: 'term', EM: 'emphasis', FIELDSET: 'group', FIGURE: 'figure',
    FOOTER: (e) => closestCrossShadow(e, NOT_LANDMARK_INSIDE) ? null : 'contentinfo',
    FORM: (e) => hasExplicitName(e) ? 'form' : null,
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    HEADER: (e) => closestCrossShadow(e, NOT_LANDMARK_INSIDE) ? null : 'banner',
    HR: 'separator', HTML: 'document',
    IMG: (e) => e.getAttribute('alt') === '' && !e.getAttribute('title') && !hasGlobalAria(e) && !hasTabIndex(e) ? 'presentation' : 'img',
    INPUT: (e) => {
      const type = String(e.type || '').toLowerCase();
      if (['email', 'search', 'tel', 'text', 'url', ''].includes(type)) {
        const list = idRefs(e, e.getAttribute('list'))[0];
        if (list && tagOf(list) === 'DATALIST') return 'combobox';
        return type === 'search' ? 'searchbox' : 'textbox';
      }
      if (type === 'hidden') return null;
      if (type === 'file') return 'button';
      return INPUT_TYPE_ROLE[type] || 'textbox';
    },
    INS: 'insertion', LI: 'listitem', MAIN: 'main', MARK: 'mark', MATH: 'math', MENU: 'list', METER: 'meter',
    NAV: 'navigation', OL: 'list', OPTGROUP: 'group', OPTION: 'option', OUTPUT: 'status', P: 'paragraph',
    PROGRESS: 'progressbar', SEARCH: 'search',
    SECTION: (e) => hasExplicitName(e) ? 'region' : null,
    SELECT: (e) => e.hasAttribute('multiple') || e.size > 1 ? 'listbox' : 'combobox',
    STRONG: 'strong', SUB: 'subscript', SUP: 'superscript', SVG: 'img', TABLE: 'table', TBODY: 'rowgroup',
    TD: (e) => {
      const table = closestCrossShadow(e, 'table');
      const r = table ? explicitRole(table) : '';
      return r === 'grid' || r === 'treegrid' ? 'gridcell' : 'cell';
    },
    TEXTAREA: 'textbox', TFOOT: 'rowgroup',
    TH: (e) => {
      const scope = e.getAttribute('scope');
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      // Without a scope, as Chromium reads it from the neighbouring cells.
      const next = e.nextElementSibling;
      const prev = e.previousElementSibling;
      if (!next && !prev) {
        // The only cell of a one-row table heads nothing.
        const row = e.parentElement && tagOf(e.parentElement) === 'TR' ? e.parentElement : null;
        const table = row ? closestCrossShadow(row, 'table') : null;
        if (table && table.rows.length <= 1) return null;
        return 'columnheader';
      }
      const isHeader = (c) => !!c && tagOf(c) === 'TH';
      const isDataCell = (c) => !!c && tagOf(c) === 'TD' && !!((c.textContent || '').trim() || c.children.length > 0);
      if (isHeader(next) && isHeader(prev)) return 'columnheader';
      if (isDataCell(next) || isDataCell(prev)) return 'rowheader';
      return 'columnheader';
    },
    THEAD: 'rowgroup', TIME: 'time', TR: 'row', UL: 'list',
  };
  const PRESENTATION_PARENTS = { DD: ['DL', 'DIV'], DIV: ['DL'], DT: ['DL', 'DIV'], LI: ['OL', 'UL'], TBODY: ['TABLE'],
    TD: ['TR'], TFOOT: ['TABLE'], TH: ['TR'], THEAD: ['TABLE'], TR: ['THEAD', 'TBODY', 'TFOOT', 'TABLE'] };
  function explicitRole(el) {
    const roles = (el.getAttribute('role') || '').split(' ').map((r) => r.trim());
    return roles.find((r) => VALID_ROLES.has(r)) || null;
  }
  const presentationConflict = (el, r) => hasGlobalAria(el, r) || focusable(el);
  function implicitRole(el) {
    const entry = IMPLICIT[tagOf(el)];
    const found = typeof entry === 'function' ? entry(el) : (entry || null);
    if (!found) return null;
    // A list item or table part of a presentational list or table is presentational too.
    for (let a = el; a;) {
      const parent = parentOrHost(a);
      const parents = PRESENTATION_PARENTS[tagOf(a)];
      if (!parents || !parent || !parents.includes(tagOf(parent))) break;
      const pr = explicitRole(parent);
      if ((pr === 'none' || pr === 'presentation') && !presentationConflict(parent, pr)) return pr;
      a = parent;
    }
    return found;
  }
  /** The element's ARIA role: its first valid role attribute token, else its tag's implicit role. */
  function role(el) {
    const ex = explicitRole(el);
    if (!ex) return implicitRole(el);
    if (ex === 'none' || ex === 'presentation') {
      const im = implicitRole(el);
      if (presentationConflict(el, im)) return im;
    }
    return ex;
  }
  // Per evaluation (the helpers are rebuilt for every expression, and a
  // finder does not change the page), as Playwright caches them: a name
  // walks a subtree, and each node of it its ancestors.
  const styleCache = new Map();
  const hiddenCache = new Map();
  function styleOf(el) {
    let style = styleCache.get(el);
    if (style === undefined) {
      style = getComputedStyle(el);
      styleCache.set(el, style);
    }
    return style;
  }
  // Hidden from assistive technology, for the accessible name's traversal.
  function belongsToHidden(el) {
    let hidden = hiddenCache.get(el);
    if (hidden !== undefined) return hidden;
    // A shadow host's child that no slot takes is not rendered.
    hidden = !!(el.parentElement && el.parentElement.shadowRoot && !el.assignedSlot);
    if (!hidden) {
      const style = styleOf(el);
      hidden = !style || style.display === 'none' || (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';
    }
    if (!hidden) {
      const parent = parentOrHost(el);
      if (parent) hidden = belongsToHidden(parent);
    }
    hiddenCache.set(el, hidden);
    return hidden;
  }
  // A text node with a box of its own, as Playwright's isVisibleTextNode.
  function visibleText(node) {
    const range = node.ownerDocument.createRange();
    if (typeof range.getBoundingClientRect !== 'function') return !!(node.data || '').trim();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function hiddenForAria(el) {
    if (skipText(el)) return true;
    const style = styleOf(el);
    const isSlot = el.nodeName === 'SLOT';
    if (style && style.display === 'contents' && !isSlot) {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && !hiddenForAria(c)) return false;
        if (c.nodeType === 3 && visibleText(c)) return false;
      }
      return true;
    }
    const optionInSelect = el.nodeName === 'OPTION' && !!el.closest('select');
    if (!optionInSelect && !isSlot && style && (style.visibility === 'hidden' || style.visibility === 'collapse')) return true;
    return belongsToHidden(el);
  }
  const ALWAYS_NAME_FROM_CONTENT = ['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem'];
  const DESCENDANT_NAME_FROM_CONTENT = ['', 'caption', 'code', 'contentinfo', 'definition', 'deletion', 'emphasis', 'insertion',
    'list', 'listitem', 'mark', 'none', 'paragraph', 'presentation', 'region', 'row', 'rowgroup', 'section', 'strong',
    'subscript', 'superscript', 'table', 'term', 'time'];
  const allowsNameFromContent = (r, descendant) => ALWAYS_NAME_FROM_CONTENT.includes(r) || (descendant && DESCENDANT_NAME_FROM_CONTENT.includes(r));
  const NAME_PROHIBITED_ROLES = ['caption', 'code', 'definition', 'deletion', 'emphasis', 'generic', 'insertion', 'mark',
    'paragraph', 'presentation', 'strong', 'subscript', 'suggestion', 'superscript', 'term', 'time'];
  const labelsOf = (el) => Array.from(el.labels || []);
  function fromLabels(labels, o) {
    return labels.map((l) => alt(l, Object.assign({}, o, { label: { hidden: hiddenForAria(l) }, native: undefined, labelledBy: undefined, inTarget: undefined })))
      .filter(Boolean).join(' ');
  }
  function firstChildTagged(el, t) {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (tagOf(c) === t) return c;
    return null;
  }
  function contentText(el, o) {
    let s = '';
    const visit = (n, skipSlotted) => {
      if (skipSlotted && n.assignedSlot) return;
      if (n.nodeType === 1) {
        const style = styleOf(n);
        let token = alt(n, o);
        if ((style && style.display || 'inline') !== 'inline' || n.nodeName === 'BR') token = ' ' + token + ' ';
        s += token;
      } else if (n.nodeType === 3) {
        s += n.textContent || '';
      }
    };
    const assigned = el.nodeName === 'SLOT' && typeof el.assignedNodes === 'function' ? el.assignedNodes() : [];
    if (assigned.length) {
      for (const c of assigned) visit(c, false);
    } else {
      for (let c = el.firstChild; c; c = c.nextSibling) visit(c, true);
      if (el.shadowRoot) for (let c = el.shadowRoot.firstChild; c; c = c.nextSibling) visit(c, true);
    }
    return s;
  }
  // The accessible name computation (accname 1.2), as Playwright's
  // getTextAlternativeInternal: o.inTarget is 'self' for the element being
  // named and 'descendant' below it; o.label / o.labelledBy / o.native mark a
  // traversal into a <label>, an aria-labelledby target or a native
  // alternative (legend, figcaption, caption, svg title).
  function alt(el, o) {
    if (o.visited.has(el)) return '';
    const child = Object.assign({}, o, { inTarget: o.inTarget === 'self' ? 'descendant' : o.inTarget });
    if (!o.includeHidden) {
      const inHiddenReference = !!(o.labelledBy && o.labelledBy.hidden) || !!(o.native && o.native.hidden) || !!(o.label && o.label.hidden);
      if (skipText(el) || (!inHiddenReference && hiddenForAria(el))) {
        o.visited.add(el);
        return '';
      }
    }
    const by = labelledByEls(el);
    if (!o.labelledBy) {
      // An aria-labelledby whose targets have no text falls through to the next source.
      const s = (by || []).map((ref) => alt(ref, Object.assign({}, o, {
        labelledBy: { hidden: hiddenForAria(ref) }, inTarget: undefined, label: undefined, native: undefined,
      }))).join(' ');
      if (s) return s;
    }
    const r = role(el) || '';
    const t = tagOf(el);
    if (o.label || o.labelledBy || o.inTarget === 'descendant') {
      // A control inside a label or name contributes its value.
      if (!(by || []).includes(el)) {
        // Never a password's value, whatever role it is given: names go into
        // the hierarchy dump and traces.
        if (t === 'INPUT' && String(el.type || '').toLowerCase() === 'password'
          && ['textbox', 'combobox', 'listbox', 'progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(r)) {
          o.visited.add(el);
          return '';
        }
        if (r === 'textbox') {
          o.visited.add(el);
          return t === 'INPUT' || t === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
        }
        if (r === 'combobox' || r === 'listbox') {
          o.visited.add(el);
          let selected;
          if (t === 'SELECT') {
            selected = Array.from(el.selectedOptions || []);
            if (!selected.length && el.options && el.options.length) selected.push(el.options[0]);
          } else {
            const listbox = r === 'combobox' ? Array.from(el.querySelectorAll('*')).find((e) => role(e) === 'listbox') : el;
            selected = listbox ? Array.from(listbox.querySelectorAll('[aria-selected="true"]')).filter((e) => role(e) === 'option') : [];
          }
          if (!selected.length && t === 'INPUT') return el.value || '';
          return selected.map((op) => alt(op, child)).join(' ');
        }
        if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(r)) {
          o.visited.add(el);
          if (el.hasAttribute('aria-valuetext')) return el.getAttribute('aria-valuetext');
          if (el.hasAttribute('aria-valuenow')) return el.getAttribute('aria-valuenow');
          return el.getAttribute('value') || '';
        }
        if (r === 'menu') {
          o.visited.add(el);
          return '';
        }
      }
    }
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) {
      o.visited.add(el);
      return ariaLabel;
    }
    if (r !== 'presentation' && r !== 'none') {
      const type = t === 'INPUT' ? String(el.type || '').toLowerCase() : '';
      const title = el.getAttribute('title') || '';
      if (t === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) {
        o.visited.add(el);
        const value = el.value || '';
        if (value.trim()) return value;
        if (type === 'submit') return 'Submit';
        if (type === 'reset') return 'Reset';
        return title;
      }
      if (t === 'INPUT' && type === 'file') {
        o.visited.add(el);
        const labels = labelsOf(el);
        if (labels.length && !o.labelledBy) return fromLabels(labels, o);
        return 'Choose File';
      }
      if (t === 'INPUT' && type === 'image') {
        o.visited.add(el);
        const labels = labelsOf(el);
        if (labels.length && !o.labelledBy) return fromLabels(labels, o);
        const altText = el.getAttribute('alt') || '';
        if (altText.trim()) return altText;
        if (title.trim()) return title;
        return 'Submit';
      }
      if (!by && t === 'BUTTON') {
        o.visited.add(el);
        const labels = labelsOf(el);
        if (labels.length) return fromLabels(labels, o);
      }
      if (!by && t === 'OUTPUT') {
        o.visited.add(el);
        const labels = labelsOf(el);
        if (labels.length) return fromLabels(labels, o);
        return title;
      }
      if (!by && ['TEXTAREA', 'SELECT', 'INPUT', 'METER', 'PROGRESS'].includes(t)) {
        o.visited.add(el);
        const labels = labelsOf(el);
        if (labels.length) return fromLabels(labels, o);
        // A title outranks a placeholder.
        const usePlaceholder = (t === 'INPUT' && ['text', 'password', 'number', 'search', 'tel', 'email', 'url'].includes(type)) || t === 'TEXTAREA';
        if (!usePlaceholder || title) return title;
        return el.getAttribute('placeholder') || '';
      }
      for (const [host, caption] of [['FIELDSET', 'LEGEND'], ['FIGURE', 'FIGCAPTION']]) {
        if (by || t !== host) continue;
        o.visited.add(el);
        const c = firstChildTagged(el, caption);
        if (c) return alt(c, Object.assign({}, child, { native: { hidden: hiddenForAria(c) } }));
        return title;
      }
      if (t === 'IMG' || t === 'AREA') {
        o.visited.add(el);
        const altText = el.getAttribute('alt') || '';
        if (altText.trim()) return altText;
        return title;
      }
      if (t === 'TABLE') {
        o.visited.add(el);
        const c = firstChildTagged(el, 'CAPTION');
        if (c) return alt(c, Object.assign({}, child, { native: { hidden: hiddenForAria(c) } }));
        const summary = el.getAttribute('summary') || '';
        if (summary) return summary;
      }
      if (t === 'SVG' || el.ownerSVGElement) {
        o.visited.add(el);
        for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
          if (tagOf(c) === 'TITLE' && c.ownerSVGElement) return alt(c, Object.assign({}, child, { labelledBy: { hidden: hiddenForAria(c) } }));
        }
      }
    }
    const summaryContent = t === 'SUMMARY' && r !== 'presentation' && r !== 'none';
    if (allowsNameFromContent(r, o.inTarget === 'descendant') || summaryContent || o.labelledBy || o.label || o.native) {
      o.visited.add(el);
      const s = contentText(el, child);
      if (o.inTarget === 'self' ? s.trim() : s) return s;
    }
    // Last, a tooltip: content outranks a title.
    if ((r !== 'presentation' && r !== 'none') || t === 'IFRAME' || t === 'FRAME') {
      o.visited.add(el);
      const title = el.getAttribute('title') || '';
      if (title.trim()) return title;
    }
    o.visited.add(el);
    return '';
  }
  // Whitespace as Playwright normalises it: zero-width spaces and soft
  // hyphens out first, so neither hides an end's whitespace from the trim.
  const norm = (s) => String(s).replace(/[\\u200b\\u00ad]/g, '').trim().replace(/\\s+/g, ' ');
  /** The element's accessible name, whitespace-normalised. */
  function name(el, includeHidden) {
    if (NAME_PROHIBITED_ROLES.includes(role(el) || '')) return '';
    return norm(alt(el, { includeHidden: !!includeHidden, visited: new Set(), inTarget: 'self' }));
  }
  // A label's text: its text content, through open shadow roots.
  function elementText(root) {
    if (root.nodeType === 1 && (skipText(root) || (document.head && document.head.contains(root)))) return '';
    if (tagOf(root) === 'INPUT' && ['submit', 'button', 'reset'].includes(root.type)) return root.value || '';
    let s = '';
    for (let c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue || '';
      else if (c.nodeType === 1) s += elementText(c);
    }
    if (root.shadowRoot) s += elementText(root.shadowRoot);
    return s;
  }
  /**
   * The texts getByLabel matches an element by, as Playwright's
   * getElementLabels: its aria-labelledby targets', else its aria-label, else
   * its <label>s' (for= or wrapping) — the last only for a labelable control.
   */
  function labelTexts(el) {
    const by = labelledByEls(el);
    if (by) return by.map(elementText);
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim()) return [ariaLabel];
    const t = tagOf(el);
    if (['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'].includes(t) || (t === 'INPUT' && el.type !== 'hidden')) {
      return labelsOf(el).map(elementText);
    }
    return [];
  }
  /**
   * Whether text matches m: { s, exact } — a case-insensitive substring by
   * default, the whole string case-sensitively with exact — or { re, flags }.
   * Whitespace is normalised on both sides; a RegExp tests the normalised
   * text, or the raw text when raw is set (Playwright's text matcher).
   */
  function textMatch(text, m, raw) {
    if (m.re !== undefined) return new RegExp(m.re, m.flags).test(raw ? String(text) : norm(text));
    const v = norm(text);
    const s = norm(m.s);
    return m.exact ? v === s : v.toLowerCase().includes(s.toLowerCase());
  }
  return { all, queryAll, first, skipText, isLeaf, a11yHidden, role, name, labelTexts, textMatch, norm };
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
