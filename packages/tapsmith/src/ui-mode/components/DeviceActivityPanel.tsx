/**
 * DeviceActivityPanel — everything that happens to a device outside a traced
 * test, in one time-ordered feed: MCP tool calls from agents sharing the
 * session, background device preparation, worker recycles, and bursts of
 * mirror gestures. Started/ended pairs merge by id so an in-flight item
 * appears immediately and is replaced when it completes.
 */

import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import type { McpToolCallMessage, DeviceActivityMessage } from '../ui-protocol.js';
import { groupAgents, agentsTooltip, type McpAgent } from '../mcp-agents.js';
import { formatToolArgs } from './tool-args.js';

interface DeviceActivityPanelProps {
  mcpUrl?: string
  clientName?: string
  clientVersion?: string
  clients?: McpAgent[]
  toolCalls: McpToolCallMessage[]
  activity?: DeviceActivityMessage[]
  onClear: () => void
}

type FeedItem =
  | { kind: 'mcp'; ts: number; call: McpToolCallMessage }
  | { kind: 'activity'; ts: number; entry: DeviceActivityMessage }

type FeedFilter = 'all' | 'mcp' | 'activity'

const FILTER_OPTIONS: Array<{ value: FeedFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mcp', label: 'MCP' },
  { value: 'activity', label: 'Device' },
];

export function DeviceActivityPanel({ mcpUrl, clientName, clientVersion, clients, toolCalls, activity = [], onClear }: DeviceActivityPanelProps) {
  // Prefer the full client list; fall back to the single-client fields for back-compat.
  const agents: McpAgent[] = clients && clients.length > 0
    ? clients
    : clientName
      ? [{ name: clientName, version: clientVersion ?? '' }]
      : [];
  // Two instances of the same client are indistinguishable (identical clientInfo),
  // so collapse duplicates into "name ×N" instead of repeating the pill.
  const grouped = groupAgents(agents);
  const connected = agents.length > 0 || Boolean(clientName);
  const feedRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Deliberately not persisted: the panel's value is the causal, interleaved
  // view (an agent tap followed by the re-prepare it caused), so every
  // session starts back at 'all'.
  const [filter, setFilter] = useState<FeedFilter>('all');

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [toolCalls.length]);

  // Merge started+completed events: show in-progress items immediately,
  // replace with completed version when it arrives.
  const mergedCalls = mergeToolCalls(toolCalls);
  const mergedActivity = mergeActivity(activity);
  const feed: FeedItem[] = [
    ...mergedCalls.map((call): FeedItem => ({ kind: 'mcp', ts: call.timestamp, call })),
    ...mergedActivity.map((entry): FeedItem => ({ kind: 'activity', ts: entry.timestamp, entry })),
  ].sort((a, b) => a.ts - b.ts);
  const visibleFeed = filter === 'all' ? feed : feed.filter((item) => item.kind === filter);
  const hiddenCount = feed.length - visibleFeed.length;

  const single = grouped.length === 1 && grouped[0].count === 1;

  return (
    <div class="mcp-panel" role="region" aria-label="Device activity">
      <div class="mcp-header">
        <div class="mcp-header-top">
          <div class="mcp-header-left">
            <span class="mcp-title">Device activity</span>
            <span class="mcp-subtitle">MCP</span>
            {!connected
              ? (
                <span class="mcp-connection listening">
                  <span class="mcp-dot listening" />
                  Listening
                </span>
              )
              : single
                ? (
                  <span class="mcp-connection connected">
                    <span class="mcp-dot connected" />
                    {agents[0].name}{agents[0].version ? ` ${agents[0].version}` : ''}
                  </span>
                )
                // Multiple agents: the named pills render on their own row below,
                // so the top row stays just the title + Clear (never clips).
                : null}
          </div>
          <div class="mcp-header-right">
            {feed.length > 0 && (
              <button class="mcp-btn" onClick={onClear} title="Clear activity feed">
                Clear
              </button>
            )}
          </div>
        </div>
        {feed.length > 0 && (
          <div class="mcp-filter-row" role="group" aria-label="Filter activity feed">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                class={`mcp-filter-btn${filter === opt.value ? ' active' : ''}`}
                aria-pressed={filter === opt.value}
                data-testid="feed-filter"
                data-filter={opt.value}
                onClick={() => setFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
            {/* Never let a filter look like data loss. */}
            {hiddenCount > 0 && <span class="mcp-filter-hidden" data-testid="feed-hidden-count">{hiddenCount} hidden</span>}
          </div>
        )}
        {connected && !single && (
          <div class="mcp-agents-row" title={`${agents.length} agents connected:\n${agentsTooltip(agents)}`}>
            {grouped.map((g) => (
              <span key={g.name} class="mcp-agent-pill" data-testid="mcp-agent" title={g.count > 1 ? `${g.name} ×${g.count}` : g.name}>
                <span class="mcp-dot connected" />
                {g.name}
                {g.count > 1 && <span class="mcp-agent-count">×{g.count}</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Pinned outside the scrolling feed: device activity (a prepare after
          every run) keeps the feed non-empty, so an empty-state-only hint
          would never be seen. Collapsed to one line so the feed keeps the
          room; disappears the moment an agent connects. */}
      {!connected && mcpUrl && (
        <details class="mcp-setup-pinned" data-testid="mcp-setup-hint">
          <summary>Connect your AI agent</summary>
          <McpSetupHint mcpUrl={mcpUrl} title={false} />
        </details>
      )}
      <div class="mcp-feed" ref={feedRef} role="log" aria-label="Device activity feed">
        {visibleFeed.length === 0
          ? (
            <div class="mcp-empty" data-testid="mcp-empty">
              {feed.length > 0
                ? `${hiddenCount} ${hiddenCount === 1 ? 'entry is' : 'entries are'} hidden by the filter`
                : connected
                  ? 'Waiting for tool calls...'
                  : mcpUrl
                    ? 'No device activity yet...'
                    : 'MCP server starting...'}
            </div>
          )
          : visibleFeed.map((item) => item.kind === 'activity' ? <ActivityEntry key={item.entry.id} entry={item.entry} /> : (() => {
            const tc = item.call;
            const hasArgs = Object.keys(tc.args).length > 0;
            const hasResult = Boolean(tc.resultText);
            return (
              <div
                key={tc.id}
                class={`mcp-entry ${tc.status}${expandedId === tc.id ? ' expanded' : ''}`}
                data-testid="mcp-entry"
                onClick={() => setExpandedId(prev => prev === tc.id ? null : tc.id)}
              >
                <div class="mcp-entry-header">
                  <span class="mcp-time">{formatTime(tc.timestamp)}</span>
                  <span class="mcp-tool">{tc.tool.replace('tapsmith_', '')}</span>
                  {tc.status === 'started'
                    ? <span class="mcp-duration running">running…</span>
                    : tc.durationMs != null && (
                      <span class="mcp-duration">{formatDuration(tc.durationMs)}</span>
                    )}
                </div>
                {tc.status === 'started' && (
                  <div class="mcp-entry-summary mcp-in-progress">
                    {formatToolArgs(tc.tool, tc.args)}
                  </div>
                )}
                {/* An errored call carries `error` and no `resultSummary`
                    (mcp/index.ts), so gating on resultSummary alone left
                    failures showing as a red row with no explanation. */}
                {(tc.resultSummary || (tc.status === 'error' && tc.error)) && (
                  <div class="mcp-entry-summary">
                    {tc.status === 'error' ? tc.error ?? tc.resultSummary : tc.resultSummary}
                  </div>
                )}
                {expandedId === tc.id && (hasArgs || hasResult) && (
                  <div class="mcp-entry-detail">
                    {hasArgs && Object.entries(tc.args).map(([k, v]) => (
                      <div key={k} class="mcp-detail-row">
                        <span class="mcp-detail-key">{k}:</span>
                        <span class="mcp-detail-value">{formatArgValue(v)}</span>
                      </div>
                    ))}
                    {tc.resultText && (
                      <div class="mcp-result-block">
                        <div class="mcp-detail-key">result:</div>
                        <pre class="mcp-result-text">{formatResultText(tc.resultText, tc.resultTruncated)}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })())}
      </div>
    </div>
  );
}

const ACTIVITY_KIND_LABEL: Record<DeviceActivityMessage['kind'], string> = {
  prepare: 'prepare',
  validate: 'validate',
  recycle: 'recycle',
  mirror: 'mirror',
  respawn: 'respawn',
};

function ActivityEntry({ entry }: { entry: DeviceActivityMessage }) {
  const running = entry.status === 'started';
  return (
    <div
      class={`mcp-entry activity-entry activity-${entry.kind} ${entry.status}`}
      data-testid="activity-entry"
      data-kind={entry.kind}
      data-status={entry.status}
      title={entry.forFile ? `For ${entry.forFile.split('/').pop()}` : undefined}
    >
      <div class="mcp-entry-header">
        <span class="mcp-time">{formatTime(entry.timestamp)}</span>
        <span class="mcp-tool">{entry.label}</span>
        <span class="activity-kind">{ACTIVITY_KIND_LABEL[entry.kind]}</span>
        {running
          ? <span class="mcp-duration running">running…</span>
          : entry.durationMs != null && <span class="mcp-duration">{formatDuration(entry.durationMs)}</span>}
      </div>
      {entry.detail && (
        <div class={`mcp-entry-summary${running ? ' mcp-in-progress' : ''}`}>{entry.detail}</div>
      )}
    </div>
  );
}

function mergeActivity(entries: DeviceActivityMessage[]): DeviceActivityMessage[] {
  const byId = new Map<string, DeviceActivityMessage>();
  for (const e of entries) byId.set(e.id, e); // later messages for an id supersede earlier ones
  return Array.from(byId.values());
}

function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: Event) => {
    e.stopPropagation();
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [command]);

  return (
    <div class="mcp-command">
      <div class="mcp-command-label">{label}</div>
      <div class="mcp-command-row">
        <code class="mcp-command-text">{command}</code>
        <button class="mcp-copy-btn" onClick={handleCopy} title="Copy to clipboard">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function McpSetupHint({ mcpUrl, title = true }: { mcpUrl: string; title?: boolean }) {
  const claudeCommand = `claude mcp add tapsmith-ui --transport http ${mcpUrl}`;

  return (
    <div class="mcp-setup">
      {title && <div class="mcp-setup-title">Connect your AI agent</div>}
      <CopyableCommand label="MCP endpoint" command={mcpUrl} />
      <CopyableCommand label="Claude Code" command={claudeCommand} />
    </div>
  );
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatArgValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '...' : v;
  if (Array.isArray(v)) return `[${v.length} items]`;
  return String(v);
}

function formatResultText(result: string, truncated?: boolean): string {
  return truncated ? `${result}\n... truncated` : result;
}

function mergeToolCalls(calls: McpToolCallMessage[]): McpToolCallMessage[] {
  const byId = new Map<string, McpToolCallMessage>();
  for (const tc of calls) {
    const existing = byId.get(tc.id);
    if (!existing || tc.status !== 'started') {
      byId.set(tc.id, tc);
    }
  }
  return Array.from(byId.values());
}
