/**
 * Tapsmith inside a CommonJS user project (PILOT-382).
 *
 * Most app repos (React Native / Expo included) have no `"type": "module"`,
 * so tsx compiles their TypeScript tests and config to CommonJS and those
 * `require('tapsmith')`. Nothing else in CI sees that shape — `e2e/` is
 * `"type": "module"` — so these tests build it in a scratch directory and
 * drive the *built* package through it: the CLI's tsx re-exec, the discovery
 * child every UI-mode and MCP session forks, and config loading.
 *
 * They test `dist/`, so rebuild (`npm run build`, or `npx tsc` for the SDK
 * alone) after changing the code they cover — a stale dist is tested as-is.
 * CI compiles dist/ before the unit tests; a local run with no build skips them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTsxBin } from '../child-scripts.js';
import type { TestTreeNode, UIDiscoverChildMessage } from '../ui-mode/ui-protocol.js';

const PKG_DIR = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(PKG_DIR, 'dist');
const DIST_BUILT = fs.existsSync(path.join(DIST_DIR, 'cli.js'));

if (!DIST_BUILT && !process.env.CI) {
  console.warn('cjs-project.test.ts: skipped — dist/ is not built (run `npm run build`).');
}

const TEST_FILE = 'import { test, describe, expect } from "tapsmith";\n'
  + '// Named after the module format tsx actually compiled this file to, so a\n'
  + '// scratch project that stops being CommonJS fails loudly.\n'
  + 'const format = typeof module === "object" && typeof require === "function" ? "cjs" : "esm";\n'
  + 'describe("login", () => {\n'
  + '  test(`runs as ${format}`, async () => { expect(1).toBe(1); });\n'
  + '});\n';

// Each test cold-starts node or tsx children (and one copies dist/); vitest's
// 5 s default also fails synchronous tests that overrun, so allow for a slow runner.
describe.skipIf(!DIST_BUILT && !process.env.CI)('a CommonJS user project', { timeout: 60_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-cjs-')));
    // The npm default: no "type" field, so .ts files compile to CommonJS.
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "cjs-app", "private": true }\n');
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests', 'login.test.ts'), TEST_FILE);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('has a built dist/ to test', () => {
    expect(DIST_BUILT, 'dist/cli.js is missing — run `npm run build` before these tests').toBe(true);
  });

  /** Links node_modules/tapsmith to this package, with its own dependency tree (tsx included). */
  function linkPackage(): void {
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(PKG_DIR, path.join(root, 'node_modules', 'tapsmith'), 'dir');
  }

  describe('tapsmith test in a hoisted install, run as `node node_modules/tapsmith/dist/cli.js`', () => {
    /**
     * The layout `npm install tapsmith` produces: tapsmith with no
     * node_modules of its own and every dependency hoisted beside it. The
     * package is copied, not linked — Node resolves a link to its real path,
     * which would put this checkout's own node_modules/.bin/tsx back in reach.
     * tsx itself is left out; each test supplies (or withholds) its own.
     */
    function installHoisted(): string {
      const modules = path.join(root, 'node_modules');
      const pkg = path.join(modules, 'tapsmith');
      fs.mkdirSync(pkg, { recursive: true });
      fs.copyFileSync(path.join(PKG_DIR, 'package.json'), path.join(pkg, 'package.json'));
      fs.cpSync(DIST_DIR, path.join(pkg, 'dist'), {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}__tests__`) && !src.endsWith('.map'),
      });
      for (const entry of fs.readdirSync(path.join(PKG_DIR, 'node_modules'))) {
        if (entry.startsWith('.') || entry === 'tsx') continue;
        fs.symlinkSync(path.join(PKG_DIR, 'node_modules', entry), path.join(modules, entry));
      }
      fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'), 'export default { platform: "android" };\n');
      return path.join(pkg, 'dist', 'cli.js');
    }

    function runCli(cli: string, env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
      // A PATH holding node and nothing else: node's own bin directory, or
      // Homebrew's, is exactly where a global tsx would be found.
      const bareBin = path.join(root, 'path-bin');
      fs.mkdirSync(bareBin);
      fs.symlinkSync(process.execPath, path.join(bareBin, 'node'));
      return spawnSync(process.execPath, [cli, 'test', 'tests/login.test.ts'], {
        cwd: root,
        encoding: 'utf-8',
        timeout: 60_000,
        // NODE_PATH and HOME (~/.node_modules) would let resolveTsxBin's
        // require.resolve step find a tsx installed on this machine.
        env: { ...process.env, PATH: bareBin, NODE_PATH: '', HOME: root, TAPSMITH_TELEMETRY: '0', ...env },
      });
    }

    it('re-execs through the hoisted tsx', () => {
      const cli = installHoisted();
      // A stand-in tsx that records how it was invoked, so the run stops at
      // the re-exec instead of reaching for a device.
      const argsFile = path.join(root, 'tsx-args.txt');
      const bin = path.join(root, 'node_modules', '.bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'tsx'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TSX_ARGS_FILE"\n', { mode: 0o755 });

      const result = runCli(cli, { TSX_ARGS_FILE: argsFile });

      expect(result.stderr).not.toContain('ENOENT');
      expect(result.status).toBe(0);
      expect(fs.readFileSync(argsFile, 'utf-8').trim().split('\n'))
        .toEqual([cli, 'test', 'tests/login.test.ts', '--__tsx-reexec']);
    });

    it('explains what to do when no tsx can be found at all', () => {
      const cli = installHoisted();

      const result = runCli(cli);

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('ENOENT');
      expect(result.stderr).toMatch(/could not find the tsx loader/i);
      expect(result.stderr).toContain('npm install tapsmith');
    });
  });

  it('discovers the tests of a TypeScript file compiled to CommonJS', async () => {
    linkPackage();
    const tsx = resolveTsxBin(PKG_DIR);
    expect(tsx, 'this checkout has no tsx — run `npm ci`').toBeDefined();
    const filePath = path.join(root, 'tests', 'login.test.ts');

    // The same fork UI mode and the MCP server make for each test file.
    const child = fork(path.join(DIST_DIR, 'ui-mode', 'ui-discover.js'), [], {
      cwd: root,
      execPath: tsx,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_PATH: path.dirname(PKG_DIR), TAPSMITH_TELEMETRY: '0' },
    });
    let reply: UIDiscoverChildMessage;
    let replyTimer: NodeJS.Timeout | undefined;
    try {
      reply = await new Promise<UIDiscoverChildMessage>((resolve, reject) => {
        // Both streams drained: an unread pipe can fill and stall the child.
        let output = '';
        // Rejects inside the suite's 60 s budget, so a hung child is killed by
        // the finally below instead of outliving a test vitest abandoned.
        replyTimer = setTimeout(() => reject(new Error(`discovery did not reply within 45 s:\n${output}`)), 45_000);
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('message', (msg: UIDiscoverChildMessage) => resolve(msg));
        child.on('error', reject);
        // 'close', not 'exit': it fires only once the IPC channel and stdio are
        // done, so a reply sent just before the child exits has been delivered.
        child.on('close', (code) => reject(new Error(`discovery exited (${code}) without replying:\n${output}`)));
        child.send({ type: 'discover', filePath });
      });
    } finally {
      clearTimeout(replyTimer);
      // A hung child would otherwise outlive the test with its IPC channel open.
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }

    if (reply.type === 'discover-error') throw new Error(reply.error.stack ?? reply.error.message);
    const names = (node: TestTreeNode): string[] => [node.fullName, ...(node.children ?? []).flatMap(names)];
    expect(names(reply.tree)).toContain('login > runs as cjs');
  });

  describe('a tapsmith.config.ts that imports tapsmith', () => {
    /** Loads the project's config the way the CLI does: the built loadConfig, in bare Node. */
    function loadConfigInBareNode(): { platform?: string; retries?: number } {
      const script = `const { loadConfig } = await import(${JSON.stringify(path.join(DIST_DIR, 'config.js'))});\n`
        + `const c = await loadConfig(${JSON.stringify(root)});\n`
        + 'process.stdout.write(JSON.stringify({ platform: c.platform, retries: c.retries }));\n';
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, TAPSMITH_TELEMETRY: '0' },
      });
      if (result.status !== 0) throw new Error(`loadConfig failed:\n${result.stderr}`);
      return JSON.parse(result.stdout) as { platform?: string; retries?: number };
    }

    // Node 22 before 22.18 strips types only behind a flag, so there this
    // would take the tsx fallback too and say nothing about native loading.
    it.skipIf(!process.features.typescript)('loads when Node can import it natively', () => {
      linkPackage();
      fs.writeFileSync(path.join(root, 'tapsmith.config.ts'),
        'import { defineConfig } from "tapsmith";\n'
        + 'export default defineConfig({ platform: "ios", retries: 2 });\n');

      expect(loadConfigInBareNode()).toEqual({ platform: 'ios', retries: 2 });
    });

    it('loads when it needs tsx, which compiles it to CommonJS', () => {
      linkPackage();
      // An enum is not erasable, so native type stripping refuses the file and
      // loadConfig retries it through tsx.
      fs.writeFileSync(path.join(root, 'tapsmith.config.ts'),
        'import { defineConfig } from "tapsmith";\n'
        + 'enum Retries { None = 0, Some = 2 }\n'
        + 'export default defineConfig({ platform: "ios", retries: Retries.Some });\n');

      expect(loadConfigInBareNode()).toEqual({ platform: 'ios', retries: 2 });
    });
  });
});
