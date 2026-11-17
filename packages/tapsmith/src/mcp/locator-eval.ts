/**
 * Locator strings from MCP clients, built by the SDK's own locator builder.
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

/** @internal */
export type Expr = Expression | SpreadElement;

export type EvaluatedLocator =
  | { kind: 'native'; handle: ElementHandle }
  | { kind: 'webview'; locator: WebViewLocator };

// ─── What may be called ───

/** @internal — What a literal argument may be. */
export type ValueType =
  | 'string' | 'textOrRegex' | 'integer' | 'boolean' | 'nativeLocator' | 'plainNativeLocator'
  /** A string, a RegExp, or an array literal of them (toHaveText's expected). */
  | 'textExpected'
  /** A finite number. */
  | 'number'
  /** A string, number or boolean. */
  | 'scalar';

/** @internal — An object-literal argument: its allowed keys and their types. */
export interface OptionsSpec {
  options: Record<string, ValueType>
  atLeastOne?: boolean
  /** Keys that must be given. */
  required?: string[]
}

/** @internal — An argument's type; `anyOf` is a value or an options object, told apart by syntax. */
export type ParamType = ValueType | OptionsSpec | { anyOf: Array<ValueType | OptionsSpec> };

/** @internal — One parameter of an allowlisted method. */
export interface Param {
  type: ParamType
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
  nth: [{ type: 'integer' }],
};

const NATIVE_LOCATOR_METHODS: Record<string, Param[]> = {
  ...NATIVE_GETTERS,
  ...POSITIONS,
  filter: [{ type: { options: { hasText: 'textOrRegex', has: 'plainNativeLocator', hasNot: 'plainNativeLocator', hasNotText: 'textOrRegex' }, atLeastOne: true } }],
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

class LocatorError extends Error {
  constructor(
    message: string,
    /** Why it was refused, without the source it was refused in. */
    readonly reason: string,
    /** Offset of the refused part in the parsed text, when known. */
    readonly at: number | undefined,
  ) {
    super(message);
  }
}

function refuse(source: string, reason: string, at?: { start: number }, noun = 'locator'): never {
  throw new LocatorError(`Invalid ${noun}: "${source}": ${reason}.`, reason, at?.start);
}

/** Refuse a part of what `ctx` is building, naming it as a locator or a statement. */
function fail(ctx: Pick<Context, 'source' | 'noun'>, reason: string, at?: { start: number }): never {
  refuse(ctx.source, reason, at, ctx.noun);
}

// ─── Interpreter ───

/** @internal — What a locator expression builds. */
export type Built =
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
  located(build(expression, checked), source);
  const webview = checked.usesWebview ? await roots.webview() : undefined;
  return located(build(expression, { source, device: roots.device, webview, dry: false, usesWebview: false }), source);
}

/**
 * `source` as a test writes it with the `device` fixture: the receivers the
 * tools also accept (`page.`, `this.device.`, `this.page.`, `this.webview.`,
 * or a getter with none) are spelled `device.` / `webview.`, at the root and
 * in nested locators alike. Everything else is kept as written. Only parses:
 * call it on a string {@link evaluateLocator} accepted. Throws
 * {@link isLocatorError} errors for one that does not parse.
 */
export function canonicalLocatorSource(source: string): string {
  const trimmed = source.trim();
  return canonicalSourceOf(trimmed, parseLocator(trimmed));
}

/**
 * @internal — The text of `node` (parsed from `text`) with its receivers
 * spelled as {@link canonicalLocatorSource} spells them.
 */
export function canonicalSourceOf(text: string, node: Node): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (child: unknown): void => {
    if (!child || typeof child !== 'object') return;
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    const n = child as Node & { type: string };
    if (typeof n.type !== 'string') return;
    const expr = n as Expr;
    const root = rootOf(expr);
    if (root) {
      if (text.slice(n.start, n.end) !== root) edits.push({ start: n.start, end: n.end, text: root });
      return;
    }
    if (expr.type === 'CallExpression' && expr.callee.type === 'Identifier' && Object.hasOwn(NATIVE_GETTERS, expr.callee.name)) {
      edits.push({ start: expr.callee.start, end: expr.callee.start, text: 'device.' });
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'loc' && key !== 'range') visit(value);
    }
  };
  visit(node);
  let out = text.slice(node.start, node.end);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start - node.start) + edit.text + out.slice(edit.end - node.start);
  }
  return out;
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
  located(build(expression, checked), source);
  if (checked.usesWebview) return null;
  const built = located(build(expression, { source, device, dry: false, usesWebview: false }), source);
  return built.kind === 'native' ? built.handle._plainSelector() ?? null : null;
}

/** @internal — `built` as a locator, refusing a bare root. */
export function located(built: Built, source: string, at?: { start: number }, noun?: 'locator' | 'statement'): EvaluatedLocator {
  if (built.kind === 'device' || built.kind === 'webviewRoot') {
    refuse(source, 'it names no element — add a getter such as .getByText("…")', at, noun);
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

/** @internal — What a pass over a locator (or a statement's locators) builds with. */
export interface Context {
  /** The text refusals quote: the locator, or the statement it is part of. */
  source: string
  /** What a refusal calls `source`: `Invalid locator: …` or `Invalid statement: …`. */
  noun?: 'locator' | 'statement'
  /** The device locators are built on; a dry pass needs none. */
  device?: Device
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
 * `this.device.`, `this.page.`, `this.webview.`).
 */
export function rootOf(node: Expr | Node): 'device' | 'webview' | undefined {
  const n = node as Expr;
  let name: string | undefined;
  if (n.type === 'Identifier') name = n.name;
  else if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'ThisExpression' && n.property.type === 'Identifier') {
    name = n.property.name;
  }
  if (name === 'device' || name === 'page') return 'device';
  if (name === 'webview') return 'webview';
  return undefined;
}

/** @internal — Build (or, dry, check) the locator expression `node`. */
export function build(node: Expr, ctx: Context): Built {
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
    if (node.object.type !== 'CallExpression' && !rootOf(node.object)) {
      fail(ctx, 'a locator must start with `device.` or `webview.`, e.g. device.getByRole("button", { name: "Save" })', node.object);
    }
    if (node.computed) fail(ctx, 'computed member access (`x[…]`) is not part of a locator', node.property);
    const name = node.property.type === 'Identifier' ? node.property.name : '?';
    fail(ctx, `\`.${name}\` is not a locator method — call one, e.g. .getByText("…")`, node.property);
  }
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.optional) {
    fail(ctx, 'a locator must start with `device.` or `webview.`, e.g. device.getByRole("button", { name: "Save" })', node);
  }
  const callee = node.callee;
  if (callee.computed) fail(ctx, 'computed member access (`x[…]`) is not part of a locator', callee.property);
  if (callee.object.type === 'Super' || callee.property.type !== 'Identifier') {
    fail(ctx, 'a locator must start with `device.` or `webview.`', callee);
  }
  return call(build(callee.object, ctx), callee.property.name, node, ctx);
}

/** Make the allowlisted `method` call `node` on what `target` built. */
function call(target: Built, method: string, node: CallExpression, ctx: Context): Built {
  const table = methodsOf(target);
  const params = Object.hasOwn(table, method) ? table[method] : undefined;
  const at = node.callee.type === 'MemberExpression' ? node.callee.property : node.callee;
  if (!params) {
    if (ACTIONS.has(method)) {
      fail(ctx, `\`.${method}()\` is an action or query, not part of a locator — pass the locator alone`, at);
    }
    if (target.kind === 'webview' || target.kind === 'webviewRoot') {
      fail(ctx, `\`.${method}()\` is not available on webview locators (supported: ${Object.keys(table).map((m) => `.${m}()`).join(', ')})`, at);
    }
    fail(ctx, `\`.${method}()\` is not a locator method`, at);
  }

  const args = buildArgs(node.arguments, params, method, ctx, node);
  if (ctx.dry) {
    const kind = target.kind === 'device' || target.kind === 'native' ? 'native' : 'webview';
    return kind === 'native'
      ? { kind, handle: undefined as unknown as ElementHandle }
      : { kind, locator: undefined as unknown as WebViewLocator };
  }
  switch (target.kind) {
    case 'device':
      if (!ctx.device) throw new Error('internal: a locator was built with no device');
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

/** @internal — Call an allowlisted method on an SDK object. */
export function invoke(target: object, method: string, args: unknown[]): unknown {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`internal: ${method} is not a method of the locator builder`);
  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

/**
 * @internal — The arguments `nodes` of a call to `method`, checked against
 * `params` (built, unless dry). `call` is where a count mismatch is reported.
 */
export function buildArgs(nodes: Expr[], params: Param[], method: string, ctx: Context, call: { start: number }): unknown[] {
  const required = params.filter((p) => !p.optional).length;
  if (nodes.length < required || nodes.length > params.length) {
    const count = required === params.length ? `${required}` : `${required}–${params.length}`;
    fail(ctx, `\`.${method}()\` expects ${count} argument(s), got ${nodes.length}`, nodes[params.length] ?? call);
  }
  return nodes.map((node, i) => argument(node, params[i].type, `argument ${i + 1} of .${method}()`, method, ctx));
}

function argument(node: Expr | Node, type: ParamType, what: string, method: string, ctx: Context): unknown {
  if (typeof type === 'string') return value(node, type, what, ctx);
  if ('anyOf' in type) {
    // One shape per syntax: an object literal is the options form, anything else the value.
    const isObject = (node as Expr).type === 'ObjectExpression';
    const pick = type.anyOf.find((t) => (typeof t === 'string') !== isObject);
    if (!pick) fail(ctx, `${what} must be ${type.anyOf.map(describeType).join(' or ')}`, node);
    return argument(node, pick, what, method, ctx);
  }
  return options(node, type, method, ctx);
}

function describeType(type: ValueType | OptionsSpec): string {
  if (typeof type !== 'string') return `an options object { ${Object.keys(type.options).join(', ')} }`;
  return TYPE_NAMES[type];
}

const TYPE_NAMES: Record<ValueType, string> = {
  string: 'a string',
  textOrRegex: 'a string or a RegExp literal',
  textExpected: 'a string, a RegExp literal, or an array of them',
  integer: 'an integer',
  number: 'a number',
  boolean: 'a boolean',
  scalar: 'a string, number or boolean',
  nativeLocator: 'a native locator (device.…)',
  plainNativeLocator: 'a native locator (device.…)',
};

function options(node: Expr | Node, spec: OptionsSpec, method: string, ctx: Context): Record<string, unknown> {
  const schema = spec.options;
  if ((node as Expr).type !== 'ObjectExpression') fail(ctx, `the options argument of .${method}() must be an object literal`, node);
  const out: Record<string, unknown> = {};
  for (const prop of (node as ObjectExpression).properties) {
    if (prop.type === 'SpreadElement') fail(ctx, 'spread (`...`) is not allowed here', prop);
    if (prop.computed) fail(ctx, 'computed option names (`[…]`) are not allowed here', prop.key);
    if (prop.kind !== 'init' || prop.method) fail(ctx, `.${method}() options are plain values, not getters or methods`, prop);
    const key = prop.key.type === 'Identifier' ? prop.key.name
      : prop.key.type === 'Literal' && typeof prop.key.value === 'string' ? prop.key.value : undefined;
    if (key === undefined) fail(ctx, `.${method}() option names must be plain names`, prop.key);
    if (key === '__proto__') fail(ctx, '`__proto__` is not an option', prop.key);
    if (Object.hasOwn(out, key)) fail(ctx, `option "${key}" is given twice`, prop.key);
    if (!Object.hasOwn(schema, key)) {
      fail(ctx, `unsupported option "${key}" for .${method}() (supported: ${Object.keys(schema).join(', ')})`, prop.key);
    }
    if (prop.shorthand) fail(ctx, `option "${key}" needs a literal value`, prop);
    out[key] = value(prop.value as Expression, schema[key], `\`${key}\``, ctx);
  }
  if (spec.atLeastOne && Object.keys(out).length === 0) {
    fail(ctx, `.${method}() needs one of: ${Object.keys(schema).join(', ')}`, node);
  }
  const missing = (spec.required ?? []).filter((k) => !Object.hasOwn(out, k));
  if (missing.length > 0) fail(ctx, `.${method}() needs ${missing.map((k) => `"${k}"`).join(' and ')} in this object`, node);
  return out;
}

function value(node: Expr | Node, type: ValueType, what: string, ctx: Context): unknown {
  if (type === 'nativeLocator' || type === 'plainNativeLocator') {
    const built = build(node as Expression, ctx);
    if (built.kind !== 'native') fail(ctx, `${what} must be a native locator (device.…)`, node);
    // filter({ has }) reads only its operand's own getter (PILOT-361): one
    // with a position, filter, scope or and/or would be checked without it.
    if (type === 'plainNativeLocator' && !ctx.dry && !built.handle._plainSelector()) {
      fail(ctx, `${what} must be a single getter such as device.getByText("…"): .filter({ has }) does not apply a position, filter, scope, .and() or .or() on it`, node);
    }
    return built.handle;
  }
  if (type === 'textExpected' && (node as Expr).type === 'ArrayExpression') {
    return (node as Expr & { type: 'ArrayExpression' }).elements.map((el, i) => {
      if (!el || el.type === 'SpreadElement') fail(ctx, `${what} must list strings or RegExp literals`, el ?? node);
      return value(el, 'textOrRegex', `item ${i + 1} of ${what}`, ctx);
    });
  }
  const literal = literalOf(node as Expression, ctx);
  const ok =
    type === 'string' ? typeof literal === 'string'
      : type === 'textOrRegex' || type === 'textExpected' ? typeof literal === 'string' || literal instanceof RegExp
        : type === 'integer' ? Number.isInteger(literal)
          : type === 'number' ? typeof literal === 'number' && Number.isFinite(literal)
            : type === 'scalar' ? ['string', 'number', 'boolean'].includes(typeof literal)
              : typeof literal === 'boolean';
  if (!ok) fail(ctx, `${what} must be ${TYPE_NAMES[type]}`, node);
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
          fail(ctx, `invalid RegExp /${node.regex.pattern}/${node.regex.flags} (${err instanceof Error ? err.message : String(err)})`, node);
        }
      }
      if (node.value === null || typeof node.value === 'bigint') fail(ctx, 'argument values must be strings, numbers, booleans or RegExp literals', node);
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) fail(ctx, 'template literals with `${…}` are not allowed; write the text out', node.expressions[0]);
      return node.quasis[0].value.cooked;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value;
      }
      break;
    default:
      break;
  }
  fail(ctx, 'each argument must be a literal value (a string, number, boolean or RegExp), not an expression or a variable', node);
}

/** Whether `err` is a refusal from {@link evaluateLocator} (its message is user-facing). */
export function isLocatorError(err: unknown): err is Error {
  return err instanceof LocatorError;
}

/**
 * @internal — Where a refusal points, as an offset into the text that was
 * parsed, and its reason without the quoted source; undefined for anything
 * else.
 */
export function locatorErrorDetail(err: unknown): { reason: string; at: number | undefined } | undefined {
  return err instanceof LocatorError ? { reason: err.reason, at: err.at } : undefined;
}
