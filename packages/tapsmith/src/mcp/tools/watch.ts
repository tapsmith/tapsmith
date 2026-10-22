import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerWatchTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_watch',
    'Toggle watch mode on a test file. When enabled, the file automatically re-runs on save. Returns the new watch state (enabled/disabled).',
    {
      file: z.string().describe('Absolute path to the test file'),
      test: z.string().optional().describe('Specific test full name to watch (optional, watches whole file if omitted)'),
      project: z.string().optional().describe('Project name to scope the watch to (optional)'),
    },
    async ({ file, test: testFilter, project }) => {
      const { enabled } = dispatcher.toggleWatch(file, { testFilter, project });
      const scope = testFilter ? `test "${testFilter}"` : `file`;
      const proj = project ? ` [${project}]` : '';
      const text = enabled
        ? `Watch enabled for ${scope}${proj}. Will re-run on save.`
        : `Watch disabled for ${scope}${proj}.`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
