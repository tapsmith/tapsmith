import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceClientFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { parseHierarchyXml } from '../../trace-viewer/components/hierarchy-utils.js';
import { formatHierarchy } from '../hierarchy-formatter.js';

export function registerSnapshotTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_snapshot',
    'Get the current screen\'s accessibility tree with copy-paste-ready Tapsmith locators for each interactive element. Suggested locators are validated to resolve to exactly one element under runtime matching (getByText is substring by default; ambiguous locators throw a strict mode violation when acted on). Use this first when writing tests to see what\'s on screen. Then validate locators with tapsmith_test_locator before putting them in test code.',
    {
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);

      const { hierarchyXml, errorMessage } = await client.getUiHierarchy();
      if (errorMessage) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
      }

      const roots = parseHierarchyXml(hierarchyXml);
      const { tree, locators } = formatHierarchy(roots);

      const output = locators.length > 0
        ? `${tree}\n\n## Suggested Locators\n${locators.join('\n')}`
        : tree || '(empty screen)';

      return { content: [{ type: 'text' as const, text: output }] };
    },
  );
}
