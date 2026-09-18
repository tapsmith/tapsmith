export interface McpToolCallEvent {
  id: string
  tool: string
  args: Record<string, unknown>
  status: 'started' | 'completed' | 'error'
  resultSummary?: string
  resultText?: string
  resultTruncated?: boolean
  error?: string
  durationMs?: number
  timestamp: number
}

export interface McpClientInfo {
  name: string
  version: string
}

type ToolCallListener = (event: McpToolCallEvent) => void
type ClientListener = (info: McpClientInfo | null) => void

export class McpEventEmitter {
  private _toolCallListeners: ToolCallListener[] = [];
  private _clientListeners: ClientListener[] = [];

  onToolCall(listener: ToolCallListener): void {
    this._toolCallListeners.push(listener);
  }

  onClientChange(listener: ClientListener): void {
    this._clientListeners.push(listener);
  }

  emitToolCall(event: McpToolCallEvent): void {
    for (const listener of this._toolCallListeners) {
      listener(event);
    }
  }

  emitClientChange(info: McpClientInfo | null): void {
    for (const listener of this._clientListeners) {
      listener(info);
    }
  }
}

let _callCounter = 0;

export function nextCallId(): string {
  return `mcp-${++_callCounter}-${Date.now()}`;
}

export const MCP_EVENT_RESULT_TEXT_LIMIT = 12_000;

export function truncateResultText(result: string): Pick<McpToolCallEvent, 'resultText' | 'resultTruncated'> {
  if (result.length === 0) return {};
  if (result.length <= MCP_EVENT_RESULT_TEXT_LIMIT) return { resultText: result };
  return {
    resultText: result.slice(0, MCP_EVENT_RESULT_TEXT_LIMIT),
    resultTruncated: true,
  };
}

export function summarizeResult(tool: string, result: string): string {
  switch (tool) {
    case 'tapsmith_snapshot': {
      const locatorMatch = result.match(/## Suggested Locators\n([\s\S]*)/);
      const locatorCount = locatorMatch
        ? locatorMatch[1].trim().split('\n').length
        : 0;
      const elementMatch = result.match(/^- /gm);
      const elementCount = elementMatch ? elementMatch.length : 0;
      return `${elementCount} elements, ${locatorCount} locators`;
    }
    case 'tapsmith_screenshot':
      return 'PNG image captured';
    case 'tapsmith_test_locator': {
      try {
        const parsed = JSON.parse(result);
        return parsed.matched
          ? `matched ${parsed.count} element${parsed.count !== 1 ? 's' : ''}`
          : 'no match';
      } catch {
        return result.slice(0, 60);
      }
    }
    case 'tapsmith_list_devices': {
      try {
        const devices = JSON.parse(result) as Array<{ platform?: string; model?: string }>;
        const android = devices.filter(d => d.platform === 'android').length;
        const ios = devices.filter(d => d.platform === 'ios').length;
        const parts: string[] = [];
        if (android) parts.push(`${android} android`);
        if (ios) parts.push(`${ios} ios`);
        return parts.length > 0 ? parts.join(', ') : `${devices.length} device${devices.length !== 1 ? 's' : ''}`;
      } catch {
        return result.slice(0, 60);
      }
    }
    case 'tapsmith_run_tests': {
      const passMatch = result.match(/(\d+) passed/);
      const failMatch = result.match(/(\d+) failed/);
      if (passMatch || failMatch) {
        const parts: string[] = [];
        if (passMatch) parts.push(`${passMatch[1]} passed`);
        if (failMatch) parts.push(`${failMatch[1]} failed`);
        return parts.join(', ');
      }
      return result.includes('All tests passed') ? 'all passed' : result.slice(0, 60);
    }
    case 'tapsmith_tap':
    case 'tapsmith_type':
    case 'tapsmith_swipe':
    case 'tapsmith_press_key':
    case 'tapsmith_launch_app':
      return result === 'OK' ? 'OK' : result.slice(0, 60);
    case 'tapsmith_read_trace':
      return result.includes('## Steps')
        ? result.match(/## Steps \((\d+) events\)/)?.[0] ?? result.slice(0, 60)
        : result.slice(0, 60);
    case 'tapsmith_list_tests': {
      const projectsMatch = result.match(/^Projects: (.+)$/m);
      if (projectsMatch) return `Projects: ${projectsMatch[1]}`;
      return result.match(/(\d+) test file/)?.[0] ?? result.slice(0, 60);
    }
    case 'tapsmith_list_results': {
      const resMatch = result.match(/(\d+) passed, (\d+) failed, (\d+) skipped/);
      return resMatch ? `${resMatch[1]} passed, ${resMatch[2]} failed, ${resMatch[3]} skipped` : result.slice(0, 60);
    }
    case 'tapsmith_suite_status': {
      const statusMatch = result.match(/(\d+) passed, (\d+) failed, (\d+) skipped, (\d+) not run/);
      return statusMatch
        ? `${statusMatch[1]} passed, ${statusMatch[2]} failed, ${statusMatch[3]} skipped, ${statusMatch[4]} not run`
        : result.slice(0, 60);
    }
    case 'tapsmith_stop_tests':
      return result.includes('Stop signal') ? 'stopped' : 'nothing running';
    case 'tapsmith_session_info':
      return 'session info';
    case 'tapsmith_watch':
      return result.includes('enabled') ? 'watch enabled' : 'watch disabled';
    default:
      return result.slice(0, 60);
  }
}
