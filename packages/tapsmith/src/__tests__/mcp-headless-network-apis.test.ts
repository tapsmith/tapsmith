import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessTestDispatcher } from '../mcp/headless-dispatcher.js';

// PILOT-1013: each `run_tests` child is told whether the session's test files
// use the network APIs, from every discovered file (not only those the call
// runs), scanned again when the files or their stamps move.

interface Internals {
  _testFiles: string[]
  _fileStamps: Map<string, string>
  _networkApisInRun(): Promise<boolean>
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-mcp-netapis-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `import { test } from 'tapsmith'\n${body}\n`);
  return file;
}

describe('headless MCP: network APIs in the session', () => {
  it('answers from every discovered file and scans again when a file changes', async () => {
    const internals = new HeadlessTestDispatcher({}) as unknown as Internals;
    const plain = write('plain.test.ts', `test('a', async ({ device }) => { await device.launchApp() })`);
    const other = write('other.test.ts', `test('b', async () => {})`);
    internals._testFiles = [plain, other];
    internals._fileStamps = new Map([[plain, '1'], [other, '1']]);
    expect(await internals._networkApisInRun()).toBe(false);

    write('other.test.ts', `test('b', async ({ device }) => { await device.route('**', (r) => r.abort()) })`);
    // Same stamps: the answer stands.
    expect(await internals._networkApisInRun()).toBe(false);
    internals._fileStamps.set(other, '2');
    expect(await internals._networkApisInRun()).toBe(true);
  });
});
