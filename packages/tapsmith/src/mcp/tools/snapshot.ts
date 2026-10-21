import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceClientFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { parseHierarchyXml } from '../../trace-viewer/components/hierarchy-utils.js';
import { formatHierarchy, semanticNodes } from '../hierarchy-formatter.js';
import { agentValidatedSuggestions } from '../agent-suggestions.js';

/** Selectors per agent call on iOS, where each call costs one snapshot. */
const IOS_CHUNK_SIZE = 500;

export function registerSnapshotTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_snapshot',
    'Get the current screen\'s accessibility tree with copy-paste-ready Tapsmith locators for each interactive element. Suggested locators are checked by the device agent, with the same matching tests run with, and each resolved to exactly the element it is listed against when the snapshot was taken (getByText is substring by default; ambiguous locators throw a strict mode violation when acted on). Use this first when writing tests to see what\'s on screen. Then validate locators with tapsmith_test_locator before putting them in test code.',
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
      const nodes = semanticNodes(roots);
      // The iOS agent takes one capture per call however many selectors it
      // is sent, so a screen is checked in a few large calls there.
      const ios = hierarchyXml.includes('<XCUIElementType');
      const { byNode, errorMessage: suggestError, stoppedAt, notFound } =
        await agentValidatedSuggestions(client, nodes, ios ? { chunkSize: IOS_CHUNK_SIZE } : {});
      const { tree, locators } = formatHierarchy(roots, byNode);

      // There is no other matcher to fall back to: say why refs are missing
      // rather than offer unchecked ones. The note goes before the locator
      // list, which the activity feed counts line by line.
      const note = suggestError
        ? stoppedAt === 'variants'
          ? `(Some suggestions are pinned by position (.first()/.nth()/.last()) because the device agent stopped checking more specific ones: ${suggestError})`
          : byNode.size === 0
            ? `(No suggested locators: the device agent stopped checking them: ${suggestError})`
            : `(Some elements have no suggested locator, and some suggestions may be pinned by position, because the device agent stopped checking them: ${suggestError})`
        : byNode.size === 0 && nodes.length > 0
          // The agent answered, but nothing resolved to the element it was
          // suggested for: the screen changed between the two captures.
          ? '(No suggested locators: none resolved to its element when the device agent checked them; the screen may have been changing. Take the snapshot again.)'
          : notFound > 0
            ? `(${notFound === 1 ? '1 listed element was' : `${notFound} listed elements were`} not on screen when the device agent checked ${notFound === 1 ? 'it' : 'them'}, so ${notFound === 1 ? 'it has' : 'they have'} no suggested locator; the screen may have changed. Take the snapshot again.)`
            : '';
      const body = [tree || '(empty screen)', note].filter(Boolean).join('\n\n');
      const output = locators.length > 0
        ? `${body}\n\n## Suggested Locators\n${locators.join('\n')}`
        : body;

      return { content: [{ type: 'text' as const, text: output }] };
    },
  );
}
