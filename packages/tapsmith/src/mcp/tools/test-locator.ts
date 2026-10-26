import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceTargetFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { formatBounds } from '../locator-helper.js';
import { isLocatorError } from '../locator-eval.js';
import { sdkDeviceFor, withEvaluatedLocator } from '../sdk-device.js';
import { WebViewLocator } from '../../webview-locator.js';

const STRICT_HINT =
  'Actions and assertions on this locator will throw a strict mode violation at runtime. ' +
  'Disambiguate with { exact: true }, getByRole(role, { name, exact: true }), getByTestId(), .filter(), or .first()/.nth()/.last().';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerTestLocatorTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_test_locator',
    'Test a Tapsmith locator against the current screen, resolved exactly as a test resolves it (the same SDK locator code and the device agent\'s matching, no waiting). Chains work as in a test: scoped getters, .filter(), .and(), .or(), .first()/.nth()/.last(), and webview.* locators. Returns whether it matches, how many elements match, and details about each match. Warns when a locator is ambiguous (multiple matches), which makes runtime actions throw a strict mode violation. Use to validate locators before putting them in test code.',
    {
      locator: z.string().describe('Tapsmith locator, e.g. device.getByRole("button", { name: "Login" }) or device.getByRole("listitem").filter({ hasText: "Milk" })'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ locator, device, project }) => {
      const target = await deviceTargetFor({ device, project }, dispatcher);
      const sdkDevice = await sdkDeviceFor(target.client, target.device);
      try {
        // The string is built by the SDK's own locator builder (PILOT-848), so
        // what is counted here is what a test writing it would resolve.
        const result = await withEvaluatedLocator(sdkDevice, target.client, locator, async (evaluated) => {
          if (evaluated.kind === 'webview') {
            const loc = evaluated.locator;
            const count = await loc.count();
            const res: Record<string, unknown> = { matched: count > 0, count, note: 'WebView locator — resolved in the page.' };
            if (loc._nthIndex !== undefined) {
              res.totalMatches = await new WebViewLocator(loc._handle, loc._selector, loc._timeoutMs, loc._finderAllJs).count();
            } else if (count > 1) {
              res.strictModeWarning = STRICT_HINT;
            }
            return res;
          }
          const { matches, total, positional } = await evaluated.handle._currentMatches();
          const res: Record<string, unknown> = {
            matched: matches.length > 0,
            count: matches.length,
            elements: matches.map((el) => ({ role: el.role || el.className, text: el.text, bounds: formatBounds(el.bounds) })),
          };
          if (total !== matches.length) res.totalMatches = total;
          if (!positional && matches.length > 1) res.strictModeWarning = STRICT_HINT;
          return res;
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult(isLocatorError(err) ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
