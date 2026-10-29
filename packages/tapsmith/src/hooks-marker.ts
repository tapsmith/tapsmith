/**
 * The prefix of the `@tapsmith/react-native` hooks marker
 * (`tapsmith-hooks:<version>;epoch=<n>;…`), the text the in-app reset hooks
 * render into the accessibility tree. Tapsmith reads it from the hierarchy
 * dump (`parseHooksMarker`); no user locator ever matches it.
 * Kept in its own module so the browser bundles (trace viewer, UI mode) can
 * import it. Every other copy (the agents, the RN package, the daemon) is
 * pinned to this one by non-app-nodes.test.ts.
 */
export const HOOKS_MARKER_PREFIX = 'tapsmith-hooks:';
