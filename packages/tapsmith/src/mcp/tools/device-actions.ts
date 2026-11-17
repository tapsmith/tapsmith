import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceClientFor, deviceTargetFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { canonicalLocatorSource, isLocatorError, type EvaluatedLocator } from '../locator-eval.js';
import { MCP_ACTION_RUN_TIMEOUT_MS, MCP_ACTION_TIMEOUT_MS, sdkDeviceFor, withEvaluatedLocator } from '../sdk-device.js';
import type { ElementHandle } from '../../element-handle.js';
import { LOCATOR_PICKER_HINT } from '../../locator-miss-hint.js';
import { checkingLine, webViewLineCheck } from '../action-lines.js';
import {
  actionLineResult, describeLine, locatorCallLine, pressKeyLine, stringLiteral, swipeLine, type LineCheck,
} from '../test-lines.js';

/** The tool result for a daemon action: its error, or "OK". */
export function actionResult(success: boolean, errorMessage?: string) {
  // A failure the daemon gave no reason for is still a failure: reporting it
  // as "OK" is exactly the silent success an agent cannot detect.
  if (!success) {
    const reason = errorMessage || 'the device reported the action failed but gave no reason';
    return { content: [{ type: 'text' as const, text: `Error: ${reason}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: 'OK' }] };
}

/** The tool result for an SDK action that threw: its message, as a test would see it. */
function thrownResult(err: unknown) {
  return actionResult(false, err instanceof Error ? err.message : String(err));
}

/** What an action tool's locator miss tells the agent to do next (PILOT-849). */
function mcpLocatorHint(locator: string): string {
  return `Check a locator with tapsmith_test_locator before acting on it (this one: ${locator.trim()}), ` +
    'or take a tapsmith_snapshot for the checked locators of everything on screen.';
}

/** How an action tool acts on its evaluated locator, and the line that repeats it. */
interface LocatorAction {
  act: (evaluated: EvaluatedLocator) => Promise<void>
  /** The statement for the checked locator (which may differ from the one passed). */
  line: (locator: string, kind: EvaluatedLocator['kind']) => string
}

/** What the tap and type descriptions say about the line they answer with. */
const TEST_LINE_HINT = 'Answers with the test line that repeats the action, its locator checked by the device agent to match exactly '
  + 'the element acted on, on the screen before the action: write that line into the test as you go.';

/** What a `webview.` line needs declared before it in the test. */
const WEBVIEW_LINE_NOTE = '(Declare `const webview = await device.webview();` before this line in the test.)';

/**
 * Build a tool's locator string with the SDK's own builder (PILOT-848) on the
 * target device and act on it. A string that is not a locator, or an action
 * that throws, comes back as the error result. A successful action answers
 * with the test line that repeats it, its locator checked as the action
 * resolved its element (PILOT-1239, action-lines.ts).
 */
async function actOn(
  locator: string,
  target: { device?: string; project?: string },
  dispatcher: TestDispatcher | undefined,
  action: LocatorAction,
) {
  const { client, device } = await deviceTargetFor(target, dispatcher);
  const sdkDevice = await sdkDeviceFor(client, device);
  let check: (() => LineCheck) | undefined;
  let kind = 'native' as EvaluatedLocator['kind'];
  try {
    await withEvaluatedLocator(sdkDevice, client, locator, async (evaluated) => {
      kind = evaluated.kind;
      // The line spells the locator as a test with the `device` fixture does
      // (`page.`, `this.device.` and a bare getter all read as `device.`).
      const written = canonicalLocatorSource(locator);
      if (evaluated.kind === 'webview') {
        const lineCheck = webViewLineCheck(written, evaluated.locator._nthIndex !== undefined);
        check = () => lineCheck;
        return action.act(evaluated);
      }
      const checking = checkingLine(evaluated.handle, written, client);
      check = checking.check;
      return action.act({ kind: 'native', handle: checking.handle });
    });
  } catch (err) {
    if (isLocatorError(err)) return { content: [{ type: 'text' as const, text: err.message }], isError: true };
    const message = err instanceof Error ? err.message : String(err);
    // An agent that missed its target should look at the screen, as before
    // (not one whose WebView or agent connection timed out). A native miss
    // ends with the pointer at UI mode's picker, which is for a human: the
    // agent gets its own tools instead, with the locator to check (PILOT-849).
    if (message.includes(LOCATOR_PICKER_HINT)) {
      return actionResult(false, message.replace(LOCATOR_PICKER_HINT, mcpLocatorHint(locator)));
    }
    return /not found|did not reach state|in WebView \(\d+ms\)/i.test(message)
      ? actionResult(false, `${message} Use tapsmith_snapshot or tapsmith_test_locator to inspect the current screen.`)
      : thrownResult(err);
  }
  const lineCheck = check?.() ?? { status: 'unverified' as const, reason: 'the locator was not resolved' };
  const described = describeLine(lineCheck, (checked) => action.line(checked, kind));
  return actionLineResult(kind === 'webview' && lineCheck.status !== 'unverified' ? `${described}\n${WEBVIEW_LINE_NOTE}` : described);
}

/**
 * `handle`, once its field is there, with a test's budget to type in. The
 * wait keeps the 5 s an agent's wrong locator should fail within (or the
 * tool's `timeout`); typing a long string (on iOS, about ten characters a
 * second) gets as long as a test would give it, or the `timeout` when that is
 * longer. A tap is quick once its target is there, and keeps 5 s.
 */
async function acting(handle: ElementHandle, timeout: number | undefined): Promise<ElementHandle> {
  await handle.waitFor({ state: 'attached', timeout });
  return handle._withTimeout(Math.max(MCP_ACTION_RUN_TIMEOUT_MS, timeout ?? 0));
}

/** Longest `timeout` an action tool takes: well inside an MCP client's own tool-call limit. */
const MAX_TOOL_TIMEOUT_MS = 120_000;

/** The `timeout` argument tapsmith_tap and tapsmith_type share (PILOT-840). */
const timeoutArg = z.number().min(1).max(MAX_TOOL_TIMEOUT_MS).optional().describe(
  `How long to wait for the element, in milliseconds (default ${MCP_ACTION_TIMEOUT_MS}, at most ${MAX_TOOL_TIMEOUT_MS}). ` +
  'Raise it for an element that takes a while to appear.',
);

export function registerDeviceActionTools(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_tap',
    'Tap a UI element matching the given Tapsmith locator, exactly as `await locator.tap()` in a test would (waits up to 5s for it, or `timeout` ms; strict mode; chains, .filter(), .first()/.nth() and webview.* locators work). Find the locator with tapsmith_snapshot and check it with tapsmith_test_locator first. ' + TEST_LINE_HINT,
    {
      locator: z.string().describe('Tapsmith locator, e.g. device.getByRole("button", { name: "Login" })'),
      timeout: timeoutArg,
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    // The SDK's own tap (PILOT-848): strict mode (PILOT-226), positions,
    // scoping and the enabled/hittable waits all behave as in a test.
    async ({ locator, timeout, device, project }) => actOn(locator, { device, project }, dispatcher, {
      act: async (evaluated) => {
        if (evaluated.kind === 'webview') await evaluated.locator.click({ timeout });
        else await evaluated.handle.tap({ timeout });
      },
      line: (checked, kind) => locatorCallLine(checked, kind === 'webview' ? 'click' : 'tap'),
    }),
  );

  server.tool(
    'tapsmith_type',
    'Type text into an element matching the locator, as `locator.type(text)` in a test would. Set clear=true to replace existing text. A webview.* field is filled through the page (clear=false keeps its current value and appends). ' + TEST_LINE_HINT,
    {
      locator: z.string().describe('Tapsmith locator for the text field'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing text before typing. If the clear fails, the call returns that error and types nothing.'),
      timeout: timeoutArg,
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ locator, text, clear, timeout, device, project }) => {
      // What a webview field holds once typed into: fill() replaces the value.
      let filled = text;
      return actOn(locator, { device, project }, dispatcher, {
        act: async (evaluated) => {
          if (evaluated.kind === 'webview') {
            // A page field has no "type at the cursor": fill() replaces the
            // value, so appending means filling with what is already there.
            const current = clear ? '' : await evaluated.locator.inputValue({ timeout });
            filled = current + text;
            await evaluated.locator.fill(filled, { timeout });
          } else if (clear) {
            // clearAndType resolves the field once: clearing first and then
            // typing would re-resolve a locator the clear itself can break
            // (getByText("old value")), leaving the field empty.
            await (await acting(evaluated.handle, timeout)).clearAndType(text);
          } else {
            await (await acting(evaluated.handle, timeout)).type(text);
          }
        },
        line: (checked, kind) => kind === 'webview'
          ? locatorCallLine(checked, 'fill', stringLiteral(filled))
          : locatorCallLine(checked, clear ? 'clearAndType' : 'type', stringLiteral(text)),
      });
    },
  );

  server.tool(
    'tapsmith_swipe',
    'Swipe on the device screen in the given direction. Use to scroll or navigate between screens. Answers with the test line that repeats it.',
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ direction, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.swipe(direction);
      return success ? actionLineResult(`Test line: ${swipeLine(direction)}`) : actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_press_key',
    'Press a device key. Common keys: back, home, enter, tab, delete. Answers with the test line that repeats it.',
    {
      key: z.string().describe('Key name: back, home, enter, tab, delete, etc.'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ key, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.pressKey(key);
      return success ? actionLineResult(`Test line: ${pressKeyLine(key)}`) : actionResult(success, errorMessage);
    },
  );
}
