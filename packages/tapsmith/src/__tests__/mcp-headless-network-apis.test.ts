import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessTestDispatcher } from '../mcp/headless-dispatcher.js';

// PILOT-1013: each `run_tests` child is told whether the session's test files
// use the network APIs, from every discovered file (not only those the call
// runs), scanned again when a file it read changes.

interface Internals {
  _testFiles: string[]
  _networkApisInRun(): Promise<boolean>
  _startRunRequest(): void
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
    expect(await internals._networkApisInRun()).toBe(false);

    write('other.test.ts', `test('b', async ({ device }) => { await device.route('**', (r) => r.abort()) })`);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(other, later, later);
    expect(await internals._networkApisInRun()).toBe(true);
  });

  it('scans afresh at each run request, so a helper written since counts', async () => {
    const internals = new HeadlessTestDispatcher({}) as unknown as Internals;
    const a = write('a.test.ts', `import { mock } from './helper'\ntest('a', async ({ device }) => { await mock(device) })`);
    internals._testFiles = [a];
    internals._startRunRequest();
    expect(await internals._networkApisInRun()).toBe(false);
    fs.writeFileSync(path.join(dir, 'helper.ts'), `export async function mock(device: any) { await device.route('**', () => {}) }\n`);
    internals._startRunRequest();
    expect(await internals._networkApisInRun()).toBe(true);
  });
});
