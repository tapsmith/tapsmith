import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceClientFor, deviceTargetFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { isLocatorError, type EvaluatedLocator } from '../locator-eval.js';
import { MCP_ACTION_RUN_TIMEOUT_MS, MCP_ACTION_TIMEOUT_MS, sdkDeviceFor, withEvaluatedLocator } from '../sdk-device.js';
import type { ElementHandle } from '../../element-handle.js';

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

/**
 * Build a tool's locator string with the SDK's own builder (PILOT-848) on the
 * target device and act on it. A string that is not a locator, or an action
 * that throws, comes back as the error result.
 */
async function actOn(
  locator: string,
  target: { device?: string; project?: string },
  dispatcher: TestDispatcher | undefined,
  act: (evaluated: EvaluatedLocator) => Promise<void>,
) {
  const { client, device } = await deviceTargetFor(target, dispatcher);
  const sdkDevice = await sdkDeviceFor(client, device);
  try {
    await withEvaluatedLocator(sdkDevice, client, locator, act);
  } catch (err) {
    if (isLocatorError(err)) return { content: [{ type: 'text' as const, text: err.message }], isError: true };
    const message = err instanceof Error ? err.message : String(err);
    // An agent that missed its target should look at the screen, as before
    // (not one whose WebView or agent connection timed out).
    return /not found|did not reach state|in WebView \(\d+ms\)/i.test(message)
      ? actionResult(false, `${message} Use tapsmith_snapshot or tapsmith_test_locator to inspect the current screen.`)
      : thrownResult(err);
  }
  return actionResult(true);
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
const timeoutArg = z.number().positive().max(MAX_TOOL_TIMEOUT_MS).optional().describe(
  `How long to wait for the element, in milliseconds (default ${MCP_ACTION_TIMEOUT_MS}, at most ${MAX_TOOL_TIMEOUT_MS}), ` +
  'as the action\'s { timeout } option does in a test. Raise it for an element that takes a while to appear.',
);

export function registerDeviceActionTools(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_tap',
    'Tap a UI element matching the given Tapsmith locator, exactly as `await locator.tap()` in a test would (waits up to 5s for it, or `timeout` ms; strict mode; chains, .filter(), .first()/.nth() and webview.* locators work). Use tapsmith_snapshot first to find the right locator.',
    {
      locator: z.string().describe('Tapsmith locator, e.g. device.getByRole("button", { name: "Login" })'),
      timeout: timeoutArg,
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    // The SDK's own tap (PILOT-848): strict mode (PILOT-226), positions,
    // scoping and the enabled/hittable waits all behave as in a test.
    async ({ locator, timeout, device, project }) => actOn(locator, { device, project }, dispatcher, async (evaluated) => {
      if (evaluated.kind === 'webview') await evaluated.locator.click({ timeout });
      else await evaluated.handle.tap({ timeout });
    }),
  );

  server.tool(
    'tapsmith_type',
    'Type text into an element matching the locator, as `locator.type(text)` in a test would. Set clear=true to replace existing text. A webview.* field is filled through the page (clear=false keeps its current value and appends).',
    {
      locator: z.string().describe('Tapsmith locator for the text field'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing text before typing. If the clear fails, the call returns that error and types nothing.'),
      timeout: timeoutArg,
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ locator, text, clear, timeout, device, project }) => actOn(locator, { device, project }, dispatcher, async (evaluated) => {
      if (evaluated.kind === 'webview') {
        // A page field has no "type at the cursor": fill() replaces the
        // value, so appending means filling with what is already there.
        const current = clear ? '' : await evaluated.locator.inputValue({ timeout });
        await evaluated.locator.fill(current + text, { timeout });
      } else if (clear) {
        // clearAndType resolves the field once: clearing first and then
        // typing would re-resolve a locator the clear itself can break
        // (getByText("old value")), leaving the field empty.
        await (await acting(evaluated.handle, timeout)).clearAndType(text);
      } else {
        await (await acting(evaluated.handle, timeout)).type(text);
      }
    }),
  );

  server.tool(
    'tapsmith_swipe',
    'Swipe on the device screen in the given direction. Use to scroll or navigate between screens.',
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ direction, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.swipe(direction);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_press_key',
    'Press a device key. Common keys: back, home, enter, tab, delete.',
    {
      key: z.string().describe('Key name: back, home, enter, tab, delete, etc.'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ key, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.pressKey(key);
      return actionResult(success, errorMessage);
    },
  );
}
