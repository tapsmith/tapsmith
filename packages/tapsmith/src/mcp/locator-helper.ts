import { parseSelectorString, resolvePositionalIndex } from '../trace-viewer/components/selector-matching.js';
import type { ParsedSelector } from '../trace-viewer/components/selector-matching.js';
import type { Selector, SelectorKind } from '../selectors.js';
import { makeSelector } from '../selectors.js';
import { buildStrictModeViolationError, collapseSameTargetDuplicates, POLL_INTERVAL_MS } from '../element-handle.js';
import type { TapsmithGrpcClient, ElementInfo } from '../grpc-client.js';

export interface ParsedRuntimeSelector {
  selector: Selector;
  /** Positional chain (.first()/.last()/.nth(n)) parsed from the input, if any. */
  index?: number | 'first' | 'last';
}

export function parseSelectorToInternal(input: string): ParsedRuntimeSelector {
  const parsed = parseSelectorString(input);
  if (!parsed) {
    throw new Error(`Invalid locator: "${input}". Use a Tapsmith locator like device.getByRole("button", { name: "Login" })`);
  }
  return { selector: makeSelector(parsedSelectorToKind(parsed)), index: parsed.index };
}

function parsedSelectorToKind(parsed: ParsedSelector): SelectorKind {
  switch (parsed.type) {
    case 'text':
      return { type: 'text', value: parsed.value };
    case 'textContains':
      // getByText without { exact: true } — substring match, same as the SDK.
      return { type: 'textContains', value: parsed.value };
    case 'role':
      return { type: 'role', value: { role: parsed.value, name: parsed.name ?? '' } };
    case 'contentDesc':
      return { type: 'contentDesc', value: parsed.value };
    case 'hint':
      return { type: 'hint', value: parsed.value };
    case 'testId':
      return { type: 'testId', value: parsed.value };
    case 'className':
      return { type: 'className', value: parsed.value };
    case 'id':
      return { type: 'id', value: parsed.value };
    case 'label':
      return { type: 'label', value: parsed.value };
    default:
      throw new Error(`Unsupported locator type "${parsed.type}" for device actions. Use device.getByRole(), getByText(), getByDescription(), getByPlaceholder(), getByLabel(), or getByTestId().`);
  }
}

/** Format ElementInfo bounds in the hierarchy-XML style: [l,t][r,b]. */
export function formatBounds(bounds: ElementInfo['bounds']): string {
  if (!bounds) return '';
  return `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
}

/**
 * Build a selector targeting one already-resolved element, mirroring the
 * SDK's `_selectorForElement` (element-handle.ts). Used to honor a
 * positional chain when dispatching an action: the raw locator would make
 * the agent act on its first match, so re-target via an identifying
 * property instead.
 */
function selectorForElement(el: ElementInfo): Selector | undefined {
  if (el.resourceId) return makeSelector({ type: 'id', value: el.resourceId });
  if (el.contentDescription) return makeSelector({ type: 'contentDesc', value: el.contentDescription });
  if (el.text) return makeSelector({ type: 'text', value: el.text });
  return undefined;
}

const RESOLVE_TIMEOUT_MS = 5_000;

export interface ResolvedActionTarget {
  /** Selector to dispatch the action with (fallback / display). */
  selector: Selector;
  /**
   * Agent-cached id of the exact element a positional chain (.first()/.last()/
   * .nth(n)) resolved to. When set, dispatch by this instead of `selector` so
   * the action lands on that exact element even if its property is shared with
   * an earlier match.
   */
  elementId?: string;
  /** Error message to surface instead of acting (ambiguous/not found/unaddressable). */
  error?: string;
}

/**
 * Resolve an action target through the runtime find path with the SDK's
 * strict-mode semantics (PILOT-226): polls findElements until the locator
 * matches, errors when it matches more than one element and no positional
 * chain was given, and honors .first()/.last()/.nth(n) by re-targeting the
 * resolved element.
 */
export async function resolveActionTarget(
  client: TapsmithGrpcClient,
  input: string,
): Promise<ResolvedActionTarget> {
  const { selector, index } = parseSelectorToInternal(input);
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

  let elements: ElementInfo[] = [];
  while (true) {
    const res = await client.findElements(selector, POLL_INTERVAL_MS);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — surface it
      // immediately instead of busy-waiting toward a generic "no match".
      return { selector, error: res.errorMessage };
    }
    elements = collapseSameTargetDuplicates(res.elements ?? []);
    if (elements.length > 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (elements.length === 0) {
    return { selector, error: `No elements match ${input} after waiting ${RESOLVE_TIMEOUT_MS}ms. Use tapsmith_snapshot or tapsmith_test_locator to inspect the current screen.` };
  }

  if (index === undefined) {
    if (elements.length > 1) {
      return { selector, error: buildStrictModeViolationError(input, elements).message };
    }
    return { selector };
  }

  // Negative indices count from the end, like the runtime's .nth()
  const idx = resolvePositionalIndex(elements.length, index);
  const el = idx >= 0 && idx < elements.length ? elements[idx] : undefined;
  if (!el) {
    return { selector, error: `Index ${String(index)} is out of range: ${input} matched ${elements.length} element(s).` };
  }
  // Address the EXACT resolved element by its agent-cached id, so the action
  // lands on it even when its identifying property is shared with an earlier
  // match (the agent acts on a bare locator's first document-order match).
  const targeted = selectorForElement(el);
  if (el.elementId) {
    return { selector: targeted ?? selector, elementId: el.elementId };
  }
  // Defensive: agent-resolved matches carry an id; if one is missing there is
  // no exact handle, so fall back to a derived selector when addressable.
  if (!targeted) {
    return { selector, error: `Cannot target match ${String(index)} of ${input}: the element has no resourceId, contentDescription, or text to address it by.` };
  }
  return { selector: targeted };
}
