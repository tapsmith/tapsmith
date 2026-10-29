import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fileLoadFailureTitle, isLoadFailureNode, loadErrorForReport, loadFailureFollowUp, loadFailureTreeNode, runFilterForFile, withoutLoadFailedFiles, parseMissingImport, withMissingImportFrame } from '../load-failure.js';
import { extractStack } from '../trace/trace-collector.js';
import type { TestTreeNode } from '../ui-mode/ui-protocol.js';
import { formatError } from '../reporters/base.js';

// PILOT-545: a missing-module error's stack holds only resolver frames, so the
// reporter has no user frame to draw a code frame from. The helper adds one at
// the import that failed, from whichever message shape the loader produced.

let tempDir: string;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeTestFile(source: string): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-load-frame-'));
  fs.mkdirSync(path.join(tempDir, 'tests'));
  const file = path.join(tempDir, 'tests', 'a-broken.test.ts');
  fs.writeFileSync(file, source);
  return file;
}

function errorWithStack(message: string, name = 'Error'): Error {
  const error = new Error(message);
  error.stack = `${name}: ${message}\n    at node:internal/modules/cjs/loader:1517:15\n    at defaultResolve (node:internal/modules/esm/resolve:992:11)`;
  return error;
}

const SOURCE = [
  "import { test } from 'tapsmith';",
  "import { login } from '../helpers/login';",
  '',
  "test('signs in', async () => { await login(); });",
].join('\n');

describe('parseMissingImport', () => {
  it('reads tsx\'s CommonJS "Require stack" shape', () => {
    expect(parseMissingImport("Cannot find module '../helpers/login'\nRequire stack:\n- /p/tests/a.test.ts\n- /p/other.ts"))
      .toEqual({ specifier: '../helpers/login', importer: '/p/tests/a.test.ts', isPackage: false });
  });

  it('reads Node ESM\'s resolved-path "imported from" shape', () => {
    expect(parseMissingImport("Cannot find module '/p/helpers/login' imported from /p/tests/a.test.ts"))
      .toEqual({ specifier: '/p/helpers/login', importer: '/p/tests/a.test.ts', isPackage: false });
  });

  it('reads Vite\'s quoted "imported from" shape and file URLs', () => {
    expect(parseMissingImport("Cannot find module './x' imported from 'file:///p/tests/a.test.ts?t=1'"))
      .toEqual({ specifier: './x', importer: '/p/tests/a.test.ts', isPackage: false });
  });

  it('reads Node\'s missing-package shape', () => {
    expect(parseMissingImport("Cannot find package 'left-pad' imported from /p/tests/a.test.ts"))
      .toEqual({ specifier: 'left-pad', importer: '/p/tests/a.test.ts', isPackage: true });
  });

  it('ignores any other error', () => {
    expect(parseMissingImport('x.fixme is not a function')).toBeUndefined();
    expect(parseMissingImport("Cannot find module 'x'")).toBeUndefined();
  });
});

describe('withMissingImportFrame', () => {
  it('adds a frame at the import line for the tsx shape', () => {
    const file = writeTestFile(SOURCE);
    const error = withMissingImportFrame(errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`));
    expect(extractStack(error.stack!)[0]).toEqual({ file, line: 2, column: 23 });
  });

  it('matches the resolved path Node ESM reports against the specifier as written', () => {
    const file = writeTestFile(SOURCE);
    const resolved = path.join(tempDir, 'helpers', 'login');
    const error = withMissingImportFrame(errorWithStack(
      `Cannot find module '${resolved}' imported from ${file}`,
      'Error [ERR_MODULE_NOT_FOUND]',
    ));
    expect(extractStack(error.stack!)[0]).toEqual({ file, line: 2, column: 23 });
  });

  it('finds a missing package\'s subpath import', () => {
    const file = writeTestFile("import pad from 'left-pad/index.js';\n");
    const error = withMissingImportFrame(errorWithStack(`Cannot find package 'left-pad' imported from ${pathToFileURL(file).href}`));
    expect(extractStack(error.stack!)[0]).toEqual({ file, line: 1, column: 17 });
  });

  it('lets the console reporter render a code frame at the import', () => {
    const file = writeTestFile(SOURCE);
    const error = withMissingImportFrame(errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`));
    const out = formatError(error).replace(/\x1b\[\d+m/g, '');
    expect(out).toMatch(/> 2 \| import \{ login \} from '..\/helpers\/login';/);
  });

  it('leaves the error alone when the import line cannot be found', () => {
    const file = writeTestFile("// the import was generated at runtime\nawait import(name);\n");
    const original = errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`);
    const stack = original.stack;
    expect(withMissingImportFrame(original).stack).toBe(stack);
  });

  it('leaves the error alone when the importer cannot be read', () => {
    const original = errorWithStack("Cannot find module './x'\nRequire stack:\n- /nonexistent/dir/a.test.ts");
    const stack = original.stack;
    expect(withMissingImportFrame(original).stack).toBe(stack);
  });

  it('leaves any other error alone', () => {
    const original = new TypeError('x.fixme is not a function');
    const stack = original.stack;
    expect(withMissingImportFrame(original).stack).toBe(stack);
  });
});

describe('loadFailureTreeNode', () => {
  it('keeps a file UI mode could not load in the tree, as one failed row with the error', () => {
    expect(loadFailureTreeNode('/repo/tests/a-broken.test.ts', "Cannot find module '../helpers/login'")).toEqual({
      id: '/repo/tests/a-broken.test.ts',
      type: 'file',
      name: 'a-broken.test.ts',
      filePath: '/repo/tests/a-broken.test.ts',
      fullName: 'a-broken.test.ts',
      status: 'idle',
      children: [{
        // Same id scheme and fullName as a discovered test, so the runner's
        // load-failure result for this file lands on this row.
        id: '/repo/tests/a-broken.test.ts::a-broken.test.ts — failed to load',
        type: 'test',
        name: 'a-broken.test.ts — failed to load',
        filePath: '/repo/tests/a-broken.test.ts',
        fullName: 'a-broken.test.ts — failed to load',
        status: 'failed',
        error: "Cannot find module '../helpers/login'",
      }],
    });
  });
});

describe('fileLoadFailureTitle', () => {
  it('names the file, so reporters that print only the title still say which file failed', () => {
    expect(fileLoadFailureTitle('/repo/tests/a-broken.test.ts')).toBe('a-broken.test.ts — failed to load');
  });
});

describe('withoutLoadFailedFiles', () => {
  const node = (type: TestTreeNode['type'], filePath: string, children?: TestTreeNode[]): TestTreeNode => ({
    id: `${type}:${filePath}`, type, name: filePath, filePath, fullName: filePath, status: 'idle', ...(children ? { children } : {}),
  });
  const ok = node('file', '/r/ok.test.ts', [node('test', '/r/ok.test.ts')]);
  const broken = loadFailureTreeNode('/r/broken.test.ts', 'boom');

  it('drops a file that failed to load, at the top level and under a project', () => {
    const failed = new Map([['/r/broken.test.ts', 'boom']]);
    expect(withoutLoadFailedFiles([ok, broken], failed)).toEqual([ok]);
    const project = node('project', '', [ok, broken]);
    expect(withoutLoadFailedFiles([project], failed)).toEqual([{ ...project, children: [ok] }]);
  });

  it('keeps every file when none failed', () => {
    expect(withoutLoadFailedFiles([ok, broken], new Map())).toEqual([ok, broken]);
  });
});

describe('loadFailureFollowUp (UI mode, after a file run)', () => {
  const failed = (message: string) => ({ status: 'failed' as const, error: new Error(message), fileLevelFailure: true });
  const passed = { status: 'passed' as const };

  it('shows a load failure the tree does not show yet — a helper broke after discovery', () => {
    expect(loadFailureFollowUp([failed('boom')], undefined)).toEqual({ show: 'boom' });
  });

  it('shows a newer load error than the one on the row', () => {
    expect(loadFailureFollowUp([failed('second')], 'first')).toEqual({ show: 'second' });
  });

  it('does nothing when the row already shows this error', () => {
    expect(loadFailureFollowUp([failed('boom')], 'boom')).toBeUndefined();
  });

  it('rediscovers a file shown as failed to load once it runs for real — its helper was fixed', () => {
    expect(loadFailureFollowUp([passed], 'boom')).toEqual({ rediscover: true });
  });

  it('leaves a healthy file, and a run that reported nothing, alone', () => {
    expect(loadFailureFollowUp([passed], undefined)).toBeUndefined();
    expect(loadFailureFollowUp([], 'boom')).toBeUndefined();
  });
});

describe('runFilterForFile', () => {
  it('runs the whole file when the filter is its load-failure row', () => {
    expect(runFilterForFile('/r/a.test.ts', 'a.test.ts — failed to load')).toBeUndefined();
  });

  it('keeps any other filter', () => {
    expect(runFilterForFile('/r/a.test.ts', 'login works')).toBe('login works');
    expect(runFilterForFile('/r/a.test.ts', undefined)).toBeUndefined();
    expect(runFilterForFile('/r/b.test.ts', 'a.test.ts — failed to load')).toBe('a.test.ts — failed to load');
  });
});

describe('loadErrorForReport', () => {
  it('strips the import cache-bust query tsx puts in a CommonJS require stack, so one error reads the same on every run', () => {
    const err = errorWithStack("Cannot find module './nope'\nRequire stack:\n- /p/tests/b.test.ts?t=1791152071448");
    const report = loadErrorForReport(err);
    expect(report.message).toBe("Cannot find module './nope'\nRequire stack:\n- /p/tests/b.test.ts");
    expect(report.stack).not.toContain('?t=');
  });

  it('returns a copy: the loader can re-throw the same error object for another import, which must not change', () => {
    const file = writeTestFile(SOURCE);
    const err = errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`);
    const original = err.stack;
    const first = loadErrorForReport(err);
    const second = loadErrorForReport(err);
    expect(err.stack).toBe(original);
    expect(second.stack).toBe(first.stack);
    expect(second.stack!.split('\n').filter((l) => l.includes(`${file}:2:23`))).toHaveLength(1);
  });

  // PILOT-784: a syntax error's stack holds only loader frames (esbuild's, or
  // Node's compile step), so the reporter had no line to show a code frame for.
  it('adds a frame at an esbuild syntax error, so the reporter shows the offending line', () => {
    const file = writeTestFile("import { test } from 'tapsmith';\ntest('a', async () => {\n  const x = ;\n});\n");
    const err = new Error(`Transform failed with 1 error:\n${file}:3:12: ERROR: Unexpected ";"`);
    err.stack = `${err.message}\n    at failureErrorWithLog (/x/node_modules/esbuild/lib/main.js:1752:15)`;
    const report = loadErrorForReport(err, file);
    expect(extractStack(report.stack!)[0]).toEqual({ file, line: 3, column: 13 });
    expect(formatError(report).replace(/\x1b\[\d+m/g, '')).toMatch(/> 3 \|\s+const x = ;/);
  });

  it('points an esbuild syntax error in an imported helper at the helper', () => {
    const file = writeTestFile(SOURCE);
    const helper = path.join(tempDir, 'helpers', 'login.ts');
    const err = new Error(`Transform failed with 1 error:\n${helper}:7:2: ERROR: Expected ")"`);
    err.stack = `${err.message}\n    at failureErrorWithLog (/x/node_modules/esbuild/lib/main.js:1752:15)`;
    expect(extractStack(loadErrorForReport(err, file).stack!)[0]).toEqual({ file: helper, line: 7, column: 3 });
  });

  it('locates a JavaScript test file\'s own syntax error, which Node reports with no location', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-load-frame-'));
    const file = path.join(tempDir, 'broken.test.mjs');
    fs.writeFileSync(file, "export const a = 1;\nconst x = ;\n");
    // As Node's ESM loader throws it (Vitest would transform a real import).
    const err = new SyntaxError("Unexpected token ';'");
    err.stack = `SyntaxError: Unexpected token ';'\n    at compileSourceTextModule (node:internal/modules/esm/utils:318:16)\n    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:89:18)`;
    const report = loadErrorForReport(err, file);
    expect(extractStack(report.stack!)[0]).toEqual({ file, line: 2, column: 11 });
    expect(report).toBeInstanceOf(SyntaxError);
  });

  it('adds no frame for a SyntaxError the file\'s code threw at run time', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-load-frame-'));
    const file = path.join(tempDir, 'throws.test.mjs');
    fs.writeFileSync(file, 'JSON.parse("{");\n');
    let err: unknown;
    try { JSON.parse('{'); } catch (e) { err = e; }
    const report = loadErrorForReport(err, file);
    expect(report.stack).toBe((err as Error).stack);
  });

  it('keeps the error\'s class and code', () => {
    const err = Object.assign(new TypeError('x is not a function'), { code: 'X' });
    const report = loadErrorForReport(err);
    expect(report).toBeInstanceOf(TypeError);
    expect((report as Error & { code?: string }).code).toBe('X');
  });
});

describe('isLoadFailureNode', () => {
  it('recognises the load-failure file node, and only that', () => {
    expect(isLoadFailureNode(loadFailureTreeNode('/r/a.test.ts', 'boom'))).toBe(true);
    expect(isLoadFailureNode(undefined)).toBe(false);
    expect(isLoadFailureNode({
      id: '/r/a.test.ts', type: 'file', name: 'a.test.ts', filePath: '/r/a.test.ts', fullName: 'a.test.ts', status: 'idle',
      children: [{ id: '/r/a.test.ts::works', type: 'test', name: 'works', filePath: '/r/a.test.ts', fullName: 'works', status: 'idle' }],
    })).toBe(false);
  });
});
