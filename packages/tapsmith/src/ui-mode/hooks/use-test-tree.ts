/**
 * Test tree state management hook for UI mode.
 *
 * Manages the hierarchical test tree, expansion state, filtering,
 * and status updates from the server.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';
import type { TestTreeNode, TestNodeStatus } from '../ui-protocol.js';
import { usePersistedString, usePersistedJSON } from './use-persisted-state.js';

export function useTestTree(isRunning: boolean = false) {
  const [files, setFiles] = useState<TestTreeNode[]>([]);
  const [expandedNodes, _setExpandedNodes] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem('tapsmith-expanded-nodes');
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set<string>();
  });
  const setExpandedNodes = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    _setExpandedNodes((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try { sessionStorage.setItem('tapsmith-expanded-nodes', JSON.stringify([...next])); } catch { /* quota */ }
      return next;
    });
  }, []);
  const [selectedTestId, setSelectedTestId] = usePersistedJSON<string | null>('tapsmith-selected-test', null);
  const selectedTestIdRef = useRef(selectedTestId);
  selectedTestIdRef.current = selectedTestId;
  const [nameFilter, setNameFilter] = usePersistedString('tapsmith-name-filter', '');
  // Pending = play clicked but the worker hasn't fired test-start yet
  // (covers IPC dispatch + ESM import + runner setup). Tracked here so the
  // Actions tab can mirror the tree pulse with its own in-progress UI from
  // the moment of the click, not just after test-start arrives.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const pendingSnapshots = useRef<Map<string, TestTreeNode['status']>>(new Map());
  const [statusFilter, setStatusFilter] = usePersistedString('tapsmith-status-filter', 'all') as [
    'all' | 'passed' | 'failed' | 'skipped',
    (v: 'all' | 'passed' | 'failed' | 'skipped') => void,
  ];

  const setTestTree = useCallback((newFiles: TestTreeNode[]) => {
    setFiles(newFiles);
    // Preserve previously-expanded nodes whose IDs still exist in the new
    // tree, then ensure project nodes are always expanded by default.
    // Without this, every server-side `test-tree` broadcast (including the
    // one fired on each WebSocket reconnect — e.g. after the laptop wakes
    // from sleep) would collapse the user's path back to the project root,
    // making the still-set `selectedTestId` visually invisible.
    setExpandedNodes((prev) => {
      const validIds = new Set<string>();
      (function walk(nodes: TestTreeNode[]) {
        for (const n of nodes) {
          validIds.add(n.id);
          if (n.children) walk(n.children);
        }
      })(newFiles);

      const next = new Set<string>();
      for (const id of prev) if (validIds.has(id)) next.add(id);
      for (const node of newFiles) if (node.type === 'project') next.add(node.id);

      // Expand ancestors of the restored selection so it's visible.
      const sel = selectedTestIdRef.current;
      if (sel && validIds.has(sel)) {
        (function expandTo(nodes: TestTreeNode[]): boolean {
          for (const n of nodes) {
            if (n.id === sel) return true;
            if (n.children && expandTo(n.children)) {
              next.add(n.id);
              return true;
            }
          }
          return false;
        })(newFiles);
      }

      return next;
    });
  }, []);

  /** Expand all nodes in the tree. */
  const expandAll = useCallback(() => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      function walk(nodes: TestTreeNode[]) {
        for (const node of nodes) {
          if (node.children && node.children.length > 0) {
            next.add(node.id);
            walk(node.children);
          }
        }
      }
      walk(files);
      return next;
    });
  }, [files]);

  /** Collapse all nodes in the tree. */
  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  /** Expand the path from root to a specific test node. When `projectName`
   * is provided, only expand within that project's subtree. */
  const expandPathTo = useCallback((fullName: string, filePath: string, projectName?: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      function walk(nodes: TestTreeNode[]): boolean {
        for (const node of nodes) {
          if (node.type === 'test' && node.fullName === fullName && node.filePath === filePath) {
            return true;
          }
          if (node.children) {
            if (walk(node.children)) {
              next.add(node.id);
              return true;
            }
          }
        }
        return false;
      }
      const roots = projectName
        ? files.filter((n) => n.type === 'project' && n.name === projectName)
        : files;
      walk(roots);
      return next;
    });
  }, [files]);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const updateTestStatus = useCallback((
    fullName: string,
    filePath: string,
    status: TestNodeStatus,
    duration?: number,
    error?: string,
    projectName?: string,
  ) => {
    setFiles((prev) => updateNodeInTree(prev, fullName, filePath, status, duration, error, projectName));
  }, []);

  const updateFileStatus = useCallback((filePath: string, status: 'running' | 'done', projectName?: string) => {
    setFiles((prev) => updateFileStatusInTree(prev, filePath, status, projectName));
  }, []);

  const updateWatchEnabled = useCallback((filePath: string, enabled: boolean, testFilter?: string, projectName?: string) => {
    if (filePath === 'project' && projectName) {
      setFiles((prev) => updateProjectWatchInTree(prev, projectName, enabled));
      return;
    }
    setFiles((prev) => updateWatchInTree(prev, filePath, enabled, testFilter, projectName));
  }, []);

  /** Reset any 'running' nodes back to 'idle' (e.g. after a stopped run). */
  const resetRunningStatuses = useCallback(() => {
    setFiles((prev) => prev.map(resetRunningInTree));
  }, []);

  // Pending lifecycle: clear a node from pending once its status has moved
  // off the snapshot taken at click time. Catches the normal transition to
  // 'running' AND the edge case where the worker jumps straight to a
  // terminal state without an intermediate 'running'.
  useEffect(() => {
    if (pendingIds.size === 0) return;
    const stillPending = new Set<string>();
    const check = (node: TestTreeNode) => {
      if (pendingIds.has(node.id)) {
        const snapshot = pendingSnapshots.current.get(node.id);
        const unchanged = snapshot === undefined
          ? node.status !== 'running'
          : node.status === snapshot;
        if (unchanged) stillPending.add(node.id);
      }
      node.children?.forEach(check);
    };
    files.forEach(check);
    if (stillPending.size !== pendingIds.size) {
      for (const id of pendingIds) {
        if (!stillPending.has(id)) pendingSnapshots.current.delete(id);
      }
      setPendingIds(stillPending);
    }
  }, [files, pendingIds]);

  // Clear all pending when isRunning transitions true → false (run ends).
  // pendingIds is read via ref so the effect only fires on isRunning changes
  // — including it as a dep would immediately clear pending set by
  // setPending() because isRunning is still false at click time.
  const pendingIdsRef = useRef(pendingIds);
  pendingIdsRef.current = pendingIds;
  useEffect(() => {
    if (!isRunning && pendingIdsRef.current.size > 0) {
      pendingSnapshots.current.clear();
      setPendingIds(new Set());
    }
  }, [isRunning]);

  /** Mark a node (and its subtree + ancestor chain) as pending — call when
   * the user clicks play, before the server has confirmed the run has
   * started. */
  const setPending = useCallback((nodeId: string) => {
    const parentMap = buildParentMap(files);
    const node = findNode(files, nodeId);
    if (!node) return;
    const ids = collectSubtreeIds(node);
    let cur = parentMap.get(nodeId);
    while (cur) {
      ids.push(cur);
      cur = parentMap.get(cur);
    }
    for (const id of ids) {
      const n = findNode(files, id);
      if (n) pendingSnapshots.current.set(id, n.status);
    }
    setPendingIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, [files]);

  /** Mark the node targeted by a server `run-start` as pending. Unlike
   * setPending (which takes a known tree-node id from a local click), this
   * resolves the node from the run-start locator — filePath, optional
   * testFilter (a test/suite fullName), and projectName. Used so runs the
   * client didn't initiate (MCP agents, or a play-click in another browser
   * tab) still show the preflight pulse. Resolving by filePath/fullName
   * rather than rebuilding the id string is deliberate: when projects are
   * configured the tree prefixes ids with `project::<name>::` even for the
   * "default" project, yet the server reports that project as an undefined
   * projectName — so a reconstructed id would never match. */
  const setPendingForRun = useCallback((filePath: string, testFilter: string | undefined, projectName: string | undefined) => {
    const nodeId = findNodeIdByLocator(files, filePath, testFilter, projectName);
    if (nodeId) setPending(nodeId);
  }, [files, setPending]);

  // Filter the tree based on name and status
  const isFiltered = !!nameFilter || statusFilter !== 'all';
  const filteredFiles = useMemo(() => {
    if (!isFiltered) return files;
    return filterTree(files, nameFilter.toLowerCase(), statusFilter);
  }, [files, nameFilter, statusFilter, isFiltered]);

  // Compute summary counts
  const counts = useMemo(() => {
    let passed = 0, failed = 0, skipped = 0, total = 0;
    function walk(nodes: TestTreeNode[]) {
      for (const node of nodes) {
        if (node.type === 'test') {
          total++;
          if (node.status === 'passed') passed++;
          else if (node.status === 'failed') failed++;
          else if (node.status === 'skipped') skipped++;
        }
        if (node.children) walk(node.children);
      }
    }
    walk(files);
    return { passed, failed, skipped, total };
  }, [files]);

  const hasWatchedFiles = useMemo(() => {
    function walk(nodes: TestTreeNode[]): boolean {
      for (const n of nodes) {
        if (n.watchEnabled) return true;
        if (n.children && walk(n.children)) return true;
      }
      return false;
    }
    return walk(files);
  }, [files]);

  return {
    files: filteredFiles,
    allFiles: files,
    /** A name or status filter narrows the tree, so Run all runs only what it shows. */
    isFiltered,
    hasWatchedFiles,
    expandedNodes,
    selectedTestId,
    nameFilter,
    statusFilter,
    counts,
    pendingIds,
    setTestTree,
    toggleExpanded,
    expandAll,
    collapseAll,
    expandPathTo,
    setSelectedTestId,
    setNameFilter,
    setStatusFilter,
    updateTestStatus,
    updateFileStatus,
    updateWatchEnabled,
    resetRunningStatuses,
    setPending,
    setPendingForRun,
  };
}

/**
 * Resolve a run-start locator (filePath + optional test/suite fullName +
 * optional projectName) to the matching tree-node id. When projectName is
 * given, only that project's subtree is searched — required for multi-device
 * configs where the same file lives under several projects. When it's absent
 * (single/default project, or flat layout) the first match wins, which is
 * unambiguous because the server only omits projectName when the file is
 * unique across the tree.
 */
function findNodeIdByLocator(
  roots: TestTreeNode[],
  filePath: string,
  testFilter: string | undefined,
  projectName: string | undefined,
): string | undefined {
  let searchRoots = roots;
  if (projectName) {
    const proj = roots.find((n) => n.type === 'project' && n.name === projectName);
    searchRoots = proj?.children ?? [];
  }
  let found: string | undefined;
  const walk = (nodes: TestTreeNode[]): boolean => {
    for (const n of nodes) {
      const isMatch = testFilter
        ? (n.filePath === filePath && n.fullName === testFilter && (n.type === 'test' || n.type === 'suite'))
        : (n.type === 'file' && n.filePath === filePath);
      if (isMatch) { found = n.id; return true; }
      if (n.children && walk(n.children)) return true;
    }
    return false;
  };
  walk(searchRoots);
  return found;
}

// Helpers used by setPending (also used inside TestExplorer rendering)

function buildParentMap(roots: TestTreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: TestTreeNode, parentId?: string) => {
    if (parentId) map.set(node.id, parentId);
    node.children?.forEach((c) => walk(c, node.id));
  };
  roots.forEach((r) => walk(r));
  return map;
}

function collectSubtreeIds(node: TestTreeNode, out: string[] = []): string[] {
  out.push(node.id);
  node.children?.forEach((c) => collectSubtreeIds(c, out));
  return out;
}

function findNode(roots: TestTreeNode[], id: string): TestTreeNode | undefined {
  for (const root of roots) {
    if (root.id === id) return root;
    if (root.children) {
      const found = findNode(root.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

// ─── Helpers ───

function updateNodeInTree(
  nodes: TestTreeNode[],
  fullName: string,
  filePath: string,
  status: TestNodeStatus,
  duration?: number,
  error?: string,
  projectName?: string,
): TestTreeNode[] {
  return nodes.map((node) => {
    // When a projectName is provided, only descend into the matching project.
    // Other project nodes are left untouched so the same file living in
    // multiple projects doesn't get its status mirrored across all of them.
    if (node.type === 'project' && projectName && node.name !== projectName) {
      return node;
    }

    // Project nodes contain files with various paths — always recurse.
    // Other nodes skip if filePath doesn't match.
    if (node.type !== 'project' && node.filePath !== filePath) return node;

    if (node.type === 'test' && node.fullName === fullName) {
      return { ...node, status, duration, error };
    }

    if (node.children) {
      const updatedChildren = updateNodeInTree(node.children, fullName, filePath, status, duration, error, projectName);
      if (updatedChildren !== node.children) {
        // Derive parent status from children
        const childStatuses = flattenStatuses(updatedChildren);
        const hasRunning = childStatuses.includes('running');
        const hasIdle = childStatuses.includes('idle');
        const hasFailed = childStatuses.includes('failed');
        const allPassed = childStatuses.length > 0
          && childStatuses.every((s) => s === 'passed' || s === 'skipped');
        const allIdle = childStatuses.every((s) => s === 'skipped' || s === 'idle');
        const parentStatus = hasRunning ? 'running'
          // Still running with idle children means more tests are expected —
          // keep 'running' so the parent doesn't flash to passed/failed mid-run.
          : (node.status === 'running' && hasIdle) ? 'running'
          : hasFailed ? 'failed'
          : allPassed ? 'passed'
          : allIdle ? node.status
          : node.status;
        return { ...node, children: updatedChildren, status: parentStatus };
      }
    }

    return node;
  });
}

function flattenStatuses(nodes: TestTreeNode[]): TestNodeStatus[] {
  const statuses: TestNodeStatus[] = [];
  for (const node of nodes) {
    if (node.type === 'test') {
      statuses.push(node.status);
    }
    if (node.children) {
      statuses.push(...flattenStatuses(node.children));
    }
  }
  return statuses;
}

/**
 * Recursively re-derive all parent node statuses from leaf test statuses.
 * Called when a run finishes to clear stale 'running' from describe/file nodes.
 */
function rederiveTree(node: TestTreeNode): TestTreeNode {
  if (node.type === 'test' || !node.children) return node;
  const children = node.children.map(rederiveTree);
  const childStatuses = flattenStatuses(children);
  const hasFailed = childStatuses.includes('failed');
  const allPassed = childStatuses.length > 0
    && childStatuses.every((s) => s === 'passed' || s === 'skipped');
  const status: TestNodeStatus = hasFailed ? 'failed'
    : allPassed ? 'passed'
    : node.status === 'running' ? 'idle'
    : node.status;
  return { ...node, children, status };
}

/**
 * Recursively update a file node's status, handling project → file nesting.
 * Re-derives parent (project/suite) statuses after the update.
 */
function updateFileStatusInTree(
  nodes: TestTreeNode[],
  filePath: string,
  status: 'running' | 'done',
  projectName?: string,
): TestTreeNode[] {
  return nodes.map((node) => {
    // When a projectName is provided, only descend into the matching project.
    if (node.type === 'project' && projectName && node.name !== projectName) {
      return node;
    }

    // Direct match — file node
    if (node.type === 'file' && node.filePath === filePath) {
      if (status === 'running') return { ...node, status: 'running' as const };
      return rederiveTree(node);
    }

    // Recurse into project (or suite) children
    if (node.children) {
      const updatedChildren = updateFileStatusInTree(node.children, filePath, status, projectName);
      if (updatedChildren.some((c, i) => c !== node.children![i])) {
        return rederiveTree({ ...node, children: updatedChildren });
      }
    }

    return node;
  });
}

/**
 * Set watchEnabled on a specific project node (top-level), leaving its
 * descendants alone. Used for project-scoped watch toggles where the
 * project-level icon should light up on its own.
 */
function updateProjectWatchInTree(
  nodes: TestTreeNode[],
  projectName: string,
  enabled: boolean,
): TestTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'project' && node.name === projectName) {
      return { ...node, watchEnabled: enabled };
    }
    return node;
  });
}

/**
 * Recursively set watchEnabled on a node. If testFilter is undefined, targets
 * the file node; otherwise targets the test/suite node whose fullName matches
 * the filter within that file. When projectName is provided, only nodes
 * descended from that project's subtree are updated — in multi-device
 * configs the same file appears under multiple project subtrees, and watch
 * state must be per-project to match the project-specific run it triggers.
 */
function updateWatchInTree(
  nodes: TestTreeNode[],
  filePath: string,
  enabled: boolean,
  testFilter: string | undefined,
  projectName: string | undefined,
  insideMatchingProject: boolean = projectName === undefined,
): TestTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'project') {
      const childInside = projectName === undefined || node.name === projectName;
      if (!node.children) return node;
      const updatedChildren = updateWatchInTree(node.children, filePath, enabled, testFilter, projectName, childInside);
      if (updatedChildren.some((c, i) => c !== node.children![i])) {
        return { ...node, children: updatedChildren };
      }
      return node;
    }
    const isTarget = insideMatchingProject && (
      testFilter === undefined
        ? (node.type === 'file' && node.filePath === filePath)
        : (node.filePath === filePath && node.fullName === testFilter
            && (node.type === 'suite' || node.type === 'test'))
    );
    if (isTarget) {
      return { ...node, watchEnabled: enabled };
    }
    if (node.children) {
      const updatedChildren = updateWatchInTree(node.children, filePath, enabled, testFilter, projectName, insideMatchingProject);
      if (updatedChildren.some((c, i) => c !== node.children![i])) {
        return { ...node, children: updatedChildren };
      }
    }
    return node;
  });
}

/**
 * Recursively reset any 'running' node (test, suite, file, project)
 * back to 'idle'. Used when a run is stopped mid-flight.
 */
function resetRunningInTree(node: TestTreeNode): TestTreeNode {
  const status = node.status === 'running' ? 'idle' as const : node.status;
  if (!node.children) {
    return status !== node.status ? { ...node, status } : node;
  }
  const children = node.children.map(resetRunningInTree);
  const changed = status !== node.status || children.some((c, i) => c !== node.children![i]);
  return changed ? { ...node, status, children } : node;
}

function filterTree(
  nodes: TestTreeNode[],
  nameFilter: string,
  statusFilter: string,
): TestTreeNode[] {
  return nodes
    .map((node) => {
      if (node.type === 'test') {
        const matchesName = !nameFilter || node.fullName.toLowerCase().includes(nameFilter);
        const matchesStatus = statusFilter === 'all' || node.status === statusFilter;
        return matchesName && matchesStatus ? node : null;
      }

      // For files and suites, recurse into children
      const filteredChildren = node.children
        ? filterTree(node.children, nameFilter, statusFilter)
        : [];

      // Keep this node if it has matching children
      if (filteredChildren.length > 0) {
        return { ...node, children: filteredChildren };
      }

      return null;
    })
    .filter((node): node is TestTreeNode => node !== null);
}
