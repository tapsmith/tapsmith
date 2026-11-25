import { takeActionWarnings, takeWarningLines } from '../../action-warnings.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceTargetFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import { acting, actionErrorText, MAX_TOOL_TIMEOUT_MS, WEBVIEW_LINE_NOTE } from './device-actions.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { forgetToolDevice } from '../events.js';
import type { TapsmithGrpcClient } from '../../grpc-client.js';
import type { Device } from '../../device.js';
import { MCP_ACTION_TIMEOUT_MS, sdkDeviceFor, sdkDeviceWithTimeout, testRunActive, withLocatorRoots } from '../sdk-device.js';
import { asWrittenLineCheck, checkingLine, webViewLineCheck } from '../action-lines.js';
import { describeLine, type LineCheck } from '../test-lines.js';
import { invoke } from '../locator-eval.js';
import {
  buildStatement, isStatementError, parseStatements, prebuildStatement, runAssertion, runDeviceCall, type BuiltStatement, type Statement,
} from '../statement-eval.js';

/**
 * tapsmith_run_code: test statements, as a test body writes
 * them, run in order on the live device. They are parsed against a fixed
 * grammar (statement-eval.ts), never evaluated; each passing one answers with
 * the test line that repeats it.
 */

const DESCRIPTION = 'Run test statements on the device, as a test body writes them, and see which pass: '
  + 'try an assertion, a gesture or a deep link before putting it in a test. One statement per line or separated by `;`: '
  + '`await <locator>.<action>(…);` (tap, doubleTap, longPress, type, clearAndType, clear, scroll, scrollIntoView, dragTo, setChecked, selectOption, focus, blur, pinchIn, pinchOut, waitFor; webview.* locators: click, fill), '
  + '`await expect(<locator>)[.not].<matcher>(…);` (toBeVisible, toHaveText, toBeEnabled, toHaveCount, …), or '
  + '`await device.<method>(…);` (openDeepLink, tapXY, longPressXY, dragXY, swipe, pressKey, hideKeyboard, setOrientation, launchApp, …). '
  + 'Arguments are literals; variables, functions and other code are refused with their line and column, and then nothing runs. '
  + `Statements run in order and stop at the first failure, which is reported with the error a test would get. Each waits at most \`timeout\` for its element or assertion (default ${MCP_ACTION_TIMEOUT_MS / 1000} s; typing then gets up to 30 s). `
  + 'Each passing statement answers with its test line, its locator checked by the device agent: write those lines into the test. '
  + 'Refused while a test run is in progress.';

/** What a run of the statements answers with, so far. */
interface Report {
  lines: string[]
  /** A passing statement used a `webview.` locator: its line needs the WebView declared. */
  usedWebview: boolean
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const RUN_IN_PROGRESS = 'A test run is in progress on this session\'s devices: tapsmith_run_code would act on the device under it. '
  + 'Try again once it finishes (tapsmith_suite_status), or stop it with tapsmith_stop_tests.';

export function registerRunCodeTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_run_code',
    DESCRIPTION,
    {
      code: z.string().describe('Test statements, e.g. await expect(device.getByRole("button", { name: "Save" })).toBeEnabled();'),
      timeout: z.number().min(1).max(MAX_TOOL_TIMEOUT_MS).optional().describe(
        `How long each statement may wait, in milliseconds (default ${MCP_ACTION_TIMEOUT_MS}, at most ${MAX_TOOL_TIMEOUT_MS}). `
        + 'A `{ timeout }` written in a statement wins for that statement.',
      ),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ code, timeout, device, project }, extra) => {
      let statements: Statement[];
      try {
        statements = parseStatements(code);
      } catch (err) {
        if (isStatementError(err)) return errorResult(`${err.message} Nothing was run.`);
        throw err;
      }
      if (testRunActive()) return errorResult(`${RUN_IN_PROGRESS} Nothing was run.`);
      const target = await deviceTargetFor({ device, project }, dispatcher);
      const base = await sdkDeviceFor(target.client, target.device);
      const timeoutMs = timeout ?? MCP_ACTION_TIMEOUT_MS;
      const sdkDevice = timeout === undefined ? base : sdkDeviceWithTimeout(target.client, base, timeout);

      // Everything that needs no WebView is built before anything runs, so a
      // statement the SDK's builder refuses stops the whole block.
      const prebuilt = new Map<Statement, BuiltStatement>();
      for (const statement of statements) {
        if (statement.usesWebview) continue;
        try {
          prebuilt.set(statement, await prebuildStatement(statement, sdkDevice));
        } catch (err) {
          if (isStatementError(err)) {
            forgetToolDevice();
            return errorResult(`${err.message} Nothing was run.`);
          }
          throw err;
        }
      }

      const report: Report = { lines: [], usedWebview: false };
      const total = statements.length;
      for (const [i, statement] of statements.entries()) {
        const header = `Statement ${statement.index} of ${total} (line ${statement.line})`;
        // The client cancelled the call (the user stopped it, or it timed
        // out): nothing more acts on the device. Its answer is discarded, but
        // the activity feed still shows where it stopped.
        if (extra.signal.aborted) {
          report.lines.push(`${header} was not run: the call was cancelled.`, ...notRun(statements.slice(i + 1)));
          return errorResult(withWebviewNote(report, stoppedAt(statement, total, i, 'the call was cancelled')));
        }
        // A run that started meanwhile now holds the device.
        if (testRunActive()) {
          report.lines.push(`${header} was not run: ${RUN_IN_PROGRESS}`, ...notRun(statements.slice(i + 1)));
          return errorResult(withWebviewNote(report, stoppedAt(statement, total, i, 'a test run started')));
        }
        try {
          const line = await runStatement(statement, prebuilt.get(statement), sdkDevice, target.client, timeoutMs, report);
          report.lines.push(`${header}: OK`, line);
        } catch (err) {
          if (isStatementError(err)) report.lines.push(`${header} failed: ${err.message}`);
          else report.lines.push(`${header} failed: ${actionErrorText(err, locatorOf(statement))}`);
          report.lines.push(...notRun(statements.slice(i + 1)));
          return errorResult(withWebviewNote(report, stoppedAt(statement, total, i, 'it failed')));
        }
      }
      return { content: [{ type: 'text' as const, text: withWebviewNote(report) }] };
    },
  );
}

/**
 * The result's text. A run that stopped early leads with where and why, so
 * its first line (all a terminal feed shows) says what went wrong.
 */
function withWebviewNote(report: Report, headline?: string): string {
  const lines = headline ? [headline, ...report.lines] : report.lines;
  return report.usedWebview ? [...lines, WEBVIEW_LINE_NOTE].join('\n') : lines.join('\n');
}

/** The headline of a run that stopped at `statement` (the `passed`-th, 0-based) for `why`. */
function stoppedAt(statement: Statement, total: number, passed: number, why: string): string {
  return `Stopped at statement ${statement.index} of ${total} (line ${statement.line}): ${why}. `
    + `${passed} passed, ${total - passed - (why === 'it failed' ? 1 : 0)} not run.`;
}

/** The line saying which statements a failure left unrun, if any. */
function notRun(rest: Statement[]): string[] {
  if (rest.length === 0) return [];
  const first = rest[0];
  const last = rest[rest.length - 1];
  return rest.length === 1
    ? [`Not run: statement ${first.index} (line ${first.line}).`]
    : [`Not run: statements ${first.index}–${last.index} (lines ${first.line}–${last.line}).`];
}

/** The locator a statement acts on or asserts, for a miss's hint. */
function locatorOf(statement: Statement): string {
  if (statement.kind === 'action') return statement.receiverWritten;
  if (statement.kind === 'assertion') return statement.subjectWritten;
  return statement.written;
}

/** Whether an action's arguments already give it a `{ timeout }`. */
function hasOwnTimeout(args: unknown[]): boolean {
  return args.some((a) => typeof a === 'object' && a !== null && !(a instanceof RegExp) && Object.hasOwn(a, 'timeout'));
}

/**
 * Run one statement and return what it says about its test line. Throws what
 * the SDK threw for a failure.
 */
async function runStatement(
  statement: Statement,
  prebuilt: BuiltStatement | undefined,
  device: Device,
  client: TapsmithGrpcClient,
  timeoutMs: number,
  report: Report,
): Promise<string> {
  return withLocatorRoots(device, client, async (roots) => {
    const built = prebuilt ?? await buildStatement(statement, roots);
    if (statement.kind === 'device' && built.kind === 'device') {
      await runDeviceCall(statement, device, built.args);
      return `Test line: ${statement.written}`;
    }
    if (statement.kind === 'assertion' && built.kind === 'assertion') {
      await runAssertion(statement, built.target, built.args);
      const positional = built.target.kind === 'native' ? built.target.handle._isPositional() : built.target.locator._nthIndex !== undefined;
      if (built.target.kind === 'webview') report.usedWebview = true;
      return describeLine(asWrittenLineCheck(statement.subjectWritten, positional), () => statement.written);
    }
    if (statement.kind !== 'action' || built.kind !== 'action') throw new Error('internal: a statement was built as another kind');
    const line = (locator: string) => `await ${locator}.${statement.method}(${statement.argsWritten.join(', ')});`;
    let check: () => LineCheck;
    if (built.target.kind === 'webview') {
      const lineCheck = webViewLineCheck(statement.receiverWritten, built.target.locator._nthIndex !== undefined);
      check = () => lineCheck;
      await invoke(built.target.locator, statement.method, built.args);
      report.usedWebview = true;
      return describeLine(check(), line);
    }
    let handle = built.target.handle;
    if (statement.reportsElement) {
      const checking = checkingLine(handle, statement.receiverWritten, client);
      handle = checking.handle;
      check = checking.check;
    } else {
      const lineCheck = asWrittenLineCheck(statement.receiverWritten, handle._isPositional());
      check = () => lineCheck;
    }
    // Typing a long string outlasts the wait for its field (about ten
    // characters a second on iOS): as tapsmith_type does, wait for the field
    // within the timeout, then type with a test's budget.
    if ((statement.method === 'type' || statement.method === 'clearAndType') && !hasOwnTimeout(built.args)) {
      handle = await acting(handle, timeoutMs);
    }
    // Only this statement's warnings are reported with it.
    takeActionWarnings(client);
    await invoke(handle, statement.method, built.args);
    return describeLine(check(), line) + takeWarningLines(client);
  }, { timeoutMs });
}
