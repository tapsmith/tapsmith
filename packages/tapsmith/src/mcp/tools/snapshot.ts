import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TapsmithGrpcClient, UiHierarchyResponse } from '../../grpc-client.js';
import { deviceClientFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { parseHierarchyXml } from '../../trace-viewer/components/hierarchy-utils.js';
import { formatHierarchy, semanticNodes } from '../hierarchy-formatter.js';
import { agentValidatedSuggestions } from '../agent-suggestions.js';

/** Selectors per agent call on iOS, where each call costs one snapshot. */
const IOS_CHUNK_SIZE = 500;

/**
 * How long an empty screen is read again before it is reported as empty. An
 * app still launching has nothing in its accessibility tree: a React Native
 * app shows only its splash until the JS bundle has rendered, some seconds
 * later on a busy machine. The first snapshot of a session lands right there,
 * since the agent's start launches the app (PILOT-708). A screen that really
 * is empty is rare, and costs this much once per snapshot.
 */
const EMPTY_SCREEN_WAIT_MS = 15_000;
const EMPTY_SCREEN_POLL_MS = 500;

/**
 * Read the screen, reading again while it has nothing on it yet. An error on
 * the first read is the answer; after an empty read it may be the launch
 * still going on, so it is reported only if it lasts until the bound.
 */
async function readScreen(client: Pick<TapsmithGrpcClient, 'getUiHierarchy'>): Promise<UiHierarchyResponse> {
  const first = await client.getUiHierarchy();
  if (first.errorMessage || !isEmptyScreen(first.hierarchyXml)) return first;
  const deadline = Date.now() + EMPTY_SCREEN_WAIT_MS;
  let latest = first;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EMPTY_SCREEN_POLL_MS));
    latest = await client.getUiHierarchy();
    if (!latest.errorMessage && !isEmptyScreen(latest.hierarchyXml)) return latest;
  }
  return latest;
}

function isEmptyScreen(hierarchyXml: string): boolean {
  return formatHierarchy(parseHierarchyXml(hierarchyXml), new Map()).tree === '';
}

export function registerSnapshotTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_snapshot',
    'Get the current screen\'s accessibility tree with copy-paste-ready Tapsmith locators for each interactive element. Suggested locators are checked by the device agent, with the same matching tests run with, and each resolved to exactly the element it is listed against when the snapshot was taken (getByText is substring by default; ambiguous locators throw a strict mode violation when acted on). Use this first when writing tests to see what\'s on screen. Then check each locator you will use with tapsmith_test_locator (it must count exactly 1) before putting it in test code.',
    {
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);

      const { hierarchyXml, errorMessage } = await readScreen(client);
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
