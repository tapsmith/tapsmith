import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNetworkApiScanner, testFilesUseNetworkApis } from '../network-api-scan.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-netscan-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const header = `import { test, expect } from 'tapsmith'\n`;

describe('testFilesUseNetworkApis', () => {
  it('is false for no files', async () => {
    expect(await testFilesUseNetworkApis([])).toBe(false);
  });

  it('is false for tests that never use a network API', async () => {
    const a = write('a.test.ts', `${header}test('a', async ({ device }) => { await device.getByText('x').tap() })\n`);
    const b = write('b.test.ts', `${header}test('b', async ({ device }) => { await device.launchApp() })\n`);
    expect(await testFilesUseNetworkApis([a, b])).toBe(false);
  });

  it.each([
    ['route()', `await device.route('**/api', (r) => r.abort())`],
    ['waitForRequest()', `await device.waitForRequest('**/api')`],
    ['waitForResponse()', `const p = device.waitForResponse(/api/)`],
    ["on('request')", `device.on('request', () => {})`],
    ['on("response")', `device.on("response", () => {})`],
    ['an optional call', `await device?.route?.('**', () => {})`],
    ['a computed string key', `await device['route']('**', () => {})`],
    ['a computed template-literal key', 'await device[`waitForResponse`](\'**\')'],
    ['on() with a template-literal event', 'device.on(`request`, () => {})'],
    ['a destructured fixture under another name', `const d = devices[1]; await d.waitForRequest('**')`],
  ])('detects %s in a test file', async (_label, call) => {
    const plain = write('plain.test.ts', `${header}test('p', async ({ device }) => { await device.launchApp() })\n`);
    const net = write('net.test.ts', `${header}test('n', async ({ device, devices }) => { ${call} })\n`);
    expect(await testFilesUseNetworkApis([plain, net])).toBe(true);
  });

  it("does not count on() for other events", async () => {
    const f = write('a.test.ts', `${header}test('a', async ({ device }) => { emitter.on('data', () => {}) })\n`);
    expect(await testFilesUseNetworkApis([f])).toBe(false);
  });

  it('ignores mentions in comments and strings', async () => {
    const f = write('a.test.ts', `${header}
// await device.route('**', () => {})
/* device.waitForResponse('x') */
test('a', async ({ device }) => {
  console.log("device.route('**')")
  console.log(\`device.waitForRequest('x')\`)
})
`);
    expect(await testFilesUseNetworkApis([f])).toBe(false);
  });

  it('detects a call in a helper the test imports with a .js specifier', async () => {
    write('utils/mock.ts', `import type { Device } from 'tapsmith'
export async function mockApi(device: Device): Promise<void> {
  await device.route('**/api', (r) => r.fulfill({ status: 500 }))
}
`);
    const f = write('tests/a.test.ts', `${header}import { mockApi } from '../utils/mock.js'
test('a', async ({ device }) => { await mockApi(device) })
`);
    expect(await testFilesUseNetworkApis([f])).toBe(true);
  });

  it('follows an extensionless import of a dotted module name (a page object)', async () => {
    write('screens/login.page.ts', `export async function mock(d: any) { await d.route('**/login', () => {}) }\n`);
    write('fixtures/api.mock.ts', `export const wait = (d: any) => d.waitForResponse('**/api')\n`);
    const a = write('a.test.ts', `${header}import { mock } from './screens/login.page'\ntest('a', async ({ device }) => { await mock(device) })\n`);
    const b = write('b.test.ts', `${header}import { wait } from './fixtures/api.mock'\ntest('b', async ({ device }) => { await wait(device) })\n`);
    expect(await testFilesUseNetworkApis([a])).toBe(true);
    expect(await testFilesUseNetworkApis([b])).toBe(true);
  });

  it('follows imports transitively (a fixture file that imports a screen object)', async () => {
    write('screens/api.ts', `export class ApiScreen { constructor(private d: any) {}
  async waitForPosts() { return this.d.waitForResponse('**/posts') } }
`);
    write('fixtures.ts', `import { test as base } from 'tapsmith'
import { ApiScreen } from './screens/api'
export const test = base.extend({ apiScreen: async ({ device }, use) => { await use(new ApiScreen(device)) } })
`);
    const f = write('a.test.ts', `import { test } from './fixtures.js'\ntest('a', async ({ apiScreen }) => { await apiScreen.waitForPosts() })\n`);
    expect(await testFilesUseNetworkApis([f])).toBe(true);
  });

  it('does not scan a helper only another, unselected, file imports', async () => {
    write('utils/mock.ts', `export async function mockApi(device: any) { await device.route('**', () => {}) }\n`);
    write('net.test.ts', `import { mockApi } from './utils/mock.js'\nmockApi(null)\n`);
    const plain = write('plain.test.ts', `${header}test('p', async () => {})\n`);
    expect(await testFilesUseNetworkApis([plain])).toBe(false);
  });

  it('reads JavaScript test files and tolerates JSON and asset imports', async () => {
    write('data.json', `{ "url": "https://example.com" }`);
    write('logo.png', 'not really a png');
    const f = write('a.test.js', `import data from './data.json'
import logo from './logo.png'
export default async function run(device) { await device.waitForRequest(data.url) }
`);
    expect(await testFilesUseNetworkApis([f])).toBe(true);
  });

  it('still scans the other files when one cannot be bundled', async () => {
    const broken = write('broken.test.ts', `${header}import { nope } from './missing.js'\ntest('x', async () => {})\n`);
    const net = write('net.test.ts', `${header}test('n', async ({ device }) => { await device.route('**', () => {}) })\n`);
    expect(await testFilesUseNetworkApis([broken, net])).toBe(true);
  });

  it('still scans a file whose own imports cannot be resolved', async () => {
    const f = write('a.test.ts', `${header}import { helper } from './not-written-yet.js'\ntest('a', async ({ device }) => { await device.route('**', () => {}); await helper() })\n`);
    expect(await testFilesUseNetworkApis([f])).toBe(true);
  });

  it('follows the imports it can resolve in a file with one it cannot', async () => {
    write('screens/net.ts', `export async function mock(device: any) { await device.route('**', () => {}) }\n`);
    const f = write('tests/a.test.ts', `${header}import { mock } from '../screens/net'\nimport { later } from './not-written'\ntest('a', async ({ device }) => { await mock(device); later() })\n`);
    const g = write('tests/b.test.ts', `${header}import { mock } from '../screens/net'\nexport async function f() { return import('./missing-dyn') }\ntest('b', async ({ device }) => { await mock(device) })\n`);
    expect(await testFilesUseNetworkApis([f])).toBe(true);
    expect(await testFilesUseNetworkApis([g])).toBe(true);
  });

  it('is false when no file can be read', async () => {
    const broken = write('broken.test.ts', `this is not ( valid typescript`);
    expect(await testFilesUseNetworkApis([broken, path.join(dir, 'gone.test.ts')])).toBe(false);
  });
});

describe('createNetworkApiScanner', () => {
  const touch = (file: string, offsetMs: number): void => {
    const t = new Date(Date.now() + offsetMs);
    fs.utimesSync(file, t, t);
  };

  it('scans again when a test file, a helper it imports or the file list changes, and not otherwise', async () => {
    const scan = createNetworkApiScanner();
    const helper = write('utils/mock.ts', `export async function mockApi(device: any) { await device.launchApp() }\n`);
    const a = write('a.test.ts', `${header}import { mockApi } from './utils/mock.js'\ntest('a', async ({ device }) => { await mockApi(device) })\n`);
    expect(await scan([a])).toBe(false);

    // A helper the test imports starts mocking.
    fs.writeFileSync(helper, `export async function mockApi(device: any) { await device.route('**', () => {}) }\n`);
    touch(helper, 5_000);
    expect(await scan([a])).toBe(true);

    // Back to no mocking, in the test file itself this time.
    fs.writeFileSync(helper, `export async function mockApi(device: any) { await device.launchApp() }\n`);
    touch(helper, 10_000);
    expect(await scan([a])).toBe(false);

    // A new file that mocks joins the session.
    const b = write('b.test.ts', `${header}test('b', async ({ device }) => { await device.waitForResponse('**') })\n`);
    expect(await scan([a, b])).toBe(true);
  });

  it('reuses the last answer while nothing it read has changed', async () => {
    const scan = createNetworkApiScanner();
    const a = write('a.test.ts', `${header}test('a', async ({ device }) => { await device.route('**', () => {}) })\n`);
    const mtime = new Date(2026, 0, 1);
    fs.utimesSync(a, mtime, mtime);
    expect(await scan([a])).toBe(true);
    // Changed on disk without a new modification time: the answer stands.
    fs.writeFileSync(a, `${header}test('a', async () => {})\n`);
    fs.utimesSync(a, mtime, mtime);
    expect(await scan([a])).toBe(true);
  });

  const mocks = `export async function mockApi(device: any) { await device.route('**', () => {}) }\n`;
  it.each([
    ['a missing relative import is written', (): string => {
      write('utils/other.ts', `export const x = 1\n`);
      return `import { mockApi } from './utils/mock'`;
    }, (): void => { write('utils/mock.ts', mocks); }],
    ['a missing tsconfig alias target is written', (): string => {
      write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@h/*': ['helpers/*'] } } }));
      return `import { mockApi } from '@h/later'`;
    }, (): void => { write('helpers/later.ts', mocks); }],
    ['a missing folder index is written', (): string => {
      fs.mkdirSync(path.join(dir, 'screens'));
      return `import { mockApi } from './screens'`;
    }, (): void => { write('screens/index.ts', mocks); }],
    ['a broken helper is fixed', (): string => {
      write('good.ts', mocks);
      write('bad.ts', `export const y = (\n`);
      // A side-effect import: TypeScript drops an unused named one.
      return `import { mockApi } from './good'\nimport './bad'`;
    }, (): void => { write('bad.ts', `export const y = 1\n`); }],
  ])('scans afresh at a new run once %s, with the test file unchanged', async (_label, setup, change) => {
    const cwd = process.cwd();
    process.chdir(dir); // where esbuild finds the tsconfig
    try {
      const scan = createNetworkApiScanner();
      const a = write('a.test.ts', `${header}${setup()}\ntest('a', async ({ device }) => { await mockApi(device) })\n`);
      expect(await scan([a])).toBe(false);
      change();
      // Later files of the same run reuse the answer…
      expect(await scan([a])).toBe(false);
      // …and the next run scans again.
      scan.newRun();
      expect(await scan([a])).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('answers each call from its own scan when calls overlap', async () => {
    const scan = createNetworkApiScanner();
    const a = write('a.test.ts', `${header}test('a', async ({ device }) => { await device.route('**', () => {}) })\n`);
    const g = write('g.test.ts', `${header}test('g', async () => {})\n`);
    expect(await Promise.all([scan([g]), scan([a])])).toEqual([false, true]);
    expect(await Promise.all([scan([a]), (scan.newRun(), scan([g]))])).toEqual([true, false]);
  });

  it('reuses its answer while a file stays broken', async () => {
    const scan = createNetworkApiScanner();
    const mtime = new Date(2026, 0, 1);
    const lazy = write('lazy.test.ts', `${header}export async function f() { return import('./never-written') }\ntest('l', async () => {})\n`);
    const bad = write('bad.test.ts', `this is not ( valid typescript`);
    const a = write('a.test.ts', `${header}test('a', async ({ device }) => { await device.route('**', () => {}) })\n`);
    for (const f of [lazy, bad, a]) fs.utimesSync(f, mtime, mtime);
    expect(await scan([lazy, bad, a])).toBe(true);
    // Changed on disk without a new modification time: reused, not rescanned.
    fs.writeFileSync(a, `${header}test('a', async () => {})\n`);
    fs.utimesSync(a, mtime, mtime);
    expect(await scan([lazy, bad, a])).toBe(true);
  });

  it('scans a file again once it is edited, even one it could not read before', async () => {
    const scan = createNetworkApiScanner();
    const a = write('a.test.ts', `this is not ( valid typescript`);
    expect(await scan([a])).toBe(false);
    fs.writeFileSync(a, `${header}test('a', async ({ device }) => { await device.route('**', () => {}) })\n`);
    touch(a, 5_000);
    expect(await scan([a])).toBe(true);
  });
});
