import { describe, it, expect } from 'vitest';
import { HeadlessTestDispatcher } from '../mcp/headless-dispatcher.js';
import type { TestTreeEntry } from '../mcp/test-dispatcher.js';
import type { TestTreeNode } from '../ui-mode/ui-protocol.js';

// The headless MCP server lists and runs only the tests the config's grep
// selects, root and project, as `tapsmith test` does (PILOT-730).

const LOGIN = '/suite/login.test.ts';
const CART = '/suite/cart.test.ts';

function fileNode(filePath: string, tests: string[]): TestTreeNode {
  return {
    id: filePath, type: 'file', name: filePath.split('/').pop()!, filePath, fullName: filePath.split('/').pop()!, status: 'idle',
    children: tests.map((fullName) => ({ id: `${filePath}::${fullName}`, type: 'test', name: fullName, filePath, fullName, status: 'idle' })),
  };
}

interface Internals {
  _config: Record<string, unknown> | null
  _serializedConfig: unknown
  _projects: Array<Record<string, unknown>>
  _fileNodes: Map<string, TestTreeNode>
  _rebuildTestTree(): void
  _ensureTargetForProject(projectName?: string): Promise<unknown>
  _runFileInChild(filePath: string, useOptions?: unknown, projectName?: string): Promise<{ results: unknown[] }>
}

function dispatcher(config: Record<string, unknown>, projects: Array<{ name: string; grep?: RegExp; grepInvert?: RegExp; synthesized?: boolean }>): { d: HeadlessTestDispatcher; internals: Internals } {
  const d = new HeadlessTestDispatcher({});
  const internals = d as unknown as Internals;
  internals._config = config;
  internals._serializedConfig = {};
  internals._projects = projects.map((p) => ({
    ...p, effectiveConfig: { platform: 'android' }, testFiles: [LOGIN, CART], dependencies: [],
  }));
  internals._fileNodes = new Map([
    [LOGIN, fileNode(LOGIN, ['smoke: logs in', 'rejects a bad password'])],
    [CART, fileNode(CART, ['adds an item'])],
  ]);
  internals._rebuildTestTree();
  return { d, internals };
}

const listed = (entries: TestTreeEntry[]): string[] => entries.flatMap((e) =>
  e.type === 'test' ? [e.fullName] : listed(e.children ?? []).map((n) => (e.type === 'project' ? `${e.name}: ${n}` : n)));

describe('headless MCP and the config grep', () => {
  it('lists only the tests the root grep selects, dropping files it selects nothing in', () => {
    const { d } = dispatcher({ grep: /smoke/ }, [{ name: 'default', synthesized: true }]);
    expect(listed(d.getTestTree())).toEqual(['smoke: logs in']);
    expect(d.getTestTree().map((e) => e.filePath)).toEqual([LOGIN]);
  });

  it('lists each project by its own grep, together with the root grepInvert', () => {
    const { d } = dispatcher({ grepInvert: /bad password/ }, [
      { name: 'android', grep: /smoke/ },
      { name: 'ios' },
    ]);
    expect(listed(d.getTestTree())).toEqual([
      'android: smoke: logs in',
      'ios: smoke: logs in',
      'ios: adds an item',
    ]);
  });

  it('lists every test without a grep', () => {
    const { d } = dispatcher({}, [{ name: 'default', synthesized: true }]);
    expect(listed(d.getTestTree())).toEqual(['smoke: logs in', 'rejects a bad password', 'adds an item']);
  });

  // The tree is only as fresh as the last sync, so it cannot rule a run out:
  // an edit since may have added a matching test. The child applies the grep
  // itself.
  it('still runs a file the startup tree says the grep selects nothing in', async () => {
    const { internals } = dispatcher({}, [{ name: 'android', grep: /smoke/ }, { name: 'ios' }]);
    const targets: Array<string | undefined> = [];
    internals._ensureTargetForProject = async (projectName?: string): Promise<unknown> => {
      targets.push(projectName);
      throw new Error('device work');
    };
    await expect(internals._runFileInChild(CART, undefined, 'android')).rejects.toThrow('device work');
    expect(targets).toEqual(['android']);
  });
});
