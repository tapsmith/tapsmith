import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceTargetFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import { sdkDeviceFor } from '../sdk-device.js';
import { connectDevClientForTool } from '../../session-preflight.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { actionResult } from './device-actions.js';
import { actionLineResult, launchAppLine } from '../test-lines.js';

export function registerAppControlTools(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_launch_app',
    'Launch an app on the device. Set clear_data=true to start fresh (clears app storage). Answers with the test line that repeats it.',
    {
      package: z.string().describe('Android package name or iOS bundle ID'),
      clear_data: z.boolean().optional().describe('Clear app data before launching'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ package: pkg, clear_data, device, project }) => {
      const { client, device: serial } = await deviceTargetFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.launchApp(pkg, {
        clearData: clear_data ?? false,
      });
      if (!success) return actionResult(success, errorMessage);
      // An Expo development build lands on its dev launcher: connect it to
      // Metro, as the launch in a test run does, so the tool shows the app.
      try {
        const sdkDevice = await sdkDeviceFor(client, serial);
        await connectDevClientForTool({
          client, device: sdkDevice, packageName: pkg, platform: sdkDevice.platform === 'ios' ? 'ios' : 'android', serial, rootDir: process.cwd(),
        });
      } catch (err) {
        return actionResult(false, err instanceof Error ? err.message : String(err));
      }
      return actionLineResult(`Test line: ${launchAppLine(pkg, clear_data ?? false)}`);
    },
  );
}
