import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerSessionInfoTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_session_info',
    'Get configuration and environment info for the current test session: platform, app package, device, timeout, retries, and per-project settings. Useful for understanding the test environment before writing or running tests.',
    {},
    async () => {
      await dispatcher.ensureInitialized?.();
      const info = dispatcher.getSessionInfo();
      const lines: string[] = [];

      lines.push('## Session');
      // Name the config first: everything below is derived from it, and a
      // session running on synthesized defaults is otherwise indistinguishable
      // from one backed by a real project.
      // A config that exists but failed to load is not "using defaults": the
      // session has no config, and device tools refuse until it is fixed.
      lines.push(`Config: ${info.configPath ?? (info.configError ? 'failed to load — see the warning below' : 'none — using built-in defaults')}`);
      // One device line per platform: a multi-platform session runs on several
      // at once, and a platform that failed to provision must not look like it
      // is simply sharing the other one's device.
      const targets = info.deviceTargets ?? [];
      const unavailable = (t: { error?: string }): string =>
        `unavailable — ${t.error ?? 'no reason was recorded'}`;
      if (targets.length > 1) {
        for (const t of targets) {
          // A target without a platform (single-platform config, nothing on the
          // project) gets no parenthetical rather than a literal "(device)".
          const label = t.platform ? ` (${t.platform})` : '';
          // A group member is named the way its tests name it; the name is
          // what the device tools accept in place of the serial.
          const who = t.name ? ` ${t.name}${t.group ? ` [${t.group}]` : ''}` : '';
          lines.push(`Device${label}${who}: ${t.device ?? unavailable(t)}`);
        }
      } else if (targets.length === 1) {
        // The target's own serial before `info.device`: a dispatcher may fill
        // one and not the other, and a session that names no device at all
        // reads as if it had not resolved one.
        lines.push(`Device: ${targets[0].device ?? info.device ?? unavailable(targets[0])}`);
      } else if (info.device) {
        lines.push(`Device: ${info.device}`);
      } else if (info.configError) {
        lines.push('Device: none — device tools need the config (or an explicit `device`)');
      } else {
        // A headless session picks its devices only when something needs one,
        // so a `run_tests` can still name the device to use — with synthesized
        // defaults too (the config loader always returns a config).
        lines.push('Device: not chosen yet — the first test run or device tool picks one (tapsmith_run_tests can name it with `device`)');
      }
      if (info.platform) lines.push(`Platform: ${info.platform}`);
      if (info.package) lines.push(`Package: ${info.package}`);
      lines.push(`Timeout: ${info.timeout}ms`);
      lines.push(`Retries: ${info.retries}`);

      if (info.configWarning) {
        lines.push('');
        lines.push(`WARNING: ${info.configWarning}`);
      }

      if (info.projects.length > 0) {
        lines.push('');
        lines.push('## Projects');
        for (const p of info.projects) {
          const details: string[] = [];
          if (p.platform) details.push(p.platform);
          if (p.package) details.push(p.package);
          // A group project names its members here as well as in the Device
          // lines above, which only exist once the devices are provisioned.
          if (p.devices && p.devices.length > 1) details.push(`devices: ${p.devices.join(', ')}`);
          details.push(`${p.testFiles.length} file(s)`);
          if (p.dependencies.length > 0) details.push(`depends on: ${p.dependencies.join(', ')}`);
          lines.push(`- **${p.name}**: ${details.join(' | ')}`);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
