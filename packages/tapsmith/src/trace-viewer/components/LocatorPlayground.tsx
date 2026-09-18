import { useState, useCallback, useMemo, useRef } from 'preact/hooks';
import { X } from 'lucide-preact';
import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { parseHierarchyXml } from './hierarchy-utils.js';
import { generateSelectors, type GeneratedSelector } from './selector-generation.js';
import { parseSelectorString, findMatchingNodes, getNodeBounds } from './selector-matching.js';
import { disambiguateSelectors } from './selector-uniqueness.js';

// ─── Locator Tab (lives in detail tabs) ───

const LOCATOR_TAB_STYLES = `
  .st-container { display: flex; flex-direction: column; height: 100%; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 12px; }
  .st-input-row { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .st-input-wrap { position: relative; flex: 1; min-width: 0; display: flex; }
  .st-input { flex: 1; padding: 5px 26px 5px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); font-family: inherit; font-size: 12px; outline: none; min-width: 0; }
  .st-clear-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; background: none; border: none; cursor: pointer; color: var(--color-text-faint); padding: 2px; border-radius: 3px; }
  .st-clear-btn:hover { color: var(--color-text-secondary); background: var(--color-bg-hover); }
  .st-input:focus { border-color: var(--color-accent); }
  .st-input::placeholder { color: var(--color-text-faintest); }
  .st-count { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
  .st-count.has-matches { color: var(--color-success); }
  .st-count.no-matches { color: var(--color-error); }
  .st-section-label { padding: 8px 10px 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--color-text-faint); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .st-options { flex: 1; overflow-y: auto; padding: 0 10px 8px; }
  .st-option { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; cursor: pointer; margin-bottom: 2px; }
  .st-option:hover { background: var(--color-bg-hover); }
  .st-option.selected { background: var(--color-bg-selected); }
  .st-option-code { flex: 1; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-option-label { font-size: 10px; color: var(--color-text-faint); flex-shrink: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.3px; }
  .st-option-copy { padding: 2px 6px; background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-accent); cursor: pointer; font-size: 10px; font-family: inherit; flex-shrink: 0; opacity: 0; transition: opacity 0.1s; }
  .st-option:hover .st-option-copy { opacity: 1; }
  .st-option-copy:hover { background: var(--color-border); }
  .st-empty { padding: 10px; color: var(--color-text-faintest); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .st-pick-hint { padding: 10px; color: var(--color-text-muted); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; }
  .st-pick-hint code { background: var(--color-bg-tertiary); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  .st-setup-hint { padding: 4px 10px 6px; font-size: 11px; color: var(--color-text-faint); font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .st-setup-hint code { color: var(--color-text-muted); }
  .st-strict-warning { padding: 6px 10px; font-size: 11px; color: var(--color-warning, #e2b340); border-bottom: 1px solid var(--color-border); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; flex-shrink: 0; }
  .st-strict-warning code { background: var(--color-bg-tertiary); padding: 1px 4px; border-radius: 3px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 10px; }
  .st-source-toggle { display: inline-flex; border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
  .st-source-btn { padding: 4px 8px; background: var(--color-bg); border: none; color: var(--color-text-muted); cursor: pointer; font-size: 10px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.3px; }
  .st-source-btn + .st-source-btn { border-left: 1px solid var(--color-border); }
  .st-source-btn.active { background: var(--color-bg-selected); color: var(--color-accent); }
  .st-source-btn:hover:not(.active):not(:disabled) { background: var(--color-bg-hover); }
  .st-source-btn:disabled { opacity: 0.4; cursor: default; }
`;

let stStylesInjected = false;
function injectStStyles() {
  if (stStylesInjected) return;
  stStylesInjected = true;
  const el = document.createElement('style');
  el.textContent = LOCATOR_TAB_STYLES;
  document.head.appendChild(el);
}

/**
 * Bounds of every element the selector matches in the given tree — drawn as
 * the purple match overlay. Derived (not pushed through state) so the overlay
 * can never go stale relative to the hierarchy it was computed from: hosts
 * recompute it whenever the bound hierarchy changes (live refresh, action
 * selection, Before/After screenshot tab).
 */
export function computeSelectorHighlights(roots: HierarchyNode[], selector: string): Bounds[] {
  if (!selector.trim() || roots.length === 0) return [];
  const parsed = parseSelectorString(selector);
  if (!parsed) return [];
  return findMatchingNodes(roots, parsed)
    .map(getNodeBounds)
    .filter((b): b is Bounds => b !== null);
}

interface LocatorTabProps {
  hierarchyXml: string | undefined
  pickedNode: HierarchyNode | null
  selector: string
  onSelectorChange: (selector: string) => void
  /** Hierarchy the tab is bound to (UI mode only): 'trace' = the selected
   * action's captured hierarchy, 'live' = the device mirror's current UI.
   * The toggle renders only when both source props are provided — the static
   * trace viewer has no live device and omits them. */
  source?: 'trace' | 'live'
  onSourceChange?: (source: 'trace' | 'live') => void
  /** False when there is no live device to bind to (server disconnected). */
  liveSourceAvailable?: boolean
}

export function LocatorTab({ hierarchyXml, pickedNode, selector, onSelectorChange, source, onSourceChange, liveSourceAvailable }: LocatorTabProps) {
  injectStStyles();

  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const roots = useMemo(
    () => hierarchyXml ? parseHierarchyXml(hierarchyXml) : [],
    [hierarchyXml],
  );

  const generatedSelectors = useMemo<GeneratedSelector[]>(() => {
    // No hierarchy for this state (e.g. an action without a captured
    // snapshot) → nothing to validate against, so suggest nothing rather
    // than passing stale suggestions through unvalidated.
    if (!pickedNode || roots.length === 0) return [];
    // Validate against the hierarchy under runtime semantics: ambiguous
    // suggestions are upgraded ({ exact: true } / role name) or get a
    // positional chain appended (selector-uniqueness.ts). Suggestions that no
    // longer resolve to the picked node are dropped entirely — the list always
    // reflects the current hierarchy (the live screen changes under a pick;
    // the trace binding switches with the Before/After screenshot tabs), and
    // an element that comes back on a later refresh brings them back.
    return disambiguateSelectors(roots, pickedNode, generateSelectors(pickedNode))
      .filter((s) => !s.mayNotMatch);
  }, [pickedNode, roots]);

  const isWebViewPick = pickedNode?.attributes.get('webview') === 'true';

  const matchCount = useMemo(() => {
    if (!selector.trim() || roots.length === 0) return null;
    const parsed = parseSelectorString(selector);
    if (!parsed) return null;
    return findMatchingNodes(roots, parsed).length;
  }, [selector, roots]);

  const inputRef = useRef<HTMLInputElement>(null);

  const handleInput = useCallback((e: Event) => {
    onSelectorChange((e.target as HTMLInputElement).value);
  }, [onSelectorChange]);

  const handleClear = useCallback(() => {
    onSelectorChange('');
    inputRef.current?.focus();
  }, [onSelectorChange]);

  const handleCopy = useCallback((code: string, idx: number) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  }, []);

  const handleSelectOption = useCallback((code: string) => {
    onSelectorChange(code);
  }, [onSelectorChange]);

  const countLabel = matchCount === null
    ? ''
    : matchCount === 1
      ? '1 match'
      : `${matchCount} matches`;

  const countClass = matchCount === null
    ? 'st-count'
    : matchCount > 0
      ? 'st-count has-matches'
      : 'st-count no-matches';

  // Strict mode (PILOT-226): an ambiguous locator without a positional
  // chain will throw at runtime — warn here, where the user is composing it.
  const hasPositionalChain = /\.(first|last)\(\)|\.nth\(\s*-?\d+\s*\)/.test(selector);
  const strictWarning = matchCount !== null && matchCount > 1 && !hasPositionalChain;

  return (
    <div class="st-container">
      <div class="st-input-row">
        {source && onSourceChange && (
          <div class="st-source-toggle" role="group" aria-label="Locator hierarchy source">
            <button
              type="button"
              class={`st-source-btn${source === 'trace' ? ' active' : ''}`}
              onClick={() => onSourceChange('trace')}
              title="Match against the selected action's captured hierarchy"
            >
              Trace
            </button>
            <button
              type="button"
              class={`st-source-btn${source === 'live' ? ' active' : ''}`}
              onClick={() => onSourceChange('live')}
              disabled={liveSourceAvailable === false}
              title={liveSourceAvailable === false
                ? 'No live device connected'
                : "Match against the live device mirror's current UI"}
            >
              Live
            </button>
          </div>
        )}
        <div class="st-input-wrap">
          <input
            ref={inputRef}
            class="st-input"
            type="text"
            aria-label="Locator"
            placeholder='device.getByText("Login") · device.getByRole("button", { name: "Submit" })'
            value={selector}
            onInput={handleInput}
          />
          {selector !== '' && (
            <button
              type="button"
              class="st-clear-btn"
              onClick={handleClear}
              aria-label="Clear locator"
              title="Clear locator"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        <span class={countClass} data-testid="locator-match-count">{countLabel}</span>
      </div>
      {strictWarning && (
        <div class="st-strict-warning" data-testid="locator-strict-warning">
          ⚠ {matchCount} matches — runtime actions/assertions will throw a strict
          mode violation. Refine the locator (<code>{'{ exact: true }'}</code>,{' '}
          <code>getByRole</code>) or add <code>.first()</code>.
        </div>
      )}
      <div class="st-options" data-testid="locator-suggestions">
        {generatedSelectors.length > 0 && (
          <>
            <div class="st-section-label">Suggested locators</div>
            {isWebViewPick && (
              <div class="st-setup-hint">
                <code>const webview = await device.webview()</code>
              </div>
            )}
            {generatedSelectors.map((s, i) => (
              <div
                key={i}
                class={`st-option${selector === s.code ? ' selected' : ''}`}
                data-testid="locator-option"
                data-selected={selector === s.code}
                onClick={() => handleSelectOption(s.code)}
              >
                <span class="st-option-code" data-testid="locator-code">{s.code}</span>
                <span class="st-option-label">{s.label}</span>
                <button
                  class="st-option-copy"
                  onClick={(e) => { e.stopPropagation(); handleCopy(s.code, i); }}
                >
                  {copiedIdx === i ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ))}
          </>
        )}
        {generatedSelectors.length === 0 && !selector && (
          <div class="st-pick-hint">
            Click the <code>⊙</code> button on the screenshot{source ? ' or the device mirror' : ''} to pick an element, or type a locator above to highlight matches.
          </div>
        )}
      </div>
    </div>
  );
}

// Pick/hover logic lives in selector-pick.ts (plain TS, unit-testable);
// re-exported here for the UI entry points that import from this module.
export { handlePickFromScreenshot, handleHoverFromScreenshot, isWebViewOverlayPending } from './selector-pick.js';
