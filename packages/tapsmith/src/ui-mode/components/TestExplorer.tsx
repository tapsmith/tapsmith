/**
 * Test Explorer — file/suite/test tree with run controls.
 *
 * Displays the hierarchical test tree with status indicators,
 * per-node play buttons, watch toggles, and filtering.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, ChevronsDownUp, ChevronsUpDown, Circle, CircleSlash, Eye, Link, LoaderCircle, Play, Search, Smartphone, Square, X } from 'lucide-preact';
import type { TestTreeNode, ClientMessage } from '../ui-protocol.js';

const ICON_SIZE = 13;
const STATUS_SIZE = 12;
const TOOLBAR_ICON_SIZE = 14;

interface TestExplorerProps {
  files: TestTreeNode[]
  expandedNodes: Set<string>
  selectedTestId: string | null
  nameFilter: string
  statusFilter: 'all' | 'passed' | 'failed' | 'skipped'
  counts: { passed: number; failed: number; skipped: number; total: number }
  connected: boolean
  isRunning: boolean
  isStopping: boolean
  isWatching: boolean
  hasProjectDeps: boolean
  runDepsFirst: boolean
  pendingIds: Set<string>
  onToggleExpanded: (nodeId: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onSelectTest: (testId: string | null) => void
  onSetNameFilter: (filter: string) => void
  onSetStatusFilter: (filter: 'all' | 'passed' | 'failed' | 'skipped') => void
  onSend: (msg: ClientMessage) => void
  /** Run every test — or, while a filter narrows the tree, only the visible ones. */
  onRunAll: () => void
  onStop: () => void
  onToggleRunDeps: () => void
  onSetPending: (nodeId: string) => void
}

export function TestExplorer(props: TestExplorerProps) {
  const {
    files, expandedNodes, selectedTestId, nameFilter, statusFilter,
    counts, connected, isRunning, isStopping, isWatching, hasProjectDeps, runDepsFirst,
    pendingIds, onToggleExpanded, onExpandAll, onCollapseAll, onSelectTest,
    onSetNameFilter, onSetStatusFilter, onSend, onRunAll, onStop, onToggleRunDeps, onSetPending,
  } = props;
  // As in Playwright's UI mode, a filtered tree's Run all runs the visible tests.
  const isFiltered = !!nameFilter || statusFilter !== 'all';

  // Pending state and the matching set/clear effects live in useTestTree
  // so main.tsx can read pendingIds for its own in-progress derivations.
  const handleSetPending = useCallback((nodeId: string) => onSetPending(nodeId), [onSetPending]);

  return (
    <div class="test-explorer">
      <div class="te-header">
        <div class="explorer-search">
          <Search size={13} />
          <input
            class="te-search"
            type="text"
            aria-label="Filter tests"
            placeholder="Filter tests..."
            value={nameFilter}
            onInput={(e) => onSetNameFilter((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="te-status-filters filter-tabs" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map(({ label, value }) => (
            <StatusButton
              key={value}
              label={label}
              value={value}
              count={countFor(value, counts)}
              active={statusFilter}
              onClick={onSetStatusFilter}
            />
          ))}
        </div>
      </div>
      <div class="te-toolbar explorer-toolbar">
        <span class="te-toolbar-title">Tests</span>
        <div class="te-toolbar-actions explorer-toolbar-actions">
          <button
            class="te-toolbar-btn"
            onClick={onRunAll}
            disabled={isRunning || !connected || (isFiltered && files.length === 0)}
            title={isFiltered ? 'Run visible tests' : 'Run all tests'}
          >
            <Play size={TOOLBAR_ICON_SIZE} />
          </button>
          <button
            class={`te-toolbar-btn${isStopping ? ' stopping' : ''}`}
            onClick={onStop}
            disabled={!isRunning || isStopping}
            title={isStopping ? 'Stopping…' : 'Stop current run'}
          >
            <Square size={TOOLBAR_ICON_SIZE} />
          </button>
          <button
            class={`te-toolbar-btn ${isWatching ? 'active' : ''}`}
            onClick={() => onSend({ type: 'toggle-watch', filePath: 'all' })}
            disabled={!connected}
            title={isWatching ? 'Disable watch mode' : 'Watch all files for changes'}
          >
            <Eye size={TOOLBAR_ICON_SIZE} />
          </button>
          {hasProjectDeps && (
            <button
              class={`te-toolbar-btn ${runDepsFirst ? 'active' : ''}`}
              onClick={onToggleRunDeps}
              title={runDepsFirst
                ? 'Dependencies run automatically — click to disable'
                : 'Run dependency projects first — click to enable'}
            >
              <Link size={TOOLBAR_ICON_SIZE} />
            </button>
          )}
          <span class="te-toolbar-sep" />
          <button class="te-toolbar-btn" onClick={onExpandAll} title="Expand all">
            <ChevronsUpDown size={TOOLBAR_ICON_SIZE} />
          </button>
          <button class="te-toolbar-btn" onClick={onCollapseAll} title="Collapse all">
            <ChevronsDownUp size={TOOLBAR_ICON_SIZE} />
          </button>
        </div>
      </div>
      <div class="te-tree" role="tree" aria-label="Tests">
        {files.map((file) => (
          <TreeNode
            key={file.id}
            node={file}
            depth={0}
            expandedNodes={expandedNodes}
            selectedTestId={selectedTestId}
            onToggleExpanded={onToggleExpanded}
            onSelectTest={onSelectTest}
            onSend={onSend}
            isRunning={isRunning}
            pendingIds={pendingIds}
            onSetPending={handleSetPending}
          />
        ))}
        {files.length === 0 && (
          <div class="te-empty" data-testid="tests-empty">No tests found</div>
        )}
      </div>
    </div>
  );
}

// ─── Status filter button ───

type StatusFilterValue = 'all' | 'passed' | 'failed' | 'skipped'

const STATUS_FILTERS: Array<{ label: string; value: StatusFilterValue }> = [
  { label: 'All', value: 'all' },
  { label: 'Pass', value: 'passed' },
  { label: 'Fail', value: 'failed' },
  { label: 'Skip', value: 'skipped' },
];

function countFor(
  value: StatusFilterValue,
  counts: { passed: number; failed: number; skipped: number; total: number },
): number {
  return value === 'all' ? counts.total : counts[value];
}

interface StatusButtonProps {
  label: string
  value: StatusFilterValue
  count: number
  active: string
  onClick: (value: StatusFilterValue) => void
}

function StatusButton({ label, value, count, active, onClick }: StatusButtonProps) {
  const isActive = active === value;
  return (
    <button
      class={`te-status-btn filter-tab ${isActive ? 'active' : ''} te-status-${value}`}
      aria-pressed={isActive}
      onClick={() => onClick(value)}
    >
      {value !== 'all' && <span class={`ind ind-${value}`} />}
      {label} {count > 0 && <span class="te-count ct" data-testid="filter-count">{count}</span>}
    </button>
  );
}

// ─── Tree node ───

interface TreeNodeProps {
  node: TestTreeNode
  depth: number
  /** Name of the nearest ancestor project node, if any. Threaded down so
   * file/test runs can include `projectName` and route to the right device
   * when the same file is shared across multiple projects. */
  parentProjectName?: string
  expandedNodes: Set<string>
  selectedTestId: string | null
  onToggleExpanded: (nodeId: string) => void
  onSelectTest: (testId: string | null) => void
  onSend: (msg: ClientMessage) => void
  isRunning: boolean
  pendingIds: Set<string>
  onSetPending: (nodeId: string) => void
}

function TreeNode({ node, depth, parentProjectName, expandedNodes, selectedTestId, onToggleExpanded, onSelectTest, onSend, isRunning, pendingIds, onSetPending }: TreeNodeProps) {
  const isExpanded = expandedNodes.has(node.id);
  const isSelected = selectedTestId === node.id;
  const hasChildren = node.children && node.children.length > 0;

  // Status flash animation (failures only — green flashes are distracting)
  const prevStatusRef = useRef(node.status);
  const [flashClass, setFlashClass] = useState('');

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = node.status;
    if (prev === 'running' && node.status === 'failed') {
      setFlashClass('te-status-flash-failed');
      const timer = setTimeout(() => setFlashClass(''), 600);
      return () => clearTimeout(timer);
    }
    setFlashClass('');
  }, [node.status]);

  const pending = pendingIds.has(node.id);

  const handleRun = useCallback((e: Event) => {
    e.stopPropagation();
    onSelectTest(node.id);
    onSetPending(node.id);
    if (node.type === 'project') {
      onSend({ type: 'run-project', projectName: node.name });
    } else if (node.type === 'file') {
      onSend({ type: 'run-file', filePath: node.filePath, projectName: parentProjectName });
    } else {
      onSend({ type: 'run-test', fullName: node.fullName, filePath: node.filePath, projectName: parentProjectName });
    }
  }, [node, parentProjectName, onSend, onSelectTest, onSetPending]);

  const handleWatch = useCallback((e: Event) => {
    e.stopPropagation();
    if (node.type === 'project') {
      // Project-level watch: server iterates every file in the project and
      // toggles whole-file watch scoped to that project.
      onSend({ type: 'toggle-watch', filePath: 'project', projectName: node.name });
      return;
    }
    // File nodes watch the whole file; test/suite nodes pass their fullName
    // as the filter so only that test (or describe subtree) re-runs.
    // parentProjectName scopes the watch to one project in multi-device
    // configs so sibling projects don't inherit it.
    const testFilter = node.type === 'file' ? undefined : node.fullName;
    onSend({ type: 'toggle-watch', filePath: node.filePath, testFilter, projectName: parentProjectName });
  }, [node, parentProjectName, onSend]);

  const handleClick = useCallback(() => {
    if (hasChildren) {
      onToggleExpanded(node.id);
    }
    onSelectTest(node.id);
  }, [node.id, hasChildren, onToggleExpanded, onSelectTest]);

  const runningClass = node.status === 'running' ? 'te-status-running' : '';

  // Project nodes are displayed bracketed. Derived once so the visible label
  // and the accessible names stay in step.
  const label = node.type === 'project' ? `[${node.name}]` : node.name;

  return (
    <div class="te-node-group" role="presentation">
      <div
        class={`te-node node ${isSelected ? 'selected' : ''} te-node-${node.type} ${runningClass} ${flashClass}`}
        role="treeitem"
        aria-label={label}
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-busy={pending && node.status !== 'running' ? true : undefined}
        data-status={node.status}
        data-depth={depth}
        data-type={node.type}
        style={{ '--depth': depth, paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
      >
        {hasChildren && (
          <span class={`te-chevron ${isExpanded ? 'expanded' : ''}`} />
        )}
        {!hasChildren && <span class="te-chevron-spacer" />}

        <StatusIcon status={node.status} pending={pending} />

        <span class="te-name" title={node.fullName}>
          {label}
        </span>

        {node.type === 'project' && node.dependencies && node.dependencies.length > 0 && (
          <span class="te-deps" title={`Depends on: ${node.dependencies.join(', ')}`}>
            <ArrowLeft size={10} /> {node.dependencies.join(', ')}
          </span>
        )}

        {(() => {
          const group = devicesBadge(node);
          return group
            ? <span class="te-devices" data-testid="node-devices" title={group.title}><Smartphone size={10} /> {group.label}</span>
            : null;
        })()}

        {(() => {
          const iso = isolationBadge(node);
          return iso
            ? <span class="te-isolation" data-testid="node-isolation" title={iso.title}>{iso.label}</span>
            : null;
        })()}

        {node.duration !== undefined && node.duration > 0 && (
          <span class="te-duration dur" data-testid="node-duration">{formatDuration(node.duration)}</span>
        )}

        <div class="te-actions">
          <button class="te-action-btn te-run-btn" onClick={handleRun} disabled={isRunning} title="Run" aria-label={`Run ${label}`}>
            <Play size={ICON_SIZE} />
          </button>
          <button
            class={`te-action-btn te-watch-btn ${node.watchEnabled ? 'active' : ''}`}
            onClick={handleWatch}
            aria-label={`Watch ${label}`}
            aria-pressed={!!node.watchEnabled}
            title={node.type === 'project'
              ? 'Watch all files in this project'
              : node.type === 'file'
                ? 'Watch file for changes'
                : node.type === 'suite'
                  ? 'Watch this describe block'
                  : 'Watch this test'}
          >
            <Eye size={ICON_SIZE} />
          </button>
        </div>
      </div>
      {hasChildren && isExpanded && node.children!.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          parentProjectName={node.type === 'project' ? node.name : parentProjectName}
          expandedNodes={expandedNodes}
          selectedTestId={selectedTestId}
          onToggleExpanded={onToggleExpanded}
          onSelectTest={onSelectTest}
          onSend={onSend}
          isRunning={isRunning}
          pendingIds={pendingIds}
          onSetPending={onSetPending}
        />
      ))}
    </div>
  );
}

// ─── Status icon ───

function StatusIcon({ status, pending }: { status: TestTreeNode['status']; pending?: boolean }) {
  // While pending (play clicked, run not yet reported as started) show the
  // pulsing pending icon regardless of the previous result — a lingering
  // passed/failed icon makes the UI feel unresponsive.
  if (pending && status !== 'running') {
    return <span class="te-status-icon pending"><Circle size={STATUS_SIZE} /></span>;
  }
  switch (status) {
    case 'passed':
      return <span class="te-status-icon passed"><Check size={STATUS_SIZE} /></span>;
    case 'failed':
      return <span class="te-status-icon failed"><X size={STATUS_SIZE} /></span>;
    case 'skipped':
      return <span class="te-status-icon skipped"><CircleSlash size={STATUS_SIZE} /></span>;
    case 'running':
      return <span class="te-status-icon running"><LoaderCircle size={STATUS_SIZE} /></span>;
    default:
      return <span class="te-status-icon idle"><Circle size={STATUS_SIZE} /></span>;
  }
}

// ─── Helpers ───

/**
 * The device group a project row declares (`use.devices`), named by member.
 * Shown once, on the row that declares it — the rail and the viewer's panes
 * already carry the group for every test under it.
 */
function devicesBadge(node: TestTreeNode): { label: string; title: string } | undefined {
  const use = node.use;
  if (!use?.devices || use.devices <= 1) return undefined;
  const names = use.deviceNames && use.deviceNames.length === use.devices ? use.deviceNames : undefined;
  return {
    label: names ? names.join(' · ') : `${use.devices} devices`,
    title: `Each test drives ${use.devices} devices${names ? `: ${names.join(', ')}` : ''} (use.devices)`,
  };
}

/**
 * The declared isolation for a node, when it declares one — a file or suite's
 * `test.use()`, or the project's `use` on the project row. Nothing is shown
 * for the implicit default, and nothing for what a row merely inherits, so
 * the tree stays quiet unless something opts in.
 */
function isolationBadge(node: TestTreeNode): { label: string; title: string } | undefined {
  const use = node.use;
  if (!use) return undefined;
  const parts: string[] = [];
  let label: string | undefined;
  if (use.appState) {
    label = 'state';
    parts.push(`Restores saved app state: ${use.appState}`);
  } else if (use.appState === '') {
    label = 'clear';
    parts.push('Starts from cleared app data (appState: "")');
  } else if (use.appReset && use.appReset !== 'auto') {
    label = use.appReset;
    parts.push(`appReset: ${use.appReset}`);
  }
  // A scope on its own is a declaration too (`test.use({ appResetScope:
  // 'test' })` keeps the configured mode but resets before every test).
  if (use.appResetScope === 'test') {
    label = label ? `${label} / test` : 'per test';
    parts.push('Reset before every test');
  } else if (use.appResetScope === 'file') {
    label ??= 'per file';
    parts.push('Reset once per file');
  }
  if (!label) return undefined;
  return { label, title: parts.join('\n') };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
