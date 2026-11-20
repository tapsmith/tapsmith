/**
 * Test statements from MCP clients (`tapsmith_run_code`), read against a
 * fixed grammar and run on the SDK's own objects.
 *
 * `await device.getByText("Row 40").scrollIntoView();` sent to the tool is
 * parsed (acorn), checked against the allowlists below, and then made as the
 * same calls a test writing it would make: the locator is built by
 * locator-eval.ts's builder, the action or matcher is called on the
 * ElementHandle / WebViewLocator / `expect()` result / Device it built.
 *
 * The code comes from an AI agent, so it is interpreted, never executed.
 * Three statement shapes are accepted, each with literal arguments only:
 *
 *   await <locator>.<action>(…);
 *   await expect(<locator>)[.not].<matcher>(…);
 *   await device.<method>(…);
 *
 * Anything else — a variable, an assignment, a function, another identifier,
 * a query whose value would need a variable — is refused with its line and
 * column. Every statement is checked before any runs, so a refusal anywhere
 * means nothing ran.
 */

import { getLineInfo, parse } from 'acorn';
import type { CallExpression, Expression, Node, Program } from 'acorn';
import type { Device } from '../device.js';
import { expect as sdkExpect } from '../expect.js';
import {
  build,
  buildArgs,
  canonicalSourceOf,
  invoke,
  isLocatorError,
  located,
  locatorErrorDetail,
  rootOf,
  type Context,
  type EvaluatedLocator,
  type Expr,
  type LocatorRoots,
  type Param,
  type ValueType,
} from './locator-eval.js';

// ─── What may be called ───

const opt = (options: Record<string, ValueType>): Param => ({ type: { options }, optional: true });
const arg = (type: ValueType): Param => ({ type });
const TIMEOUT = { timeout: 'number' } as const;

interface ActionSpec {
  params: Param[]
  /**
   * The action reports the element it resolved before dispatching
   * (ElementHandle's `onResolved`), so its line can be checked as the action
   * resolves (action-lines.ts). Those that do not are written as they ran.
   */
  reportsElement: boolean
}

const act = (params: Param[], reportsElement = true): ActionSpec => ({ params, reportsElement });

/** Actions on a native locator (ElementHandle). */
const NATIVE_ACTIONS: Record<string, ActionSpec> = {
  tap: act([opt(TIMEOUT)]),
  doubleTap: act([opt({ ...TIMEOUT, intervalMs: 'number' })]),
  longPress: act([
    { type: { anyOf: ['number', { options: { duration: 'number', ...TIMEOUT } }] }, optional: true },
    opt(TIMEOUT),
  ]),
  type: act([arg('string'), opt({ ...TIMEOUT, delay: 'number' })]),
  clearAndType: act([arg('string'), opt({ ...TIMEOUT, delay: 'number' })]),
  clear: act([opt(TIMEOUT)]),
  scroll: act([arg('string'), opt({ ...TIMEOUT, distance: 'number' })]),
  dragTo: act([arg('nativeLocator'), opt(TIMEOUT)]),
  setChecked: act([arg('boolean'), opt(TIMEOUT)]),
  selectOption: act([{ type: { anyOf: ['string', { options: { index: 'integer' }, required: ['index'] }] } }, opt(TIMEOUT)]),
  focus: act([opt(TIMEOUT)]),
  blur: act([opt(TIMEOUT)]),
  pinchIn: act([opt({ ...TIMEOUT, scale: 'number' })]),
  pinchOut: act([opt({ ...TIMEOUT, scale: 'number' })]),
  scrollIntoView: act([opt({ direction: 'string', maxScrolls: 'integer', speed: 'number', ...TIMEOUT })], false),
  waitFor: act([opt({ state: 'string', ...TIMEOUT })], false),
};

/** Actions on a `webview.` locator (WebViewLocator). The page resolves them, strictly. */
const WEBVIEW_ACTIONS: Record<string, ActionSpec> = {
  click: act([opt(TIMEOUT)], false),
  fill: act([arg('string'), opt(TIMEOUT)], false),
};

/** Matchers of `expect(nativeLocator)` (TapsmithAssertions). */
const NATIVE_MATCHERS: Record<string, Param[]> = {
  toBeVisible: [opt({ ...TIMEOUT, visible: 'boolean' })],
  toBeHidden: [opt(TIMEOUT)],
  toExist: [opt(TIMEOUT)],
  toBeEnabled: [opt(TIMEOUT)],
  toBeDisabled: [opt(TIMEOUT)],
  toBeChecked: [opt(TIMEOUT)],
  toBeEmpty: [opt(TIMEOUT)],
  toBeFocused: [opt(TIMEOUT)],
  toBeEditable: [opt(TIMEOUT)],
  toBeInViewport: [opt({ ...TIMEOUT, ratio: 'number' })],
  toHaveText: [arg('textExpected'), opt(TIMEOUT)],
  toContainText: [arg('textExpected'), opt(TIMEOUT)],
  toHaveCount: [arg('integer'), opt(TIMEOUT)],
  toHaveAttribute: [arg('string'), arg('scalar'), opt(TIMEOUT)],
  toHaveAccessibleName: [arg('textOrRegex'), opt(TIMEOUT)],
  toHaveAccessibleDescription: [arg('textOrRegex'), opt(TIMEOUT)],
  toHaveRole: [arg('string'), opt(TIMEOUT)],
  toHaveValue: [arg('string'), opt(TIMEOUT)],
};

/** Matchers of `expect(webviewLocator)` (WebViewAssertions). */
const WEBVIEW_MATCHERS: Record<string, Param[]> = {
  toBeVisible: [opt({ ...TIMEOUT, visible: 'boolean' })],
  toBeHidden: [opt(TIMEOUT)],
  toExist: [opt(TIMEOUT)],
  toHaveText: [arg('textOrRegex'), opt(TIMEOUT)],
  toContainText: [arg('textOrRegex'), opt(TIMEOUT)],
  toHaveAttribute: [arg('string'), arg('string'), opt(TIMEOUT)],
  toHaveValue: [arg('string'), opt(TIMEOUT)],
};

const POINT: Param = { type: { options: { x: 'number', y: 'number' }, required: ['x', 'y'] } };

/**
 * `device.*` calls: gestures, keys, deep links, orientation and app
 * lifecycle. Calls that read host files, change permissions or data, or need
 * the config's app (an app call without its package) are left out.
 */
const DEVICE_CALLS: Record<string, Param[]> = {
  openDeepLink: [arg('string'), opt({ forceColdLaunch: 'boolean' })],
  tapXY: [arg('number'), arg('number')],
  longPressXY: [arg('number'), arg('number'), opt({ duration: 'number' })],
  dragXY: [POINT, POINT, opt({ duration: 'number' })],
  swipe: [arg('string'), opt({ speed: 'number', distance: 'number', timeoutMs: 'number' })],
  pressKey: [arg('string')],
  pressBack: [],
  pressHome: [],
  pressRecentApps: [],
  hideKeyboard: [],
  inputText: [arg('string')],
  setOrientation: [arg('string')],
  setColorScheme: [arg('string')],
  launchApp: [arg('string'), opt({ activity: 'string', clearData: 'boolean', waitForIdle: 'boolean' })],
  terminateApp: [arg('string')],
  bringToForeground: [arg('string')],
  sendToBackground: [],
  wake: [],
  unlock: [],
  openNotifications: [],
  openQuickSettings: [],
};

/** Locator methods that return a value: in a test their result goes into a variable. */
const QUERIES: Record<string, string> = {
  count: 'expect(locator).toHaveCount(n)',
  all: 'expect(locator).toHaveCount(n)',
  allTextContents: 'expect(locator).toHaveText([...])',
  getText: 'expect(locator).toHaveText("…")',
  textContent: 'expect(locator).toHaveText("…")',
  inputValue: 'expect(locator).toHaveValue("…")',
  getAttribute: 'expect(locator).toHaveAttribute(name, value)',
  isVisible: 'expect(locator).toBeVisible()',
  isHidden: 'expect(locator).toBeHidden()',
  isEnabled: 'expect(locator).toBeEnabled()',
  isChecked: 'expect(locator).toBeChecked()',
  isEditable: 'expect(locator).toBeEditable()',
  exists: 'expect(locator).toExist()',
  find: 'expect(locator).toBeVisible()',
  boundingBox: 'expect(locator).toBeInViewport()',
};

const SHAPES = 'Each statement is one of: `await <locator>.<action>(…);`, '
  + '`await expect(<locator>).<matcher>(…);` (or `.not.<matcher>`), or `await device.<method>(…);`, '
  + 'with literal arguments';

// ─── Parsed statements ───

interface StatementBase {
  /** 1-based position in the code. */
  index: number
  /** 1-based line and column of its start. */
  line: number
  column: number
  /** Its source text. */
  text: string
  /** The whole code it was parsed from (its node offsets are into this). */
  code: string
  /** The statement as a test writes it with the `device` fixture (receivers spelled `device.` / `webview.`). */
  written: string
  /** The awaited call. */
  call: CallExpression
  /** Whether it uses a `webview.` locator (which needs a WebView connection). */
  usesWebview: boolean
}

export type Statement =
  | StatementBase & {
    kind: 'action'
    receiver: Expr
    method: string
    /** The receiver as a test writes it. */
    receiverWritten: string
    /** The arguments as a test writes them. */
    argsWritten: string[]
    reportsElement: boolean
  }
  | StatementBase & {
    kind: 'assertion'
    subject: Expr
    /** The asserted locator as a test writes it. */
    subjectWritten: string
    negated: boolean
    matcher: string
  }
  | StatementBase & { kind: 'device'; method: string };

/** A statement that is not in the grammar, or code that does not parse. */
export class StatementError extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(message);
  }
}

/**
 * The statements in `code`, each checked against the grammar without any SDK
 * call or device I/O. Throws a
 * {@link StatementError} for the first one that is not allowed, so nothing
 * runs unless every statement is.
 */
export function parseStatements(code: string): Statement[] {
  let program: Program;
  try {
    program = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, locations: true });
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s*\(\d+:\d+\)$/, '');
    throw new StatementError(
      `Invalid code at ${where(loc?.line ?? 1, (loc?.column ?? 0) + 1)}: it does not parse (${message}).`,
      loc?.line ?? 1,
      (loc?.column ?? 0) + 1,
    );
  }
  const statements: Statement[] = [];
  for (const node of program.body) {
    if (node.type === 'EmptyStatement') continue;
    statements.push(checkStatement(code, node, statements.length + 1));
  }
  if (statements.length === 0) {
    throw new StatementError(`There is no statement to run. ${SHAPES}.`, 1, 1);
  }
  return statements;
}

function where(line: number, column: number): string {
  return `line ${line}, column ${column}`;
}

/** Refuse `node` (part of `code`) for `reason`. */
function refuseAt(code: string, at: { start: number }, reason: string, statement?: Node): never {
  const { line, column } = getLineInfo(code, at.start);
  const text = statement ? ` (\`${firstLine(code.slice(statement.start, statement.end))}\`)` : '';
  throw new StatementError(`Invalid statement at ${where(line, column + 1)}${text}: ${reason}.`, line, column + 1);
}

function firstLine(text: string): string {
  const lines = text.split('\n');
  return lines.length > 1 ? `${lines[0]} …` : text;
}

function checkStatement(code: string, node: Program['body'][number], index: number): Statement {
  const refuse: (at: { start: number }, reason: string) => never = (at, reason) => refuseAt(code, at, reason, node);
  if (node.type === 'VariableDeclaration') {
    const webviewDecl = node.declarations.length === 1 && node.declarations[0].id.type === 'Identifier' && node.declarations[0].id.name === 'webview';
    refuse(node, webviewDecl
      ? '`webview` needs no declaration here: `webview.…` locators connect to the current app\'s WebView on their own, so drop this line'
      : 'variables are not supported: write each value into the statement that uses it');
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    refuse(node, 'functions and classes are not supported: write the statements out one by one');
  }
  if (node.type !== 'ExpressionStatement') {
    refuse(node, `\`${node.type.replace(/Statement$/, '').toLowerCase()}\` statements are not supported. ${SHAPES}`);
  }
  const expression = node.expression;
  if (expression.type === 'AssignmentExpression') refuse(expression, 'assignments are not supported');
  if (expression.type !== 'AwaitExpression') {
    if (expression.type === 'CallExpression') refuse(expression, 'write `await` before the call, as a test does');
    refuse(expression, `this is not a statement that can run. ${SHAPES}`);
  }
  const call = expression.argument;
  if (call.type === 'ChainExpression') refuse(call, 'optional chaining (`?.`) is not supported');
  if (call.type !== 'CallExpression') refuse(call, `\`await\` takes one call here. ${SHAPES}`);
  if (call.optional) refuse(call, 'optional calls (`?.()`) are not supported');
  const callee = call.callee;
  if (callee.type === 'Identifier') {
    refuse(callee, callee.name === 'expect'
      ? 'an assertion needs a matcher: `await expect(<locator>).toBeVisible();`'
      : `\`${callee.name}\` is not something a statement can call. ${SHAPES}`);
  }
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.object.type === 'Super') {
    refuse(callee, `computed or unusual calls are not supported. ${SHAPES}`);
  }
  if (callee.optional) refuse(callee, 'optional chaining (`?.`) is not supported');
  const method = callee.property.name;
  const receiver = callee.object;
  const text = code.slice(node.start, node.end);
  const loc = getLineInfo(code, node.start);
  const base = {
    code,
    index,
    line: loc.line,
    column: loc.column + 1,
    text,
    written: `${canonicalSourceOf(code, expression)};`,
    call,
  };
  const ctx: Context = { source: text, noun: 'statement', dry: true, usesWebview: false };
  const checked = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      const detail = locatorErrorDetail(err);
      if (!detail) throw err;
      return refuse(detail.at !== undefined ? { start: detail.at } : node, detail.reason);
    }
  };

  // await expect(<locator>)[.not].<matcher>(…)
  if (isNot(receiver) && isNot(receiver.object)) refuse(receiver.property, '`.not` can be written once');
  const expectCall = expectCallOf(receiver);
  if (expectCall) {
    const { subjectCall, negated } = expectCall;
    if (subjectCall.arguments.length !== 1) refuse(subjectCall, '`expect()` takes one locator');
    const subject = subjectCall.arguments[0];
    if (subject.type === 'AwaitExpression' || subject.type === 'Literal' || subject.type === 'Identifier') {
      refuse(subject, 'only assertions on a locator are supported, e.g. `await expect(device.getByText("Saved")).toBeVisible();`'
        + ' (for a count or a text, use toHaveCount() or toHaveText() on the locator)');
    }
    const built = checked(() => located(build(subject, ctx), text, subject, 'statement'));
    const matchers = built.kind === 'native' ? NATIVE_MATCHERS : WEBVIEW_MATCHERS;
    const params = Object.hasOwn(matchers, method) ? matchers[method] : undefined;
    if (!params) {
      refuse(callee.property, `\`${method}()\` is not a ${built.kind === 'webview' ? 'webview ' : ''}locator matcher run_code supports `
        + `(supported: ${Object.keys(matchers).join(', ')})`);
    }
    checked(() => buildArgs(call.arguments, params, method, ctx, call));
    return {
      ...base, kind: 'assertion', subject, subjectWritten: canonicalSourceOf(code, subject), negated, matcher: method, usesWebview: ctx.usesWebview,
    };
  }

  // await device.<method>(…)
  const root = rootOf(receiver);
  if (root === 'device') {
    const params = Object.hasOwn(DEVICE_CALLS, method) ? DEVICE_CALLS[method] : undefined;
    if (!params) {
      if (/^getBy|^locator$/.test(method)) {
        refuse(callee.property, 'a locator on its own does nothing: end it with an action such as `.tap()`, or assert on it with `expect()`');
      }
      if (method === 'webview') {
        refuse(callee.property, '`device.webview()` is not needed: `webview.…` locators connect to the current app\'s WebView on their own');
      }
      refuse(callee.property, `\`device.${method}()\` is not supported here (supported: ${Object.keys(DEVICE_CALLS).join(', ')})`);
    }
    checked(() => buildArgs(call.arguments, params, method, ctx, call));
    return { ...base, kind: 'device', method, usesWebview: false };
  }
  if (root === 'webview') {
    refuse(callee.property, `\`webview.${method}()\` is not an action: act on a locator, e.g. \`await webview.getByText("Submit").click();\``);
  }

  // await <locator>.<action>(…)
  const built = checked(() => located(build(receiver, ctx), text, receiver, 'statement'));
  const actions = built.kind === 'native' ? NATIVE_ACTIONS : WEBVIEW_ACTIONS;
  const spec = Object.hasOwn(actions, method) ? actions[method] : undefined;
  if (!spec) {
    if (Object.hasOwn(QUERIES, method)) {
      refuse(callee.property, `\`.${method}()\` returns a value, which a statement here cannot keep: assert it instead, e.g. \`${QUERIES[method]}\``);
    }
    if (/^(getBy|locator$|first$|last$|nth$|filter$|and$|or$)/.test(method)) {
      refuse(callee.property, 'a locator on its own does nothing: end it with an action such as `.tap()`, or assert on it with `expect()`');
    }
    refuse(callee.property, `\`.${method}()\` is not ${built.kind === 'webview' ? 'a webview' : 'an'} action run_code supports `
      + `(supported: ${Object.keys(actions).map((m) => `.${m}()`).join(', ')})`);
  }
  checked(() => buildArgs(call.arguments, spec.params, method, ctx, call));
  return {
    ...base,
    kind: 'action',
    receiver,
    method,
    receiverWritten: canonicalSourceOf(code, receiver),
    argsWritten: call.arguments.map((a) => canonicalSourceOf(code, a)),
    reportsElement: built.kind === 'native' && spec.reportsElement,
    usesWebview: ctx.usesWebview,
  };
}

function isNot(node: Expression | Node): node is Expression & { type: 'MemberExpression'; object: Expression; property: Node } {
  const n = node as Expression;
  return n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier' && n.property.name === 'not';
}

/** `expect(x)` or `expect(x).not`, as the receiver of a matcher call. */
function expectCallOf(receiver: Expression | Node): { subjectCall: CallExpression; negated: boolean } | undefined {
  let node = receiver as Expression;
  let negated = false;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'not') {
    negated = true;
    node = node.object as Expression;
  }
  if (node.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier' && node.callee.name === 'expect') {
    return { subjectCall: node, negated };
  }
  return undefined;
}

// ─── Running a statement ───

/** A statement built on the SDK's objects, ready to run. */
export type BuiltStatement =
  | { kind: 'action'; target: EvaluatedLocator; args: unknown[] }
  | { kind: 'assertion'; target: EvaluatedLocator; args: unknown[] }
  | { kind: 'device'; args: unknown[] };

/**
 * Build `statement` (from {@link parseStatements} on `code`) on `roots`: its
 * locators on the SDK's builder, connecting the WebView only when it uses
 * one. Nothing is acted on yet.
 */
export async function buildStatement(statement: Statement, roots: LocatorRoots): Promise<BuiltStatement> {
  const webview = statement.usesWebview ? await roots.webview() : undefined;
  const ctx: Context = { source: statement.text, noun: 'statement', device: roots.device, webview, dry: false, usesWebview: false };
  const { call } = statement;
  switch (statement.kind) {
    case 'action': {
      const target = located(build(statement.receiver, ctx), statement.text);
      const spec = (target.kind === 'native' ? NATIVE_ACTIONS : WEBVIEW_ACTIONS)[statement.method];
      return { kind: 'action', target, args: buildArgs(call.arguments, spec.params, statement.method, ctx, call) };
    }
    case 'assertion': {
      const target = located(build(statement.subject, ctx), statement.text);
      const params = (target.kind === 'native' ? NATIVE_MATCHERS : WEBVIEW_MATCHERS)[statement.matcher];
      return { kind: 'assertion', target, args: buildArgs(call.arguments, params, statement.matcher, ctx, call) };
    }
    case 'device':
      return { kind: 'device', args: buildArgs(call.arguments, DEVICE_CALLS[statement.method], statement.method, ctx, call) };
  }
}

/**
 * {@link buildStatement} for a statement that uses no WebView, so it can be
 * built before any statement runs: what the SDK's builder refuses (an unknown
 * role, a `has` locator with a position) is refused then, with where, rather
 * than after earlier statements have acted.
 */
export async function prebuildStatement(statement: Statement, device: Device): Promise<BuiltStatement> {
  try {
    return await buildStatement(statement, {
      device,
      webview: () => Promise.reject(new Error('internal: a statement without webview. asked for the WebView')),
    });
  } catch (err) {
    const detail = locatorErrorDetail(err);
    const reason = detail?.reason ?? (err instanceof Error ? err.message : String(err)).replace(/\.$/, '');
    const at = detail?.at !== undefined ? getLineInfo(statement.code, detail.at) : { line: statement.line, column: statement.column - 1 };
    throw new StatementError(
      `Invalid statement at ${where(at.line, at.column + 1)} (\`${firstLine(statement.text)}\`): ${reason}.`,
      at.line,
      at.column + 1,
    );
  }
}

/** Run an assertion statement's matcher, as `await expect(target)[.not].<matcher>(...args)` would. */
export async function runAssertion(statement: Statement & { kind: 'assertion' }, target: EvaluatedLocator, args: unknown[]): Promise<void> {
  const assertions = target.kind === 'native' ? sdkExpect(target.handle) : sdkExpect(target.locator);
  const chosen = statement.negated ? assertions.not : assertions;
  await invoke(chosen, statement.matcher, args);
}

/** Run a `device.*` statement on `device`. */
export async function runDeviceCall(statement: Statement & { kind: 'device' }, device: Device, args: unknown[]): Promise<void> {
  await invoke(device, statement.method, args);
}

/** Whether `err` is a statement refusal (its message is user-facing). */
export function isStatementError(err: unknown): err is StatementError {
  return err instanceof StatementError || isLocatorError(err);
}
