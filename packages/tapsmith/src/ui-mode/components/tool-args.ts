/**
 * tool-args — the one-line summary the Device Activity feed shows under an
 * in-progress MCP tool call.
 *
 * Plain TS rather than part of DeviceActivityPanel.tsx so it can be unit-tested
 * against the argument names the MCP tools actually advertise (the same reason
 * mirror-coords.ts and selector-pick.ts live outside their components): the
 * argument key is a literal duplicated between the tool's zod schema and this
 * reader, and a rename on one side alone renders a blank row silently.
 */

export function formatToolArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === 'tapsmith_run_tests' && Array.isArray(args.files)) {
    const files = args.files as string[];
    const names = files.map(f => {
      const parts = String(f).split('/');
      return parts[parts.length - 1];
    });
    return `Running ${names.join(', ')}`;
  }
  if (tool === 'tapsmith_tap' || tool === 'tapsmith_type') {
    // `selector` is the pre-rename argument name. Events reach this panel over
    // HTTP from a separately installed `tapsmith mcp-server` (ui-server.ts's
    // /mcp-events ingest), which can be an older build than the UI server, so
    // the older key stays readable rather than rendering a blank row.
    return String(args.locator ?? args.selector ?? '');
  }
  return '';
}
