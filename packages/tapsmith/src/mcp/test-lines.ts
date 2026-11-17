/**
 * The test lines MCP action tools answer with.
 *
 * Each successful action returns the SDK line that repeats it — `await
 * device.getByRole("button", { name: "Sign in" }).tap();` — for the agent to
 * write into the test as it goes. A locator line is given only once its
 * locator is verified: the device agent resolved it to exactly the element
 * the action acted on, on the screen the action started from (see
 * action-lines.ts). Nothing is kept server-side: each line is already in the
 * agent's context.
 */

import { escapeJsString } from '../js-string-escape.js';

// ─── Line builders ───

/** A JavaScript string literal for `value`, as a test would write it. */
export function stringLiteral(value: string): string {
  return `"${escapeJsString(value)}"`;
}

export function deviceCallLine(method: string, ...args: string[]): string {
  return `await device.${method}(${args.join(', ')});`;
}

export function swipeLine(direction: string): string {
  return deviceCallLine('swipe', stringLiteral(direction));
}

export function pressKeyLine(key: string): string {
  return deviceCallLine('pressKey', stringLiteral(key));
}

export function launchAppLine(packageName: string, clearData: boolean): string {
  return clearData
    ? deviceCallLine('launchApp', stringLiteral(packageName), '{ clearData: true }')
    : deviceCallLine('launchApp', stringLiteral(packageName));
}

/** `await <locator>.<method>(<args>);` */
export function locatorCallLine(locator: string, method: string, ...args: string[]): string {
  return `await ${locator.trim()}.${method}(${args.join(', ')});`;
}

// ─── What an action tool says about its line ───

/**
 * How the line's locator was checked:
 *
 * - `verified`: the runtime resolved it to exactly the element acted on
 *   (the device agent; for a `webview.` locator, the page). `replaced` is the
 *   position-dependent locator it stands in for, when there was one.
 * - `positional`: the locator picks its element by position
 *   (`.first()`/`.last()`/`.nth()`) and the agent found no locator that
 *   matches that element alone. Still the element acted on, so the line is
 *   given, flagged.
 * - `unverified`: it could not be checked, so no line is given.
 */
export type LineCheck =
  | { status: 'verified'; locator: string; replaced?: string }
  | { status: 'positional'; locator: string; detail: string }
  | { status: 'unverified'; reason: string };

/** The comment a position-dependent line carries into the test. */
export const POSITIONAL_COMMENT = '// position-dependent: no locator matched this element alone';

/**
 * What an action tool says after `OK` about its test line. `line` builds the
 * statement from the checked locator.
 */
export function describeLine(check: LineCheck, line: (locator: string) => string): string {
  if (check.status === 'unverified') {
    return `Test line: none, the locator could not be verified (${check.reason}). `
      + 'Check a locator with tapsmith_test_locator before putting it in a test.';
  }
  const statement = line(check.locator);
  if (check.status === 'positional') {
    return `Test line (position-dependent): ${statement} ${POSITIONAL_COMMENT}\n${check.detail}`;
  }
  if (check.replaced) {
    return `Test line: ${statement}\n(${check.replaced.trim()} picks its element by position; the device agent matched this locator `
      + 'to that same element alone, so the line uses it instead.)';
  }
  return `Test line: ${statement}`;
}

/** The `OK` result of an action, followed by what it says about its test line. */
export function actionLineResult(lineText: string) {
  return { content: [{ type: 'text' as const, text: `OK\n${lineText}` }] };
}
