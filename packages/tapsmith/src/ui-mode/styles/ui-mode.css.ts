// UI mode stylesheet — v2 design system (oklch tokens, 3-col grid, Inter + JetBrains Mono)

export const uiModeStyles = `
/* ─── Design Tokens ─── */

:root {
  --accent-h: 57;
  --accent: oklch(0.74 0.135 var(--accent-h));
  --accent-dim: oklch(0.64 0.115 var(--accent-h));
  --accent-bg: oklch(0.74 0.135 var(--accent-h) / 0.14);
  /* Device tags: lightness/chroma per theme, hue per device (--device-h, see deviceHue). */
  --device-tag-bg-l: 0.42; --device-tag-bg-c: 0.09; --device-tag-fg-l: 0.93; --device-tag-fg-c: 0.05;
  --pass: oklch(0.78 0.15 155);
  --fail: oklch(0.68 0.2 25);
  --skip: oklch(0.7 0.02 250);
  --run: oklch(0.75 0.12 240);
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --density: 1;
  --row-h: calc(28px * var(--density));
  --pad: calc(12px * var(--density));

  /* Legacy aliases (mapped to new tokens for existing components) */
  --font-ui: var(--font-sans);
  --color-accent: var(--accent);
  --color-success: var(--pass);
  --color-error: var(--fail);
  --color-warning: oklch(0.75 0.14 80);
  --color-skipped: var(--skip);
}

[data-theme="dark"], :root {
  /* Warm neutral palette — matches the Tapsmith website dark theme (#1e1b18 / #e8e4df / #302b25) */
  --bg: oklch(0.21 0.006 66);
  --bg-elev: oklch(0.235 0.007 66);
  --bg-elev-2: oklch(0.265 0.008 66);
  --bg-hover: oklch(0.29 0.009 66);
  --bg-active: oklch(0.33 0.011 66);
  --border: oklch(0.295 0.012 70);
  --border-strong: oklch(0.4 0.013 68);
  --fg: oklch(0.921 0.008 74);
  --fg-dim: oklch(0.74 0.008 72);
  --fg-muted: oklch(0.56 0.008 70);
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.25);
  --grid-line: oklch(0.29 0.009 66 / 0.5);

  /* Legacy aliases */
  --bg-primary: var(--bg);
  --bg-secondary: var(--bg-elev);
  --bg-tertiary: var(--bg-elev-2);
  --bg-selected: oklch(0.3 0.035 57);
  --border-light: var(--border-strong);
  --color-text: var(--fg);
  --color-text-muted: var(--fg-dim);
  --color-text-faint: var(--fg-muted);
  --color-text-faintest: oklch(0.42 0.007 70);
  --color-topbar-bg: var(--bg-elev);
  --color-bg: var(--bg);
  --color-bg-secondary: var(--bg-elev);
  --color-bg-tertiary: var(--bg-elev-2);
  --color-bg-hover: var(--bg-hover);
  --color-bg-selected: oklch(0.3 0.035 57);
  --color-bg-group: oklch(0.235 0.007 66);
  --color-border: var(--border);
  --color-text-primary: var(--fg);
  --color-text-secondary: oklch(0.85 0.007 73);
  --color-accent-hover: oklch(0.81 0.13 var(--accent-h));
  --color-accent-dim: var(--accent-dim);
  --color-string: oklch(0.75 0.1 50);
  --color-keyword: oklch(0.72 0.12 240);
  --color-function: oklch(0.82 0.08 90);
  --color-number: oklch(0.78 0.1 145);
  --color-attr: oklch(0.8 0.1 220);
  --color-highlight: oklch(0.74 0.135 var(--accent-h) / 0.12);
  --color-error-bg: oklch(0.22 0.03 25);
  --color-error-border: oklch(0.4 0.08 25 / 0.4);
  --color-spinner-track: oklch(0.32 0.006 66);
}

[data-theme="light"] {
  --bg: oklch(0.985 0.003 80);
  --bg-elev: oklch(1 0 0);
  --bg-elev-2: oklch(0.975 0.004 80);
  --bg-hover: oklch(0.95 0.005 80);
  --bg-active: oklch(0.92 0.007 80);
  --border: oklch(0.93 0.004 80);
  --border-strong: oklch(0.86 0.005 80);
  --fg: oklch(0.2 0.01 250);
  --fg-dim: oklch(0.4 0.01 250);
  --fg-muted: oklch(0.58 0.008 250);
  --shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.04);
  --grid-line: oklch(0.9 0.005 80 / 0.7);

  /* Legacy aliases */
  --bg-primary: var(--bg);
  --bg-secondary: var(--bg-elev);
  --bg-tertiary: var(--bg-elev-2);
  --bg-selected: oklch(0.93 0.03 240);
  --border-light: var(--border-strong);
  --color-text: var(--fg);
  --color-text-muted: var(--fg-dim);
  --color-text-faint: var(--fg-muted);
  --color-text-faintest: oklch(0.76 0.005 250);
  --color-topbar-bg: var(--bg-elev);
  --color-bg: var(--bg);
  --color-bg-secondary: var(--bg-elev);
  --color-bg-tertiary: var(--bg-elev-2);
  --color-bg-hover: var(--bg-hover);
  --color-bg-selected: oklch(0.93 0.03 240);
  --color-bg-group: oklch(0.97 0.005 240);
  --color-border: var(--border);
  --color-text-primary: var(--fg);
  --color-text-secondary: oklch(0.3 0.008 250);
  --color-accent-hover: oklch(0.7 0.14 var(--accent-h));
  --color-accent-dim: oklch(0.88 0.06 var(--accent-h));
  --device-tag-bg-l: 0.9; --device-tag-bg-c: 0.07; --device-tag-fg-l: 0.36; --device-tag-fg-c: 0.11;
  --color-string: oklch(0.45 0.12 25);
  --color-keyword: oklch(0.45 0.15 260);
  --color-function: oklch(0.42 0.08 80);
  --color-number: oklch(0.4 0.12 155);
  --color-attr: oklch(0.35 0.08 250);
  --color-highlight: oklch(0.78 0.15 var(--accent-h) / 0.1);
  --color-error-bg: oklch(0.96 0.02 25);
  --color-error-border: oklch(0.68 0.1 25 / 0.3);
  --color-spinner-track: oklch(0.9 0.003 80);
}

/* ─── Reset & Base ─── */

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 13px;
  letter-spacing: -0.005em;
  font-feature-settings: 'cv11' 1, 'ss01' 1;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ─── Utilities ─── */

.mono { font-family: var(--font-mono); }
.hide { display: none !important; }

/* ─── Animations ─── */

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes flash-fail {
  0% { background: oklch(0.68 0.2 25 / 0.3); }
  100% { background: transparent; }
}
@keyframes ringPulse {
  0% { box-shadow: 0 0 0 0 oklch(0.78 0.15 var(--accent-h) / 0.4); }
  70% { box-shadow: 0 0 0 6px oklch(0.78 0.15 var(--accent-h) / 0); }
  100% { box-shadow: 0 0 0 0 oklch(0.78 0.15 var(--accent-h) / 0); }
}

/* ─── Layout (legacy flex + new grid) ─── */

.ui-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.ui-topbar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
}

.ui-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.ui-explorer {
  flex: 0 0 auto;
  overflow-y: auto;
  background: var(--bg);
}

.ui-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.ui-filmstrip {
  flex: 0 0 auto;
  overflow: hidden;
}

.ui-middle {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.ui-actions {
  flex: 0 0 auto;
  overflow-y: auto;
}

.ui-screenshot {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.ui-detail {
  flex: 0 0 auto;
  overflow: hidden;
}

/* ─── Shell (v2 3-column grid) ─── */

.shell {
  display: grid;
  grid-template-columns: 280px 1fr 380px;
  grid-template-rows: minmax(0, 1fr);
  height: calc(100vh - 48px);
  background: var(--bg);
  overflow: hidden;
}
.shell.layout-device-first { grid-template-columns: 260px 1fr 440px; }
.shell.layout-focus { grid-template-columns: 260px 1fr; }
.shell.layout-focus .device-col { display: none; }

.col {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ─── Resize Handle ─── */

.ui-resize-handle {
  flex: 0 0 1px;
  background: var(--border);
  transition: background 0.15s;
  position: relative;
  z-index: 10;
}
.ui-resize-handle::before {
  content: '';
  position: absolute;
  inset: 0;
}
.ui-resize-handle:hover { background: var(--accent); }
.ui-resize-handle:active { background: var(--accent); }

.ui-resize-col { cursor: col-resize; }
.ui-resize-col::before { left: -3px; right: -3px; top: 0; bottom: 0; }

.ui-resize-row { cursor: row-resize; }
.ui-resize-row::before { top: -3px; bottom: -3px; left: 0; right: 0; }

/* ─── Top Rail ─── */

.rail {
  height: 48px;
  display: flex;
  align-items: center;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  padding: 0 var(--pad);
  gap: var(--pad);
}

/* ─── Run Controls (Top Bar) ─── */

/* v2 rail sections */
.rail-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 14px;
  margin-right: 4px;
  border-right: 1px solid var(--border);
  height: 100%;
  flex-shrink: 0;
}
.rail-brand-lockup {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.rail-mark {
  height: 26px;
  width: auto;
  display: block;
  flex-shrink: 0;
}
.rail-brand-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.rail-wordmark {
  height: 15px;
  width: auto;
  display: block;
}
/* Dark is the default theme; show the dark-variant wordmark unless light is active */
.rail-wordmark-light { display: none; }
[data-theme="light"] .rail-wordmark-light { display: block; }
[data-theme="light"] .rail-wordmark-dark { display: none; }
.rail-brand-sub {
  color: var(--fg-muted);
  font-weight: 400;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.rail-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.rail-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  white-space: nowrap;
  flex-shrink: 0;
}

.rc-mode {
  font-size: 11px;
  color: var(--fg-dim);
  margin-left: 6px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.rc-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev-2);
  color: var(--fg);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-sans);
  transition: background 0.15s, border-color 0.15s;
}
.rc-btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.rc-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.rc-run-all { color: var(--pass); }
.rc-stop { color: var(--fail); }
.rc-toggle.active { color: var(--bg); border-color: var(--accent); background: var(--accent); box-shadow: 0 0 8px oklch(0.78 0.15 var(--accent-h) / 0.3); }
.rc-run-failed { color: var(--color-warning); }
.rc-download { color: var(--fg-dim); }

.rc-counts {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 11.5px; font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.rc-count { display: inline-flex; align-items: center; gap: 5px; }
.rc-count::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
}
.rc-count.passed { color: var(--pass); }
.rc-count.failed { color: var(--fail); }
.rc-count.skipped { color: var(--skip); }

.rc-connection {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--fg-dim);
}
.rc-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  flex-shrink: 0;
}
.rc-device {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  font-size: 11px;
}
.rc-device-actionable {
  cursor: context-menu;
}
.rc-context-menu {
  position: fixed;
  z-index: 1000;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 4px;
  box-shadow: var(--shadow);
  min-width: 160px;
}
.rc-context-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--fg-dim);
  font-size: 12px;
  font-family: var(--font-sans);
  cursor: pointer;
  text-align: left;
}
.rc-context-item:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.rc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rc-dot.idle { background: var(--pass); }
.rc-dot.running { background: var(--run); animation: pulse 1s infinite; }
.rc-dot.done { background: var(--pass); }
.rc-dot.initializing { background: var(--color-warning); }
.rc-dot.error { background: var(--fail); }
.rc-dot.ready { background: var(--pass); }
.rc-dot.preparing { background: var(--color-warning); animation: pulse 1.2s infinite; }
.rc-dot.stale { background: var(--fg-muted); }
.rc-dot.unprepared { background: transparent; box-shadow: inset 0 0 0 1.5px var(--fg-muted); }
.rc-readiness { font-size: 10px; color: var(--fg-muted); margin-left: 4px; font-variant-numeric: tabular-nums; }
.rc-context-item[aria-checked] { font-variant-numeric: tabular-nums; }

.rc-theme-select {
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev-2);
  color: var(--fg-dim);
  font-size: 11px;
  font-family: var(--font-sans);
  cursor: pointer;
  outline: none;
}
.rc-theme-select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px oklch(0.78 0.15 var(--accent-h) / 0.15); }

/* ─── Test Explorer ─── */

.test-explorer { display: flex; flex-direction: column; height: 100%; background: var(--bg); }

.te-header { padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); }

/* v2 explorer search container */
.explorer-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.explorer-search input {
  flex: 1;
  background: none;
  border: 0;
  outline: 0;
  font-size: 12px;
  color: var(--fg);
  font-family: var(--font-sans);
}
.explorer-search input::placeholder { color: var(--fg-muted); }

/* v2 filter tabs */
.filter-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.filter-tab {
  flex: 1;
  padding: 5px 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg-dim);
  border-radius: 4px;
  text-align: center;
  transition: background .12s, color .12s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: none;
  background: none;
  cursor: pointer;
}
.filter-tab:hover { color: var(--fg); }
.filter-tab.active { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.filter-tab .ct {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.filter-tab.active .ct { color: var(--fg-dim); }
.filter-tab .ind { width: 5px; height: 5px; border-radius: 50%; }

/* v2 explorer toolbar */
.explorer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 10.5px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.explorer-toolbar-actions { display: flex; gap: 2px; }

/* v2 duration class */
.dur {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.te-search {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  font-family: var(--font-sans);
  outline: none;
  margin-bottom: 6px;
}
.te-search:focus { border-color: var(--accent); box-shadow: 0 0 0 2px oklch(0.78 0.15 var(--accent-h) / 0.15); }
.te-search::placeholder { color: var(--fg-muted); }

/* When inside explorer-search container, input loses its own border/bg */
.explorer-search .te-search {
  border: none;
  background: none;
  margin-bottom: 0;
  padding: 0;
  flex: 1;
  min-width: 0;
}
.explorer-search .te-search:focus { box-shadow: none; }

.te-status-filters { display: flex; gap: 3px; }

.te-status-btn {
  flex: 1;
  padding: 3px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 10px;
  font-family: var(--font-sans);
  transition: background 0.15s;
}
.te-status-btn:hover { background: var(--bg-hover); }
.te-status-btn.active { background: var(--bg-active); color: var(--fg); border-color: var(--border-strong); }
.te-status-btn.active.te-status-passed { color: var(--pass); }
.te-status-btn.active.te-status-failed { color: var(--fail); }

/* v2 filter-tab overrides when both classes present */
.te-status-btn.filter-tab {
  border: none;
  background: none;
  padding: 5px 8px;
  font-size: 11.5px;
  font-weight: 500;
  border-radius: 4px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 5px;
  transition: background .12s, color .12s;
}
.te-status-btn.filter-tab:hover { background: transparent; color: var(--fg); }
.te-status-btn.filter-tab.active { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.2); border: none; }

/* v2 colored dot indicators */
.ind { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; position: relative; top: -1px; }
.ind-passed { background: var(--pass); }
.ind-failed { background: var(--fail); }
.ind-skipped { background: var(--skip); }

/* Filter tab counts are plain mono text, not pills */
.te-status-btn.filter-tab .te-count.ct {
  padding: 0;
  border: none;
  background: none;
  border-radius: 0;
  min-width: 0;
  box-shadow: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-muted);
  font-weight: 400;
  margin-left: 0;
}
.te-status-btn.filter-tab.active .te-count.ct { color: var(--fg-dim); background: none; }

.te-count { font-weight: 600; margin-left: 2px; font-variant-numeric: tabular-nums; }

.te-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.te-toolbar-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.te-toolbar-actions { display: flex; gap: 2px; }
.te-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0;
}
.te-toolbar-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.te-toolbar-btn:disabled { opacity: 0.35; cursor: default; }
.te-toolbar-btn.active { color: var(--accent); background: var(--bg-hover); }
.te-toolbar-btn.active:hover:not(:disabled) { color: var(--accent); }
@keyframes te-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.te-toolbar-btn.stopping { color: var(--color-warning); }
.te-toolbar-btn.stopping svg { animation: te-pulse 1.2s ease-in-out infinite; }
.te-toolbar-sep { width: 1px; height: 14px; background: var(--border); margin: 0 2px; align-self: center; }

.te-tree { flex: 1; overflow-y: auto; padding: 4px 0; }

.te-empty { padding: 20px; text-align: center; color: var(--fg-muted); font-size: 12px; }

.te-node {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  min-height: var(--row-h);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, border-left-color 0.15s;
  border-left: 2px solid transparent;
}
.te-node:hover { background: var(--bg-hover); }
.te-node.selected { background: var(--bg-active); border-left-color: var(--fg-dim); }
.te-node.te-status-running { border-left-color: var(--run); }
.te-node.te-status-flash-failed { animation: flash-fail 0.6s ease-out; }
.te-node.te-node-project {
  margin-top: 4px;
  padding-top: 6px;
  padding-bottom: 6px;
  border-top: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-elev);
}
.te-node-group:first-child > .te-node.te-node-project { margin-top: 0; border-top: none; }
.te-node.te-status-skipped { opacity: 0.55; }
.te-node[data-status="skipped"] { opacity: 0.55; }
.te-node[data-status="skipped"]:hover { opacity: 1; }
/* v2 sticky project headers via data-type */
.te-node[data-type="project"] {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg);
}
/* v2 indent guides via --depth custom property */
.te-node[data-depth]::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0;
  left: calc(6px + var(--depth, 0) * 16px - 7px);
  width: 1px;
  background: var(--border);
  opacity: 0.5;
  pointer-events: none;
}
.te-node[data-depth="0"]::after { display: none; }

/* v2 node alias */
.node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  min-height: var(--row-h);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.12s;
}
.node:hover { background: var(--bg-hover); }

/* Indent guides (driven by data-depth attribute, see above) */

.te-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  transition: transform 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}
.te-chevron::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent var(--fg-dim);
}
.te-chevron:hover::before { border-left-color: var(--fg); }
.te-chevron.expanded { transform: rotate(90deg); }
.te-chevron-spacer { display: inline-block; width: 20px; flex-shrink: 0; }

.te-status-icon { width: 16px; text-align: center; font-size: 12px; flex-shrink: 0; }
.te-status-icon.passed { color: var(--pass); }
.te-status-icon.failed { color: var(--fail); }
.te-status-icon.skipped { color: var(--skip); }
.te-status-icon.pending { color: var(--run); animation: pulse 1s infinite; }
.te-status-icon.running { color: var(--run); }
.te-status-icon.running svg { animation: spin 1s linear infinite; }
.te-status-icon.idle { color: var(--fg-muted); }

.te-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.te-node-file .te-name { font-weight: 600; }
.te-node-project .te-name { font-weight: 700; color: var(--accent); font-size: 11px; letter-spacing: 0.03em; text-transform: uppercase; }

.te-deps { font-size: 10px; color: var(--fg-muted); font-style: italic; flex-shrink: 0; margin-right: 4px; }

.te-duration { font-size: 10px; color: var(--fg-muted); font-family: var(--font-mono); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.te-isolation { font-size: 9.5px; color: var(--fg-muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 5px; margin-right: 6px; flex-shrink: 0; letter-spacing: 0.02em; line-height: 14px; }
.te-devices { display: inline-flex; align-items: center; gap: 3px; font-size: 9.5px; color: var(--fg-muted); margin-right: 6px; flex-shrink: 0; letter-spacing: 0.02em; line-height: 14px; }
.te-devices svg { flex-shrink: 0; opacity: 0.8; }

.te-actions {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  display: flex; gap: 2px; flex-shrink: 0;
  pointer-events: none;
}
.te-actions > button { pointer-events: auto; }
.te-action-btn { opacity: 0; transition: opacity 0.15s; }
.te-node:hover .te-action-btn { opacity: 1; }
.te-watch-btn.active { opacity: 1; }

.te-actions:has(.te-watch-btn.active), .te-node:hover .te-actions { background: var(--bg); border-radius: 3px; padding: 1px 2px; }
.te-node:hover .te-actions { background: var(--bg-hover); }
.te-node.selected .te-actions:has(.te-watch-btn.active), .te-node.selected:hover .te-actions { background: var(--bg-active); }

.te-action-btn {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 3px;
  background: transparent; color: var(--fg-dim);
  cursor: pointer; font-size: 10px;
}
.te-action-btn:hover:not(:disabled) { background: var(--bg-active); color: var(--fg); }
.te-run-btn:hover:not(:disabled) { color: var(--pass); }
.te-node:hover .te-action-btn:disabled { opacity: 0.3; cursor: default; }
.te-watch-btn.active { color: var(--accent); }

/* ─── Screen Area (Action screenshots) ─── */

.ui-screen-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.ui-screen-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}

.ui-download-btn {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--fg-muted);
  font-size: 11px;
  cursor: pointer;
  font-family: var(--font-sans);
}
.ui-download-btn:hover { color: var(--fg); background: var(--bg-hover); }

.ui-screen-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ─── Stage (v2) ─── */

.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.viewer {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-elev);
}
.viewer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.viewer-body {
  flex: 1;
  overflow: auto;
  position: relative;
  background: var(--bg-elev);
}
.viewer-body.has-grid {
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 32px 32px;
  background-position: -1px -1px;
}
.viewer-head-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.viewer-head-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.005em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.viewer-head-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}
.viewer-pick-btn, .viewer-download-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background .1s, border-color .1s, color .1s;
}
.viewer-pick-btn:hover, .viewer-download-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
  border-color: var(--border-strong);
}
.viewer-pick-btn.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
}

/* Viewer dot grid background (legacy class) */
.viewer-bg {
  background-image: radial-gradient(circle, var(--grid-line) 1px, transparent 1px);
  background-size: 16px 16px;
  background-color: var(--bg);
}

/* ─── Filmstrip (v2) ─── */

.film-frame {
  position: relative;
  flex-shrink: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.film-frame.active .timeline-thumb,
.film-frame.active .timeline-placeholder,
.film-frame.active .film-thumb {
  opacity: 1;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px oklch(0.78 0.15 var(--accent-h) / 0.2);
}
.film-frame.failed .timeline-thumb,
.film-frame.failed .timeline-placeholder,
.film-frame.failed .film-thumb {
  border-color: var(--fail);
  border-width: 2px;
  box-shadow: 0 0 0 2px oklch(0.68 0.2 25 / 0.2);
  opacity: 1;
}
.film-frame.active .film-label { color: var(--fg); }
.film-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.film-strip {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 8px;
  overflow-x: auto;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.film-thumb {
  height: 56px;
  width: auto;
  border-radius: 3px;
  border: 2px solid transparent;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.1s, border-color 0.1s;
  flex-shrink: 0;
}
.film-thumb:hover { opacity: 1; }
.film-thumb.selected { opacity: 1; border-color: var(--accent); }
.film-thumb.failed { border-bottom: 2px solid var(--fail); }

/* ─── Device Pane ─── */

.ui-right-column {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ui-device-pane {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-elev);
}

.device-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.device-pane-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
}

.device-pane-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  height: 100%;
}

@container (min-width: 400px) {
  .device-pane-grid { grid-template-columns: 1fr 1fr; }
}

@container (min-width: 800px) {
  .device-pane-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
}

/* Device column (v2) */
.device-col {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-elev);
  border-left: 1px solid var(--border);
}
.device-head {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.device-head-title {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
  font-weight: 600;
}
.device-head-meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-dim);
  display: flex;
  align-items: center;
  gap: 6px;
}
.device-head-meta .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--pass);
  animation: pulse 2s ease-in-out infinite;
}
.worker-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.worker-tab {
  padding: 4px 10px;
  font-size: 11px;
  font-family: var(--font-mono);
  border-radius: 999px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  cursor: pointer;
}
.worker-tab:hover { background: var(--bg-hover); color: var(--fg); }
.worker-tab.active { background: var(--accent-bg); border-color: var(--accent); color: var(--fg); }
.worker-tab .dot { width: 5px; height: 5px; border-radius: 50%; }
.worker-tab .dot.running { background: var(--run); animation: pulse 1.2s ease-in-out infinite; }
.worker-tab .dot.idle { background: var(--skip); }
.worker-tab .dot.done { background: var(--pass); }
.worker-tab .dot.error { background: var(--fail); }
.worker-tab .dot.initializing { background: var(--color-warning); }
.device-body {
  flex: 1;
  padding: 20px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  overflow-y: auto;
  min-height: 0;
}
.device-body-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}
.device-body-item + .device-body-item {
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
.device-body-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-dim);
}
.device-body-label .dot { width: 6px; height: 6px; border-radius: 50%; }
.device-body-label .dot.idle { background: var(--skip); }
.device-body-label .dot.running { background: var(--run); animation: pulse 1.4s ease-in-out infinite; }
.device-body-label .dot.done { background: var(--pass); }
.device-body-label .dot.error { background: var(--fail); }

/* ─── Device Mirror ─── */

.device-mirror {
  display: flex; flex-direction: column; align-items: center;
  height: 100%; width: 100%; padding: 8px; gap: 6px;
}

.dm-viewport {
  flex: 1; display: flex; align-items: center; justify-content: center;
  position: relative; min-height: 0; width: 100%;
  container-type: inline-size;
}

.dm-canvas {
  max-width: 100%; max-height: 100%; object-fit: contain;
  border-radius: 8px; border: 2px solid var(--border); background: #000;
}
.dm-canvas.pick-mode { cursor: crosshair; border-color: var(--accent); }
.dm-canvas.interactive { cursor: pointer; touch-action: none; outline: none; }
.dm-canvas.interactive:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dm-canvas.locked { cursor: not-allowed; }
.mirror-lock-toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  border-radius: 5px;
}
.mirror-lock-toggle.unlocked { color: var(--fg-dim); }
.mirror-lock-toggle.locked { color: var(--accent); }
.mirror-lock-toggle:hover { background: var(--bg-elev-2); }
.mirror-pick-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  border-radius: 5px;
  color: var(--fg-dim);
}
.mirror-pick-toggle.active { color: var(--accent); }
.mirror-pick-toggle:hover:not(:disabled) { background: var(--bg-elev-2); }
.mirror-pick-toggle:disabled { opacity: 0.4; cursor: default; }

.dm-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-elev-2); border-radius: 8px; z-index: 1;
}

.dm-placeholder {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--fg-muted);
}

.dm-phone-icon { width: 42px; height: 72px; color: var(--fg-muted); opacity: 0.4; }

.dm-placeholder-text { font-size: 13px; font-weight: 600; color: var(--fg-dim); }
.dm-placeholder-hint { font-size: 11px; color: var(--fg-muted); }

.dm-placeholder-dots { display: flex; gap: 6px; }
.dm-dot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--fg-muted);
  animation: dm-bounce 1.4s ease-in-out infinite;
}
.dm-dot:nth-child(2) { animation-delay: 0.2s; }
.dm-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes dm-bounce { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

.dm-controls { display: flex; gap: 6px; }

.dm-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-elev-2); color: var(--fg-dim);
  cursor: pointer; font-size: 11px; font-family: var(--font-sans);
  transition: background 0.15s, color 0.15s;
}
.dm-btn:hover { background: var(--bg-hover); color: var(--fg); }
.dm-btn.active { color: var(--accent); border-color: var(--accent); }

/* ─── Device Skins (CSS-only bezels) ─── */

.dm-frame {
  display: contents;
}

/* ─── Image bezels (photographic frames from bezel.fit) ─── */

/* The frame box fits the viewport preserving the frame PNG's aspect ratio
 * (set inline). The PNG overlays the screen window; the device screen
 * (canvas / screenshot) sits underneath in the dm-frame-screen box. */
.dm-frame-img {
  display: block;
  position: relative;
  /* Width fits the container: grid tiles fill their width (100%); the single
   * mirror sets an explicit px width inline (measured in JS) so it also fits by
   * the container height. max-* guards either case from overflowing. */
  width: 100%;
  aspect-ratio: var(--dm-fa);
  max-width: 100%;
  max-height: 100%;
  margin: auto;
}
.dm-frame-png {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  z-index: 2;
  pointer-events: none; /* taps fall through to the screen below */
  user-select: none;
  -webkit-user-drag: none;
}
/* Full-frame layer, positioned and sized identically to the frame PNG, clipped
 * to the exact screen-opening shape via a mask generated from the frame. Because
 * the mask and the frame PNG both cover this same box, they align precisely —
 * no sub-pixel seam where the black backing could bleed past the bezel. */
.dm-frame-screen {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: #000;
  -webkit-mask-image: var(--dm-mask);
  mask-image: var(--dm-mask);
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}
/* The content sits over the screen window; the mask above clips its corners. */
.dm-frame-screen-rect {
  position: absolute; /* left/top/width/height set inline from the screen rect */
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
/* The screen content fits its window preserving aspect (no distortion), so the
 * canvas's getBoundingClientRect — used to normalize tap coordinates — always
 * maps 1:1 onto the device screen. */
.dm-frame-screen-rect > .dm-canvas,
.dm-frame-screen-rect > img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  border: none;
  border-radius: 0;
  display: block;
  background: transparent;
}

.dm-skin-ios,
.dm-skin-android {
  display: inline-flex;
  position: relative;
  max-width: 100%;
  max-height: 100%;
}

.dm-skin-ios .dm-canvas,
.dm-skin-android .dm-canvas,
.dm-skin-ios > img,
.dm-skin-android > img {
  border: none;
  border-radius: 0;
  display: block;
}

.screenshot-device-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  max-height: 100%;
  container-type: inline-size;
}
.screenshot-device-frame .dm-skin-ios,
.screenshot-device-frame .dm-skin-android {
  width: 100%;
  box-sizing: border-box;
}
.screenshot-device-frame .dm-skin-ios > img,
.screenshot-device-frame .dm-skin-android > img {
  max-height: var(--screen-max-height, 100%);
  width: 100%;
  height: auto;
}

/* iOS — rounded bezel with Dynamic Island notch */
.dm-skin-ios {
  --bezel: var(--skin-ios-bezel, 3cqi);
  --bezel-radius: var(--skin-ios-bezel-radius, 12cqi);
  padding: var(--bezel);
  background: #1a1a1a;
  border-radius: var(--bezel-radius);
  box-shadow:
    inset 0 0 0 1px oklch(0.35 0 0),
    0 2px 12px rgba(0,0,0,.4);
}
.dm-skin-ios .dm-canvas,
.dm-skin-ios > img {
  border-radius: calc(var(--bezel-radius) - var(--bezel));
  position: relative;
  z-index: 1;
}
/* Dynamic Island */
.dm-skin-ios::after {
  content: '';
  position: absolute;
  top: calc(var(--bezel) + var(--skin-ios-island-offset, 2cqi));
  left: 50%;
  transform: translateX(-50%);
  width: var(--skin-ios-island-width, 22cqi);
  height: var(--skin-ios-island-height, 6cqi);
  background: #1a1a1a;
  border-radius: var(--skin-ios-island-radius, 3cqi);
  z-index: 2;
  pointer-events: none;
}
/* Side button hints */
.dm-skin-ios::before {
  content: '';
  position: absolute;
  right: var(--skin-ios-button-right, -1cqi);
  top: 20%;
  width: var(--skin-ios-button-width, 1cqi);
  height: var(--skin-ios-button-height, 14cqi);
  border-radius: 0 var(--skin-ios-button-radius, 1cqi) var(--skin-ios-button-radius, 1cqi) 0;
  background: oklch(0.3 0 0);
  z-index: 3;
  pointer-events: none;
}

/* Android — thinner bezel, punch-hole camera */
.dm-skin-android {
  --bezel: var(--skin-android-bezel, 2cqi);
  --bezel-radius: var(--skin-android-bezel-radius, 7cqi);
  padding: var(--bezel);
  padding-top: var(--skin-android-padding-top, 2.5cqi);
  background: #1a1a1a;
  border-radius: var(--bezel-radius);
  box-shadow:
    inset 0 0 0 1px oklch(0.3 0 0),
    0 2px 12px rgba(0,0,0,.4);
}
.dm-skin-android .dm-canvas,
.dm-skin-android > img {
  border-radius: calc(var(--bezel-radius) - var(--bezel));
  position: relative;
  z-index: 1;
}
/* Punch-hole camera */
.dm-skin-android::after {
  content: '';
  position: absolute;
  top: calc(var(--bezel) + var(--skin-android-camera-offset, 1.5cqi));
  left: 50%;
  transform: translateX(-50%);
  width: var(--skin-android-camera-size, 2.5cqi);
  height: var(--skin-android-camera-size, 2.5cqi);
  background: oklch(0.12 0 0);
  border-radius: 50%;
  border: 1px solid oklch(0.25 0 0);
  z-index: 2;
  pointer-events: none;
}
/* Power + volume buttons (right side) */
.dm-skin-android::before {
  content: '';
  position: absolute;
  right: var(--skin-android-button-right, -1cqi);
  top: 18%;
  width: var(--skin-android-button-width, 1cqi);
  height: var(--skin-android-button-height, 11cqi);
  border-radius: 0 var(--skin-android-button-radius, 1cqi) var(--skin-android-button-radius, 1cqi) 0;
  background: oklch(0.3 0 0);
  z-index: 3;
  pointer-events: none;
}

/* Tablet variants — slimmer uniform bezel, gentler corner radius, and a small
 * centered front camera instead of a phone notch / punch-hole. Used for iPads
 * and Android tablets, which bezel.fit has no photographic frames for. */
.dm-skin-ios.dm-skin-tablet,
.dm-skin-android.dm-skin-tablet {
  --bezel: 2.6cqi;
  --bezel-radius: 5cqi;
  padding: var(--bezel);
}
.dm-skin-ios.dm-skin-tablet .dm-canvas,
.dm-skin-ios.dm-skin-tablet > img,
.dm-skin-android.dm-skin-tablet .dm-canvas,
.dm-skin-android.dm-skin-tablet > img {
  border-radius: calc(var(--bezel-radius) - var(--bezel));
}
.dm-skin-ios.dm-skin-tablet::after,
.dm-skin-android.dm-skin-tablet::after {
  top: calc((var(--bezel) - 1.4cqi) / 2);
  left: 50%;
  transform: translateX(-50%);
  width: 1.4cqi;
  height: 1.4cqi;
  background: oklch(0.12 0 0);
  border: 1px solid oklch(0.28 0 0);
  border-radius: 50%;
}

/* ─── Trace Viewer Components (ActionsPanel, DetailTabs, etc.) ─── */

.actions-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
.actions-header { display: flex; align-items: center; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.actions-header-tab { padding: 6px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-dim); cursor: pointer; border-bottom: 2px solid transparent; }
.actions-header-tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.actions-filter { padding: 6px 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.actions-filter input { width: 100%; padding: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); font-size: 12px; outline: none; font-family: var(--font-sans); }
.actions-filter input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px oklch(0.78 0.15 var(--accent-h) / 0.15); }
.actions-list { flex: 1; overflow-y: auto; }

.action-item {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: 8px;
  padding: 7px 12px 7px 10px;
  align-items: center;
  cursor: pointer;
  position: relative;
  border-left: 2px solid transparent;
  transition: background .1s;
  background-image: linear-gradient(to right, transparent calc(100% - var(--dur-pct, 0%)), oklch(0.78 0.15 var(--accent-h) / 0.025) calc(100% - var(--dur-pct, 0%)));
}
.action-item:hover { background-color: var(--bg-hover); }
.action-item.selected { background-color: var(--bg-active); border-left-color: var(--fg-dim); }
.action-item.pinned { border-left-color: var(--accent); }
.action-item.pinned:not(.selected) { border-left-color: var(--accent-dim); }
.action-item.failed { background-color: oklch(0.68 0.2 25 / 0.05); }
.action-item.failed.selected { background-color: oklch(0.68 0.2 25 / 0.12); border-left-color: var(--fail); }
.action-item.failed.selected { position: sticky; top: 0; z-index: 2; }
.action-icon {
  width: 24px; height: 24px;
  border-radius: 5px;
  display: grid; place-items: center;
  background: var(--bg-elev-2);
  color: var(--fg-dim);
  border: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
}
.action-item.failed .action-icon { background: oklch(0.68 0.2 25 / 0.12); color: var(--fail); border-color: oklch(0.68 0.2 25 / 0.3); }
.action-item.passed.selected { border-left-color: var(--pass); }
.action-item.selected .action-icon { background: var(--bg-elev-2); color: var(--fg-dim); border-color: var(--border); }
.action-icon.assert.failed, .action-icon.failed { color: var(--fail); }
.action-name { font-size: 12.5px; font-weight: 500; color: var(--fg); white-space: nowrap; display: flex; align-items: center; gap: 6px; }
.action-detail { font-size: 11px; color: var(--fg-muted, var(--fg-dim, #888)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.action-origin-tag { font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; padding: 1px 5px; border-radius: 999px; border: 1px solid var(--border, #444); color: var(--fg-muted, var(--fg-dim, #888)); }
.action-device-tag { font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em; margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: oklch(var(--device-tag-bg-l) var(--device-tag-bg-c) var(--device-h, var(--accent-h))); color: oklch(var(--device-tag-fg-l) var(--device-tag-fg-c) var(--device-h, var(--accent-h))); vertical-align: middle; }

/* ─── Multi-device traces ─── */
/* One lane per device, stacked in the single filmstrip row over one shared
   time axis. Only .film-lanes scrolls: the lane rows reuse .timeline-inner's
   markup but must not inherit its scrolling or its min-width: 100% -- with
   the label column beside it that made the strip 56px wider than its box, so
   a scrollbar showed even when every frame fit. The doubled selectors win
   over the single-lane rules, which come later in the sheet. Every column is
   the same width in every lane and on the axis, so a device's gaps line up
   with the other device's frames and the rows read as one timeline. The
   acting device's lane carries a faint band in its own hue (--device-h is set
   on the lane, so its label pill inherits it) and the other lanes dim.
   Height budget: summary line 18px + axis 14px + 10px kept for the horizontal
   scrollbar when the strip does overflow = 42px, then 4px of padding per
   lane. laneStripMinHeight() in device-frames.ts mirrors these numbers. */
.timeline:has(.film-lanes) { height: 100%; overflow: hidden; }
.film-lanes { display: flex; flex: 1; flex-direction: column; justify-content: flex-end; min-width: 0; min-height: 0; overflow-x: auto; overflow-y: hidden; --lane-thumb-h: calc((var(--filmstrip-h, 130px) - 42px) / var(--lane-count, 2) - 4px); --lane-col: max(calc(var(--lane-thumb-h) * 0.5 + 4px), 36px); }
.film-lane { display: flex; align-items: center; min-width: max-content; min-height: 0; }
.film-lane.acting { background: oklch(0.7 0.14 var(--device-h, var(--accent-h)) / 0.09); }
.film-lane-label { flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; width: 64px; padding: 0 6px; }
.film-lane-label .action-device-tag { margin-left: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; transition: opacity 0.12s; }
.film-lanes.has-acting .film-lane:not(.acting) .action-device-tag { opacity: 0.5; }
.film-lanes.has-acting .film-lane:not(.acting) .film-frame { opacity: 0.7; }
.film-lanes .film-lane-inner { flex: 1; align-items: center; min-width: 0; min-height: 0; overflow: visible; padding: 2px 8px; }
.film-lane .film-frame, .film-lane .film-gap { width: var(--lane-col); flex-shrink: 0; }
.film-lane .film-frame { gap: 0; }
.film-lane .timeline-thumb, .film-lane .film-thumb { height: var(--lane-thumb-h); max-width: 100%; object-fit: contain; }
.film-lane .timeline-placeholder, .film-lane .film-thumb.timeline-placeholder { height: calc(var(--lane-thumb-h) - 3px); }
.film-gap { min-height: 1px; }
.film-axis { display: flex; align-items: flex-start; min-width: max-content; height: 14px; flex-shrink: 0; }
.film-axis-spacer { flex-shrink: 0; width: 64px; }
.film-axis-inner { display: flex; gap: 2px; padding: 0 8px; }
.film-axis-label { width: var(--lane-col); flex-shrink: 0; text-align: center; overflow: hidden; white-space: nowrap; }
.film-axis-label.active { color: var(--fg); font-weight: 600; }
.hier-device-toggle { display: flex; gap: 4px; padding: 6px 8px 0; }
.hier-with-toggle { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.con-pill.con-pill-device { text-transform: none; }
.con-pill-device.active { border-color: oklch(0.65 0.13 var(--device-h, var(--accent-h))); background: oklch(0.65 0.13 var(--device-h, var(--accent-h)) / 0.14); color: var(--fg); }
.net-device { color: var(--fg-dim); font-size: 10.5px; }
.action-item.failed .action-name { color: var(--fail); }
.action-selector-text {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-top: 1px;
}
.action-selector-text .sel-fn { color: var(--accent-dim); }
.action-selector-text .sel-val { color: var(--fg-dim); }
.action-duration { color: var(--fg-muted); font-size: 10px; flex-shrink: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; justify-self: end; }
.action-item.failed .action-duration { color: var(--fail); }
.action-details { min-width: 0; display: flex; flex-direction: column; }

/* v2 .act alias — inherits from .action-item (no display override) */

/* Duration heatmap — intensity via inline --heat (0-1) */
.action-duration[style*="--heat"] {
  color: color-mix(in oklch, var(--fail) calc(var(--heat) * 100%), var(--fg-muted));
}

/* Sticky action groups */
.group-item {
  padding: 10px 12px 4px;
  font-size: 9.5px;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg);
  border-left: none;
}
.group-item::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}
.group-item.lifecycle { border-left: none; background: var(--bg); }

/* In-flight action row */
.action-item.in-progress .action-name { font-style: italic; }
.action-item.in-progress .action-icon { color: var(--fg-dim); }
.action-spinner { width: 12px; height: 12px; flex-shrink: 0; margin-left: auto; border: 2px solid var(--color-spinner-track); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
.action-spinner.preflight-spinner { width: 24px; height: 24px; margin-left: 0; border-width: 3px; }

.metadata-panel { padding: 12px; font-size: 12px; overflow-y: auto; flex: 1; }
.metadata-grid { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; }
.metadata-label { color: var(--fg-dim); }
.metadata-value { color: var(--fg); word-break: break-all; }

/* Screenshot panel */
.screenshot-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); min-height: 0; }
.screenshot-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex-shrink: 0; }
.screenshot-tab { padding: 6px 16px; cursor: pointer; color: var(--fg-dim); border-bottom: 2px solid transparent; font-size: 12px; }
.screenshot-tab:hover { color: var(--fg); }
.screenshot-tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.screenshot-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 8px; min-height: 0; container-type: inline-size; }
.screenshot-empty { color: var(--fg-muted); text-align: center; font-size: 13px; }

.screenshot-tab-float {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  display: flex;
  gap: 0;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
}
.screenshot-tab-float .screenshot-tab {
  padding: 4px 12px;
  font-size: 11px;
  border-bottom: none;
  border-radius: 0;
}
.screenshot-tab-float .screenshot-tab:first-child { border-radius: 5px 0 0 5px; }
.screenshot-tab-float .screenshot-tab:last-child { border-radius: 0 5px 5px 0; }
.screenshot-tab-float .screenshot-tab.active {
  background: var(--accent-bg);
  color: var(--accent);
}

/* ─── Detail Tabs ─── */

/* v2 pill chip count (used in detail tabs and filter tabs) */
.ct {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 6px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  min-width: 16px;
  text-align: center;
  display: inline-block;
}

/* v2 vtab alias (detail tabs + viewer tabs) */
.vtab {
  padding: 6px 14px;
  cursor: pointer;
  color: var(--fg-dim);
  border-bottom: 2px solid transparent;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.vtab:hover { color: var(--fg); }
.vtab.active { color: var(--fg); border-bottom-color: var(--accent); }
.vtab.active .ct { background: var(--accent-bg); color: var(--accent); border-color: transparent; }
.vtab.has-error { position: relative; }
.vtab.has-error::after {
  content: '';
  position: absolute;
  top: 4px; right: 4px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--fail);
}

/* v2 action duration and group */
.act-dur {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.act-group {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg);
}

.verdict-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 8px 2px 6px;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
  border-radius: 10px; border: 1px solid transparent;
}
.verdict-pill.pass {
  color: var(--pass);
  background: color-mix(in srgb, var(--pass) 12%, transparent);
  border-color: color-mix(in srgb, var(--pass) 35%, transparent);
}
.verdict-pill.fail {
  color: var(--fail);
  background: color-mix(in srgb, var(--fail) 12%, transparent);
  border-color: color-mix(in srgb, var(--fail) 35%, transparent);
}
.verdict-dur {
  font-family: var(--font-mono);
  font-weight: 500;
  opacity: 0.7;
  text-transform: none;
}

.detail-panel { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.detail-tabs-bar { display: flex; gap: 0; background: var(--bg-elev); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.detail-tab { padding: 6px 14px; cursor: pointer; color: var(--fg-dim); border-bottom: 2px solid transparent; font-size: 12px; font-weight: 500; }
.detail-tab:hover { color: var(--fg); }
.detail-tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.detail-tab.has-error { color: var(--fail); }
.detail-tab-count {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-elev-2);
  color: var(--fg-dim);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.detail-tab.active .detail-tab-count { background: var(--accent); color: var(--bg); }
.detail-tab-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--fg-muted); margin-left: 5px; vertical-align: middle; }
.detail-tab.active .detail-tab-dot { background: var(--accent); }
.detail-content { flex: 1; overflow-y: auto; padding: 14px 14px; font-size: 12px; }
.detail-content.detail-content-flush { padding: 0; overflow: hidden; }

.call-grid {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 10px;
  row-gap: 8px;
  align-items: start;
  font-size: 12px;
}
.call-label {
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}
.call-value { color: var(--fg); word-break: break-all; font-size: 12.5px; }
.call-value.mono { font-family: var(--font-mono); font-size: 11.5px; }
.call-value.error { color: var(--fail); }
.call-value.success { color: var(--pass); }
.call-value .sel-fn { color: var(--accent-dim); }
.call-value .sel-val { color: var(--fg); }

/* Log / Console tab. These components live in trace-viewer/components/DetailTabs.tsx
   and are shared with the standalone viewer — mirror any change in
   trace-viewer/styles/trace-viewer.css.ts. */
.log-entry { font-family: var(--font-mono); font-size: 11px; padding: 1px 12px; display: flex; gap: 8px; line-height: 1.6; }
.log-time { min-width: 84px; color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; cursor: default; }
.log-level { min-width: 40px; font-weight: 600; text-transform: uppercase; font-size: 10px; }
.log-level.error { color: var(--fail); }
.log-level.warn { color: var(--color-warning); }
.log-level.info { color: var(--accent); }
.log-level.debug { color: var(--fg-dim); }
.log-level.log { color: var(--fg); }
.log-source { font-size: 10px; color: var(--fg-muted); min-width: 46px; }
/* A device pill on a console row hugs its first line rather than stretching with a wrapped message. */
.log-device { align-self: flex-start; flex-shrink: 0; margin: 2px 0 0; line-height: 1.4; }
/* Multi-device only: the column the pill sits in, sized so Message lines up under its heading. */
.log-device-cell { display: flex; min-width: 64px; flex-shrink: 0; }
.log-device-cell .action-device-tag { margin-left: 0; }
.log-device-none { color: var(--fg-muted); }
.log-message { word-break: break-all; }

.con-container { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.con-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex-shrink: 0; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
.con-search { flex: 1; min-width: 140px; padding: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--fg); font-size: 12px; outline: none; font-family: var(--font-mono); }
.con-search:focus { border-color: var(--accent); }
.con-pills { display: flex; gap: 2px; flex-wrap: wrap; }
.con-pill { padding: 2px 8px; background: transparent; border: 1px solid var(--border); border-radius: 10px; color: var(--fg-dim); font-size: 10px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
.con-pill:hover { color: var(--fg); border-color: var(--border-strong); }
.con-pill.active { color: var(--fg); border-color: var(--accent); background: var(--accent-bg); }
.con-pill.level-error.active { border-color: var(--fail); background: oklch(0.68 0.2 25 / 0.1); color: var(--fail); }
.con-pill.level-warn.active { border-color: var(--color-warning); background: oklch(0.75 0.14 80 / 0.1); color: var(--color-warning); }
.con-pill-sep { width: 1px; background: var(--border); margin: 2px 4px; align-self: stretch; }
.con-list { flex: 1; overflow-y: auto; }
.con-header { flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--bg); padding-top: 2px; padding-bottom: 2px; }
.con-th { all: unset; box-sizing: border-box; cursor: pointer; user-select: none; color: var(--fg-muted); font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
/* all:unset above drops the column widths the row spans get from .log-*; restate them so the headings sit over their columns. */
.con-th.log-time { min-width: 84px; flex-shrink: 0; }
.con-th.log-level { min-width: 40px; }
.con-th.log-source { min-width: 46px; }
.con-th.log-device-col { min-width: 64px; flex-shrink: 0; }
.con-th:hover, .con-th.active { color: var(--fg); }
.con-th.log-message { flex: 1; }
.con-sort-indicator { margin-left: 4px; font-size: 9px; }

/* Source tab */
.source-tab { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.source-filename {
  flex-shrink: 0; padding: 8px 14px 8px 8px;
  background: var(--bg-elev); border-bottom: 1px solid var(--border);
  color: var(--fg-dim); font-size: 11px;
  font-family: var(--font-mono);
}
.source-code { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre; }
.source-line { display: flex; }
.source-line-number { min-width: 40px; text-align: right; padding-right: 12px; color: var(--fg-muted); user-select: none; font-variant-numeric: tabular-nums; }
.source-line-content { flex: 1; }
.source-line.highlight { background: var(--accent-bg); }
.source-tab.has-stack { flex-direction: row; }
.source-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.source-stack {
  width: 240px;
  flex-shrink: 0;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  font-size: 12px;
}
.source-stack-title {
  padding: 6px 10px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 11px;
}
.source-stack-frame {
  display: flex;
  gap: 2px;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.source-stack-frame:hover { background: var(--bg-hover); }
.source-stack-frame.selected { background: var(--bg-active); }
.source-stack-file { color: var(--fg); }
.source-stack-line { color: var(--fg-muted); }

/* Error blocks */
.error-block { display: flex; flex-direction: column; gap: 16px; }
.error-entry { padding: 0; }
.error-entry-selected { }
.error-title { color: var(--fg); font-weight: 600; font-size: 13px; margin-bottom: 10px; word-break: break-word; display: flex; align-items: flex-start; gap: 8px; }
.error-title-icon { color: var(--fail); flex-shrink: 0; margin-top: 2px; }
.error-grid {
  display: grid; grid-template-columns: 80px 1fr; gap: 3px 12px;
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6;
  padding: 12px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
}
.error-grid:empty { display: none; }
.error-grid-key { color: var(--fg-muted); }
.error-grid-value { color: var(--fg-dim); word-break: break-word; }
.error-grid-value.mono { font-family: var(--font-mono); font-size: 11px; }
.error-grid-value.expected { font-family: var(--font-mono); font-size: 11px; color: var(--pass); }
.error-grid-value.received { font-family: var(--font-mono); font-size: 11px; color: var(--fail); }
.error-detail-block {
  margin: 0;
  padding: 12px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--fg-dim);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.error-message { color: var(--fg-dim); font-size: 12px; margin-top: 4px; word-break: break-word; }
.error-log { margin-top: 10px; border-top: 1px solid var(--color-error-border); padding-top: 8px; }
.error-log-title { color: var(--fg-dim); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.error-log-list { list-style: none; margin: 0; padding: 0; font-family: var(--font-mono); font-size: 11px; color: var(--fg); }
.error-log-list li { padding: 1px 0 1px 12px; position: relative; white-space: pre-wrap; word-break: break-word; }
.error-log-list li::before { content: '\\2013'; position: absolute; left: 0; color: var(--fg-muted); }
.error-stack-details { margin-top: 8px; }
.error-stack-details summary { color: var(--fg-dim); font-size: 11px; cursor: pointer; user-select: none; }
.error-stack-details summary:hover { color: var(--fg); }
.error-stack { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); white-space: pre-wrap; word-break: break-all; margin-top: 6px; padding: 10px 12px; background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 8px; line-height: 1.6; }
.test-error-banner { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--color-error-bg); border-bottom: 1px solid var(--color-error-border); cursor: pointer; font-size: 12px; color: var(--fail); flex-shrink: 0; }
.test-error-banner:hover { background: var(--color-error-border); }
.test-error-banner.info { background: var(--bg-elev-2); border-bottom-color: var(--border); color: var(--fg-dim); }
.test-error-banner.info:hover { background: var(--bg-elev-2); color: var(--fg); }
.test-error-banner-icon { font-weight: 700; flex-shrink: 0; }
.test-error-banner-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.no-content { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--fg-muted); font-size: 12px; padding: 24px; text-align: center; }
.no-content-note { color: var(--fg-muted); font-size: 11px; margin-top: 6px; opacity: 0.7; }

/* ─── Timeline / Filmstrip ─── */

.timeline { display: flex; flex-direction: column; gap: 0; padding: 0; background: var(--bg); border-bottom: 1px solid var(--border); flex-shrink: 0; position: relative; height: 100%; }
.timeline-inner { display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px; min-width: 100%; flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; }
.timeline-thumb { height: calc(var(--filmstrip-h, 130px) - 40px); width: auto; border-radius: 5px; border: 1.5px solid var(--border); cursor: pointer; opacity: 0.6; transition: all 0.12s; flex-shrink: 0; }
.timeline-thumb:hover { opacity: 1; border-color: var(--border-strong); }
.timeline-thumb.selected { opacity: 1; border-color: var(--accent); box-shadow: 0 0 0 2px oklch(0.78 0.15 var(--accent-h) / 0.2); }
.timeline-thumb.failed { opacity: 1; border-color: var(--fail); border-width: 2px; box-shadow: 0 0 0 2px oklch(0.68 0.2 25 / 0.2); }
/* The placeholder also carries .film-thumb, whose width: auto would otherwise win by source order
   and collapse the box to its label. The compound selector keeps our sizing regardless of order; the
   aspect ratio matches a phone screenshot so the box sits flush with its neighbouring thumbnails.
   Thumbnails are border-box images whose ratio applies to the content area, so the placeholder uses
   content-box with the 3px of border taken off its height to land on identical outer dimensions. */
.timeline-placeholder, .film-thumb.timeline-placeholder { box-sizing: content-box; width: auto; aspect-ratio: 9 / 19.5; height: calc(var(--filmstrip-h, 130px) - 40px - 3px); border-radius: 5px; background: var(--bg-elev-2); border: 1.5px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--fg-muted); flex-shrink: 0; cursor: pointer; transition: all 0.12s; }
.timeline-placeholder:hover { border-color: var(--border-strong); }
.timeline-placeholder.selected { border-color: var(--accent); box-shadow: 0 0 0 2px oklch(0.78 0.15 var(--accent-h) / 0.2); }
.timeline-time-label { position: absolute; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
.timeline-meta { padding: 4px 12px 0; text-align: right; font-size: 11px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.timeline-meta .test-status { font-weight: 600; }
.timeline-meta .passed { color: var(--pass); }
.timeline-meta .failed { color: var(--fail); }
.timeline-meta .running { color: var(--run); animation: pulse 1s infinite; }

/* ─── Filmstrip Empty Bar ─── */

.film-empty {
  height: 38px;
  padding: 0 16px;
  display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  font-size: 11.5px;
  color: var(--fg-muted);
}
.film-empty-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex-shrink: 0;
}
.film-empty[data-state="running"] .film-empty-icon { color: var(--accent); }
.film-empty[data-state="running"] .film-empty-text { color: var(--fg-dim); }
.film-empty-text { flex: 1; }
.film-empty-cta {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 9px;
  font-size: 10.5px; font-weight: 500;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elev-2);
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap; flex-shrink: 0;
  font-family: var(--font-sans);
}
.film-empty-cta:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--fg-dim); }
.film-empty-cta:disabled { opacity: 0.6; cursor: default; }

/* ─── Viewer Empty State ─── */

.viewer-empty {
  width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px;
  padding: 24px; text-align: center;
  color: var(--fg-muted);
}
.viewer-empty-icon {
  width: 44px; height: 44px;
  border-radius: 50%;
  display: grid; place-items: center;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  margin-bottom: 4px;
}
.viewer-empty-title { font-size: 13px; color: var(--fg-dim); font-weight: 500; }
.viewer-empty-sub   { font-size: 11.5px; color: var(--fg-muted); max-width: 320px; line-height: 1.5; }
.viewer-empty-cta {
  margin-top: 10px;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  font-size: 11.5px; font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elev-2);
  color: var(--fg);
  cursor: pointer;
  font-family: var(--font-sans);
}
.viewer-empty-cta:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--fg-dim); }
.viewer-empty-cta:disabled { opacity: 0.6; cursor: default; }

.viewer-empty-summary {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 12px;
  margin-top: 4px;
  font-size: 11.5px;
}
.summary-stat {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--fg-muted);
}
.summary-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--fg-muted);
}
.summary-stat.passed .summary-dot { background: var(--color-success, #22c55e); }
.summary-stat.failed  .summary-dot { background: var(--color-danger, #ef4444); }
.summary-stat.running .summary-dot { background: var(--accent, #3b82f6); }
.summary-stat.skipped .summary-dot { background: var(--fg-muted); }
.summary-stat.idle    .summary-dot { background: var(--border-strong); }

/* ─── Actions Empty State ─── */

.actions-empty {
  flex: 1;
  display: flex; flex-direction: column; align-items: flex-start;
  padding: 16px 14px; gap: 4px;
}
.actions-empty-title { font-size: 12px; color: var(--fg-dim); font-weight: 500; }
.actions-empty-sub   { font-size: 11px; color: var(--fg-muted); line-height: 1.45; }

/* ─── Viewer disabled buttons ─── */

.viewer-pick-btn:disabled,
.viewer-download-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ─── Empty State ─── */

.ui-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  gap: 8px;
  color: var(--fg-muted);
  text-align: center;
  user-select: none;
}
.ui-empty-icon {
  font-size: 28px;
  color: var(--fg-muted);
  opacity: 0.5;
  margin-bottom: 4px;
}
.ui-empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--fg-dim);
}
.ui-empty-hint {
  font-size: 12px;
  max-width: 44ch;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.ui-empty-shortcut {
  font-size: 11px;
  margin-top: 4px;
}
.ui-empty-shortcut kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-elev-2);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  box-shadow: 0 1px 0 var(--border);
}

/* ─── Run Duration ─── */

.rc-elapsed {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-dim);
  min-width: 48px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ─── Kbd shortcut hints ─── */

.rc-kbd {
  display: inline-block;
  padding: 0 4px;
  margin-left: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  box-shadow: 0 1px 0 var(--border);
}

/* ─── MCP Indicator (top bar) ─── */

.rc-mcp-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.rc-mcp-indicator:hover,
.rc-mcp-indicator.active {
  border-color: var(--accent);
  color: var(--fg);
}
.rc-mcp-client {
  color: var(--fg);
  font-weight: 500;
}
.rc-mcp-client.listening {
  color: var(--fg-muted);
  font-weight: 400;
}

/* ─── MCP Panel ─── */

.ui-mcp-pane {
  flex: 0 0 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.mcp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: var(--font-sans);
  font-size: 12px;
}

.mcp-header {
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  gap: 6px;
  flex-shrink: 0;
}
.mcp-header-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.mcp-agents-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mcp-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mcp-header-right {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.mcp-title {
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
}
.mcp-connection {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mcp-connection.connected { color: var(--pass); }

.mcp-agent-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev-2);
  color: var(--pass);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mcp-agent-count {
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  font-size: 0.85em;
}

.mcp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.mcp-dot.connected { background: var(--pass); }
.mcp-dot.listening { background: var(--fg-muted); }

.mcp-btn {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.mcp-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.mcp-feed {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.mcp-empty {
  padding: 16px 10px;
  color: var(--fg-muted);
  text-align: center;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}

.mcp-entry {
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.mcp-entry:last-child { border-bottom: none; }
.mcp-entry:hover { background: var(--bg-hover); }
.mcp-entry.expanded { background: var(--bg-active); }
.mcp-entry.error { background: oklch(0.68 0.2 25 / 0.08); }

.mcp-entry-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mcp-time {
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.mcp-tool {
  color: var(--fg);
  font-weight: 500;
  font-family: var(--font-mono);
  font-size: 11px;
}
.mcp-duration {
  margin-left: auto;
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.mcp-entry-summary {
  color: var(--fg-dim);
  font-size: 11px;
  margin-top: 1px;
  padding-left: 56px;
}
.mcp-entry.error .mcp-entry-summary { color: var(--fail); }
.mcp-entry.started { opacity: 0.8; }
.mcp-duration.running {
  margin-left: auto;
  color: var(--accent);
  font-size: 10px;
  flex-shrink: 0;
  animation: mcp-pulse 1.5s ease-in-out infinite;
}
.mcp-in-progress { font-style: italic; }
.mcp-subtitle { font-size: 10px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-left: 6px; }
.activity-kind { font-size: 9.5px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-left: 6px; }
.mcp-entry.cancelled { opacity: 0.6; }
.activity-entry.activity-prepare .mcp-tool { color: var(--accent); }
.activity-entry.activity-mirror .mcp-tool { color: var(--fg-muted); }
@keyframes mcp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.mcp-entry-detail {
  margin-top: 4px;
  padding: 4px 8px 4px 56px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-dim);
}
.mcp-detail-row {
  display: flex;
  gap: 6px;
  line-height: 1.5;
}
.mcp-detail-key {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.mcp-detail-value {
  word-break: break-all;
}
.mcp-result-block {
  margin-top: 6px;
}
.mcp-result-block:first-child {
  margin-top: 0;
}
.mcp-result-text {
  margin: 3px 0 0;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.mcp-setup {
  text-align: left;
}
/* Segmented source filter (All | Agent | Device) for the merged feed. */
.mcp-filter-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.mcp-filter-btn {
  font-size: 10px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
}
.mcp-filter-btn:hover { color: var(--fg); }
.mcp-filter-btn.active {
  background: var(--bg-active);
  color: var(--fg);
  border-color: var(--fg-muted);
}
.mcp-filter-hidden {
  margin-left: auto;
  font-size: 10px;
  color: var(--fg-dim);
}

/* The connect hint pinned between the header and the feed while no agent is
   attached — the feed itself is rarely empty (background preparation writes
   rows), so the hint cannot live in the empty state alone. Collapsed to a
   single disclosure line so the feed keeps the panel's height. */
.mcp-setup-pinned {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  flex-shrink: 0;
}
.mcp-setup-pinned > summary {
  cursor: pointer;
  color: var(--fg-muted);
  font-weight: 600;
  user-select: none;
}
.mcp-setup-pinned > summary:hover { color: var(--fg); }
.mcp-setup-pinned[open] > summary { margin-bottom: 8px; }
.mcp-setup-title {
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 10px;
  font-size: 12px;
}
.mcp-command {
  margin-bottom: 10px;
}
.mcp-command:last-child { margin-bottom: 0; }
.mcp-command-label {
  font-size: 10px;
  color: var(--fg-dim);
  margin-bottom: 4px;
}
.mcp-command-row {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-elev-2);
}
.mcp-command-text {
  flex: 1;
  padding: 6px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg);
  white-space: nowrap;
  overflow-x: auto;
  line-height: 1.4;
}
.mcp-copy-btn {
  flex-shrink: 0;
  padding: 4px 10px;
  border: none;
  border-left: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--fg-dim);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.mcp-copy-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

/* ─── Tweaks Panel (dev-only) ─── */

.tweaks {
  position: fixed;
  bottom: 12px;
  right: 12px;
  z-index: 9999;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 12px 16px;
  box-shadow: var(--shadow);
  font-size: 11px;
  color: var(--fg-dim);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 180px;
}
.tweaks label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.tweaks input[type="range"] {
  flex: 1;
  accent-color: var(--accent);
}
.tweaks select {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev-2);
  color: var(--fg);
  font-size: 11px;
  font-family: var(--font-sans);
}

/* ─── Scrollbar ─── */

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: var(--border-strong); background-clip: padding-box; }
`;
