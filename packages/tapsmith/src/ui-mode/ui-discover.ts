/**
 * UI mode discovery child process.
 *
 * Imports a test file in dry-run mode, collects the test/suite tree
 * structure, and sends it back to the parent via IPC. Does NOT execute
 * any test bodies — only the describe() callbacks run to register the tree.
 *
 * @see PILOT-87
 */

import * as path from 'node:path';
import { discoverTestFile } from '../runner.js';
import { loadErrorForReport } from '../load-failure.js';
import type {
  UIDiscoverMessage,
  UIDiscoverChildMessage,
  TestTreeNode,
} from './ui-protocol.js';
import type { DiscoveredSuite } from '../runner.js';

// ─── Helpers ───

let ipcOpen = true;

function send(msg: UIDiscoverChildMessage): void {
  if (!ipcOpen || !process.send) return;
  try {
    process.send(msg);
  } catch {
    ipcOpen = false;
  }
}

/**
 * Convert the runner's DiscoveredSuite into the UI protocol's TestTreeNode.
 */
function suiteToTreeNode(suite: DiscoveredSuite, filePath: string): TestTreeNode[] {
  const nodes: TestTreeNode[] = [];

  for (const test of suite.tests) {
    nodes.push({
      id: `${filePath}::${test.fullName}`,
      type: 'test',
      name: test.name,
      filePath,
      fullName: test.fullName,
      status: 'idle',
      ...(test.use ? { use: test.use } : {}),
    });
  }

  for (const child of suite.suites) {
    const childNode: TestTreeNode = {
      id: `${filePath}::${child.name}`,
      type: 'suite',
      name: child.name.includes(' > ')
        ? child.name.split(' > ').pop()!
        : child.name,
      filePath,
      fullName: child.name,
      status: 'idle',
      children: suiteToTreeNode(child, filePath),
      ...(child.use ? { use: child.use } : {}),
    };
    nodes.push(childNode);
  }

  return nodes;
}

// ─── IPC handler ───

async function handleDiscover(msg: UIDiscoverMessage): Promise<void> {
  const suite = await discoverTestFile(msg.filePath);

  const fileNode: TestTreeNode = {
    id: msg.filePath,
    type: 'file',
    name: path.basename(msg.filePath),
    filePath: msg.filePath,
    fullName: path.basename(msg.filePath),
    status: 'idle',
    children: suiteToTreeNode(suite, msg.filePath),
    ...(suite.use ? { use: suite.use } : {}),
  };

  send({
    type: 'discover-result',
    filePath: msg.filePath,
    tree: fileNode,
  });
}

process.on('message', async (msg: UIDiscoverMessage) => {
  try {
    if (msg.type === 'discover') {
      await handleDiscover(msg);
      process.exit(0);
    }
  } catch (err) {
    // Without the cache-bust query discovery's import leaves in a CommonJS
    // require stack, so the same load error reads the same each time (PILOT-545).
    const error = loadErrorForReport(err, msg.filePath);
    send({
      type: 'discover-error',
      filePath: msg.filePath,
      error: { message: error.message, stack: error.stack },
    });
    process.exit(1);
  }
});
