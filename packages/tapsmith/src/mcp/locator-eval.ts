/**
 * Locator strings from MCP clients, built by the SDK's own locator builder
 * (PILOT-848).
 *
 * `device.getByRole("list").getByText("Row 2")` sent to an MCP tool becomes
 * exactly the handle a test writing that line gets: the string is parsed
 * (acorn), and each `device.…` / `webview.…` call in it is made on a real
 * Device / ElementHandle / WebViewHandle / WebViewLocator. No second grammar
 * of matching semantics can drift from the runtime, and chains (scoped
 * getters, `filter`, `and`, `or`, positions) work as they do in a test.
 *
 * The string comes from an AI agent, so it is interpreted, never executed:
 * only the locator-building methods below, with literal arguments (strings,
 * numbers, booleans, RegExp literals, plain option objects, nested locators
 * where the SDK takes one) are accepted. Anything else is refused with an
 * error naming it, before any SDK call is made for that part.
 */

import { parse } from 'acorn';
import type { CallExpression, Expression, Node, ObjectExpression, Program, SpreadElement } from 'acorn';
import type { Device } from '../device.js';
import type { ElementHandle } from '../element-handle.js';
import type { Selector } from '../selectors.js';
import type { WebViewHandle } from '../webview-handle.js';
import type { WebViewLocator } from '../webview-locator.js';

export interface LocatorRoots {
  /** The device `device.…` locators are built on. Building does no I/O. */
  device: Device
  /** The WebView `webview.…` locators are built on; connected only when used. */
  webview: () => Promise<WebViewHandle>
}

type Expr = Expression | SpreadElement;

export type EvaluatedLocator =
  | { kind: 'native'; handle: ElementHandle }
  | { kind: 'webview'; locator: WebViewLocator };

// ─── What may be called ───

type ValueType = 'string' | 'textOrRegex' | 'number' | 'boolean' | 'nativeLocator';
interface Param {
  type: ValueType | { options: Record<string, ValueType>; atLeastOne?: boolean }
  optional?: boolean
}

const text = (): Param => ({ type: 'string' });
const textOrRegex = (): Param => ({ type: 'textOrRegex' });

/** Getters a native root (device) and a native locator (scoped) share. */
const NATIVE_GETTERS: Record<string, Param[]> = {
  getByText: [textOrRegex(), { type: { options: { exact: 'boolean' } }, optional: true }],
  getByRole: [text(), {
    type: { options: { name: 'textOrRegex', exact: 'boolean', checked: 'boolean', disabled: 'boolean', selected: 'boolean', expanded: 'boolean' } },
    optional: true,
  }],
  getByDescription: [text()],
  getByPlaceholder: [text()],
  getByTestId: [text()],
  getByLabel: [textOrRegex()],
  locator: [{ type: { options: { id: 'string', xpath: 'string', className: 'string' }, atLeastOne: true } }],
};

const POSITIONS: Record<string, Param[]> = {
  first: [],
  last: [],
  nth: [{ type: 'number' }],
};

const NATIVE_LOCATOR_METHODS: Record<string, Param[]> = {
  ...NATIVE_GETTERS,
  ...POSITIONS,
  filter: [{ type: { options: { hasText: 'textOrRegex', has: 'nativeLocator', hasNot: 'nativeLocator', hasNotText: 'textOrRegex' }, atLeastOne: true } }],
  and: [{ type: 'nativeLocator' }],
  or: [{ type: 'nativeLocator' }],
};

const WEBVIEW_GETTERS: Record<string, Param[]> = {
  getByText: [text(), { type: { options: { exact: 'boolean' } }, optional: true }],
  getByRole: [text(), { type: { options: { name: 'string' } }, optional: true }],
  getByPlaceholder: [text()],
  getByTestId: [text()],
  getByLabel: [text()],
  locator: [text()],
};

/** Calls an agent may plausibly append that end a locator rather than build one. */
const ACTIONS = new Set([
  'tap', 'doubleTap', 'longPress', 'type', 'fill', 'clear', 'clearAndType', 'press', 'check', 'uncheck', 'setChecked',
  'swipe', 'scrollIntoView', 'focus', 'blur', 'selectOption', 'dragTo', 'count', 'all', 'textContent', 'getText',
  'isVisible', 'isHidden', 'isEnabled', 'isChecked', 'boundingBox', 'screenshot', 'waitFor', 'highlight',
]);

// ─── Errors ───

const EXAMPLE = 'Write a locator as in a test: device.getByRole("button", { name: "Login" }), '
  + 'device.getByText(), getByDescription(), getByPlaceholder(), getByLabel(), getByTestId(), '
  + 'or webview.getByText() and friends, chained as in a test';

class LocatorError extends Error {}

function refuse(source: string, reason: string): never {
  throw new LocatorError(`Invalid locator: "${source}": ${reason}.`);
}

// ─── Interpreter ───

type Built =
  | { kind: 'device' }
  | { kind: 'webviewRoot' }
  | { kind: 'native'; handle: ElementHandle }
  | { kind: 'webview'; locator: WebViewLocator };

/**
 * Build the locator `source` describes on the SDK's own builder, or throw an
 * error naming the part that is not a locator. Never executes `source`.
 */
export async function evaluateLocator(source: string, roots: LocatorRoots): Promise<EvaluatedLocator> {
  const expression = parseLocator(source);
  // Check the whole string first, calling nothing: a refused locator never
  // reaches the SDK or connects to a WebView.
  const checked: Context = { source, device: roots.device, dry: true, usesWebview: false };
  build(expression, checked);
  const webview = checked.usesWebview ? await roots.webview() : undefined;
  return located(build(expression, { source, device: roots.device, webview, dry: false, usesWebview: false }), source);
}

/**
 * The plain Selector a native locator string builds (synchronously, on
 * `device`'s builder), or null when it is a WebView locator or carries
 * anything a Selector alone cannot hold (a position, filter, scope, and/or).
 * Throws {@link isLocatorError} errors like {@link evaluateLocator}.
 */
export function nativeSelectorOf(source: string, device: Device): Selector | null {
  const expression = parseLocator(source);
  const checked: Context = { source, device, dry: true, usesWebview: false };
  build(expression, checked);
  if (checked.usesWebview) return null;
  const built = located(build(expression, { source, device, dry: false, usesWebview: false }), source);
  return built.kind === 'native' ? built.handle._plainSelector() ?? null : null;
}

function located(built: Built, source: string): EvaluatedLocator {
  if (built.kind === 'device' || built.kind === 'webviewRoot') {
    refuse(source, 'it names no element — add a getter such as .getByText("…")');
  }
  return built;
}

function parseLocator(source: string): Expr {
  const trimmed = source.trim();
  if (!trimmed) refuse(source, 'the locator is empty');

  let program: Program;
  try {
    program = parse(trimmed, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true });
  } catch (err) {
    refuse(source, `Invalid locator syntax (${err instanceof Error ? err.message : String(err)}). ${EXAMPLE}`);
  }
  const statements = program.body.filter((s) => s.type !== 'EmptyStatement');
  if (statements.length !== 1 || statements[0].type !== 'ExpressionStatement') {
    refuse(source, 'a locator string is one locator expression, e.g. device.getByRole("button", { name: "Save" })');
  }
  const expression = statements[0].expression;
  if (expression.type === 'AwaitExpression') {
    refuse(source, 'a locator string is the locator alone: drop `await`, and any action such as `.tap()`');
  }
  return expression;
}

interface Context {
  source: string
  device: Device
  /** The connected WebView; set for the building pass when the check saw `webview.`. */
  webview?: WebViewHandle
  /** Checking only: no builder call is made, and built values are placeholders. */
  dry: boolean
  /** Set by the checking pass when the locator starts at `webview`. */
  usesWebview: boolean
}

/**
 * The root a receiver names: `device` / `webview`, and the spellings the
 * docs, the trace's action list and screen objects use for them (`page.`,
 * `this.device.`, `this.page.`, `this.webview.`; PILOT-717).
 */
function rootOf(node: Expr): 'device' | 'webview' | undefined {
  let name: string | undefined;
  if (node.type === 'Identifier') name = node.name;
  else if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'ThisExpression' && node.property.type === 'Identifier') {
    name = node.property.name;
  }
  if (name === 'device' || name === 'page') return 'device';
  if (name === 'webview') return 'webview';
  return undefined;
}

function build(node: Expr, ctx: Context): Built {
  const root = rootOf(node);
  if (root) {
    if (root === 'webview') ctx.usesWebview = true;
    return root === 'device' ? { kind: 'device' } : { kind: 'webviewRoot' };
  }
  // A getter written without a receiver (`getByText("x")`) is a device getter.
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && !node.optional
    && Object.hasOwn(NATIVE_GETTERS, node.callee.name)) {
    return call({ kind: 'device' }, node.callee.name, node, ctx);
  }
  if (node.type === 'MemberExpression') {
    if (node.computed) refuse(ctx.source, 'computed member access (`x[…]`) is not part of a locator');
    const name = node.property.type === 'Identifier' ? node.property.name : '?';
    refuse(ctx.source, `\`.${name}\` is not a locator method — call one, e.g. .getByText("…")`);
  }
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.optional) {
    refuse(ctx.source, 'a locator must start with `device.` or `webview.`, e.g. device.getByRole("button", { name: "Save" })');
  }
  const callee = node.callee;
  if (callee.computed) refuse(ctx.source, 'computed member access (`x[…]`) is not part of a locator');
  if (callee.object.type === 'Super' || callee.property.type !== 'Identifier') {
    refuse(ctx.source, 'a locator must start with `device.` or `webview.`');
  }
  return call(build(callee.object, ctx), callee.property.name, node, ctx);
}

/** Make the allowlisted `method` call `node` on what `target` built. */
function call(target: Built, method: string, node: CallExpression, ctx: Context): Built {
  const table = methodsOf(target);
  const params = Object.hasOwn(table, method) ? table[method] : undefined;
  if (!params) {
    if (ACTIONS.has(method)) {
      refuse(ctx.source, `\`.${method}()\` is an action or query, not part of a locator — pass the locator alone`);
    }
    if (target.kind === 'webview' || target.kind === 'webviewRoot') {
      refuse(ctx.source, `\`.${method}()\` is not available on webview locators (supported: ${Object.keys(table).map((m) => `.${m}()`).join(', ')})`);
    }
    refuse(ctx.source, `\`.${method}()\` is not a locator method`);
  }

  const args = buildArgs(node.arguments, params, method, ctx);
  if (ctx.dry) {
    const kind = target.kind === 'device' || target.kind === 'native' ? 'native' : 'webview';
    return kind === 'native'
      ? { kind, handle: undefined as unknown as ElementHandle }
      : { kind, locator: undefined as unknown as WebViewLocator };
  }
  switch (target.kind) {
    case 'device':
      return { kind: 'native', handle: invoke(ctx.device, method, args) as ElementHandle };
    case 'native':
      return { kind: 'native', handle: invoke(target.handle, method, args) as ElementHandle };
    case 'webviewRoot':
      if (!ctx.webview) throw new Error('internal: the WebView was not connected for a webview locator');
      return { kind: 'webview', locator: invoke(ctx.webview, method, args) as WebViewLocator };
    case 'webview':
      return { kind: 'webview', locator: invoke(target.locator, method, args) as WebViewLocator };
  }
}

function methodsOf(target: Built): Record<string, Param[]> {
  switch (target.kind) {
    case 'device': return NATIVE_GETTERS;
    case 'native': return NATIVE_LOCATOR_METHODS;
    case 'webviewRoot': return WEBVIEW_GETTERS;
    case 'webview': return POSITIONS;
  }
}

/** Call an allowlisted builder method on an SDK object. */
function invoke(target: object, method: string, args: unknown[]): unknown {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`internal: ${method} is not a method of the locator builder`);
  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

function buildArgs(nodes: Expr[], params: Param[], method: string, ctx: Context): unknown[] {
  const required = params.filter((p) => !p.optional).length;
  if (nodes.length < required || nodes.length > params.length) {
    const count = required === params.length ? `${required}` : `${required}–${params.length}`;
    refuse(ctx.source, `\`.${method}()\` expects ${count} argument(s), got ${nodes.length}`);
  }
  const out: unknown[] = [];
  for (const [i, node] of nodes.entries()) {
    const param = params[i];
    out.push(typeof param.type === 'string'
      ? value(node, param.type, `argument ${i + 1} of .${method}()`, ctx)
      : options(node, param.type.options, param.type.atLeastOne ?? false, method, ctx));
  }
  return out;
}

function options(
  node: Expr,
  schema: Record<string, ValueType>,
  atLeastOne: boolean,
  method: string,
  ctx: Context,
): Record<string, unknown> {
  if (node.type !== 'ObjectExpression') refuse(ctx.source, `the options argument of .${method}() must be an object literal`);
  const out: Record<string, unknown> = {};
  for (const prop of (node as ObjectExpression).properties) {
    if (prop.type === 'SpreadElement') refuse(ctx.source, 'spread (`...`) is not part of a locator');
    if (prop.computed) refuse(ctx.source, 'computed option names (`[…]`) are not part of a locator');
    if (prop.kind !== 'init' || prop.method) refuse(ctx.source, `.${method}() options are plain values, not getters or methods`);
    const key = prop.key.type === 'Identifier' ? prop.key.name
      : prop.key.type === 'Literal' && typeof prop.key.value === 'string' ? prop.key.value : undefined;
    if (key === undefined) refuse(ctx.source, `.${method}() option names must be plain names`);
    if (key === '__proto__') refuse(ctx.source, '`__proto__` is not a locator option');
    if (Object.hasOwn(out, key)) refuse(ctx.source, `option "${key}" is given twice`);
    if (!Object.hasOwn(schema, key)) {
      refuse(ctx.source, `unsupported option "${key}" for .${method}() (supported: ${Object.keys(schema).join(', ')})`);
    }
    if (prop.shorthand) refuse(ctx.source, `option "${key}" needs a literal value`);
    out[key] = value(prop.value as Expression, schema[key], `\`${key}\``, ctx);
  }
  if (atLeastOne && Object.keys(out).length === 0) {
    refuse(ctx.source, `.${method}() needs one of: ${Object.keys(schema).join(', ')}`);
  }
  return out;
}

function value(node: Expr | Node, type: ValueType, what: string, ctx: Context): unknown {
  if (type === 'nativeLocator') {
    const built = build(node as Expression, ctx);
    if (built.kind !== 'native') refuse(ctx.source, `${what} must be a native locator (device.…)`);
    return built.handle;
  }
  const literal = literalOf(node as Expression, ctx);
  const ok =
    type === 'string' ? typeof literal === 'string'
      : type === 'textOrRegex' ? typeof literal === 'string' || literal instanceof RegExp
        : type === 'number' ? typeof literal === 'number'
          : typeof literal === 'boolean';
  if (!ok) {
    const expected = type === 'textOrRegex' ? 'a string or a RegExp literal' : `a ${type}`;
    refuse(ctx.source, `${what} must be ${expected}`);
  }
  return literal;
}

/** A literal's value; anything that would need evaluating is refused. */
function literalOf(node: Expression, ctx: Context): unknown {
  switch (node.type) {
    case 'Literal':
      if ('regex' in node && node.regex) {
        try {
          return new RegExp(node.regex.pattern, node.regex.flags);
        } catch (err) {
          refuse(ctx.source, `invalid RegExp /${node.regex.pattern}/${node.regex.flags} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (node.value === null || typeof node.value === 'bigint') refuse(ctx.source, 'argument values must be strings, numbers, booleans or RegExp literals');
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) refuse(ctx.source, 'template literals with `${…}` are not part of a locator; write the text out');
      return node.quasis[0].value.cooked;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value;
      }
      break;
    default:
      break;
  }
  refuse(ctx.source, 'each argument must be a literal value (a string, number, boolean or RegExp), not an expression');
}

/** Whether `err` is a refusal from {@link evaluateLocator} (its message is user-facing). */
export function isLocatorError(err: unknown): err is Error {
  return err instanceof LocatorError;
}
