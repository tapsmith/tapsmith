/**
 * Docs guard (PILOT-720): every TypeScript sample in the docs and READMEs is
 * type-checked against the SDK's real public surface, so a sample that calls a
 * method that does not exist (`device.getByContentDesc()`) or passes options a
 * method does not take (`device.webview({ timeout })`) fails here instead of in
 * a newcomer's editor.
 *
 * Samples are fragments, not programs: they use names they never declare
 * (`webview`, `fixtures`, a screen object), elide code with `…`, and repeat a
 * `const` to show alternatives. So the check reports only the diagnostics that
 * mean "this is not the API" (a missing property, a wrong argument, an unknown
 * option) and ignores the ones a fragment produces by being a fragment. In
 * every sample, `device` is a `Device` unless the sample declares it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { marked, type Token } from 'marked';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Device, ElementHandle, WebViewHandle } from '../index.js';

// ─── Extraction ───

const REPO = path.resolve(import.meta.dirname, '../../../..');
const SDK_ENTRY = path.resolve(import.meta.dirname, '../index.ts');

const SOURCES = ['docs/**/*.md', '*.md', 'packages/*/README.md'];
const TS_LANGS = new Set(['typescript', 'ts', 'tsx']);

interface Sample {
  file: string;
  /** 1-based line of the sample's first code line in `file`. */
  line: number;
  code: string;
  tsx: boolean;
}

/** A token's children: list items, inline tokens, and table cells (`header[]` / `rows[][]`). */
function childTokens(token: Token): Token[] {
  const t = token as { tokens?: Token[]; items?: Token[]; header?: Array<{ tokens: Token[] }>; rows?: Array<Array<{ tokens: Token[] }>> };
  return [
    ...(t.items ?? []),
    ...(t.tokens ?? []),
    ...(t.header ?? []).flatMap((cell) => cell.tokens),
    ...(t.rows ?? []).flatMap((row) => row.flatMap((cell) => cell.tokens)),
  ];
}

/** Inline code spans of a markdown file (prose like "use `getByDescription()`"), with their lines. */
function codeSpansIn(file: string, source: string): Sample[] {
  const out: Sample[] = [];
  let searchFrom = 0;
  const visit = (token: Token): void => {
    if (token.type === 'codespan') {
      const at = source.indexOf(token.raw, searchFrom);
      if (at >= 0) searchFrom = at + token.raw.length;
      out.push({ file, line: at >= 0 ? source.slice(0, at).split('\n').length : 0, code: token.text as string, tsx: false });
    }
    for (const child of childTokens(token)) visit(child);
  };
  for (const token of marked.lexer(source)) visit(token);
  return out;
}

function samplesIn(file: string, source: string): Sample[] {
  const out: Sample[] = [];
  let searchFrom = 0;
  const visit = (token: Token): void => {
    if (token.type === 'code') {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0]!.toLowerCase();
      const at = source.indexOf(token.raw, searchFrom);
      if (at >= 0) searchFrom = at + token.raw.length;
      if (TS_LANGS.has(lang)) {
        // A fenced block's code starts on the line after its fence; a nested one
        // (in a list) is dedented in `raw`, so find its first code line instead.
        const first = (token.text as string).split('\n')[0]!;
        const found = at >= 0 ? at : source.indexOf(first);
        const line = found >= 0 ? source.slice(0, found).split('\n').length + (at >= 0 ? 1 : 0) : 0;
        out.push({ file, line, code: token.text as string, tsx: lang === 'tsx' });
      }
    }
    for (const child of childTokens(token)) visit(child);
  };
  for (const token of marked.lexer(source)) visit(token);
  return out;
}

function docFiles(): string[] {
  return glob.sync(SOURCES, { cwd: REPO, nodir: true, ignore: ['**/node_modules/**'] }).sort();
}

function collectSamples(): Sample[] {
  return docFiles().flatMap((rel) => samplesIn(rel, fs.readFileSync(path.join(REPO, rel), 'utf8')));
}

function collectCodeSpans(): Sample[] {
  return docFiles().flatMap((rel) => codeSpansIn(rel, fs.readFileSync(path.join(REPO, rel), 'utf8')));
}

// ─── Names in prose ───

/** Every member name an instance of `cls` has on its prototype chain (methods and getters). */
function membersOf(cls: { prototype: object }): Set<string> {
  const names = new Set<string>();
  for (let proto: object | null = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  }
  return names;
}

/**
 * Another tool's API, named in prose to compare with Tapsmith's. An entry
 * nothing matches fails the guard, so the list cannot rot.
 */
const NOT_TAPSMITH: Array<{ problem: string; files: string[]; reason: string }> = [
  { problem: 'device.disableSynchronization() is not a Device method', files: ['docs/migrating-from-detox.md'], reason: 'Detox API' },
  { problem: 'device.reloadReactNative() is not a Device method', files: ['docs/migrating-from-detox.md', 'docs/warm-reset.md'], reason: 'Detox API' },
  { problem: 'device.openURL() is not a Device method', files: ['docs/migrating-from-detox.md'], reason: 'Detox API, in the device-object mapping table' },
  { problem: 'device.sendToHome() is not a Device method', files: ['docs/migrating-from-detox.md'], reason: 'Detox API, in the device-object mapping table' },
  { problem: 'device.getPlatform() is not a Device method', files: ['docs/migrating-from-detox.md'], reason: 'Detox API, in the device-object mapping table' },
];

const DEVICE_MEMBERS = membersOf(Device);
const LOCATOR_FACTORIES = new Set([...DEVICE_MEMBERS, ...membersOf(ElementHandle), ...membersOf(WebViewHandle)]
  .filter((name) => name.startsWith('getBy')));

/**
 * Prose names API calls in inline code that no type-check sees:
 * "`getByText()`, `getByContentDesc()`, and more". Each `device.<name>(` must
 * be a `Device` member, and each `getBy<Name>(` a locator factory that exists.
 */
function unknownNamesIn(span: Sample): string[] {
  const problems: string[] = [];
  for (const m of span.code.matchAll(/(?<![\w$])device\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!DEVICE_MEMBERS.has(m[1]!)) problems.push(`device.${m[1]}() is not a Device method`);
  }
  for (const m of span.code.matchAll(/(?<![\w$])(?:[A-Za-z_$][\w$]*\.)?(getBy[A-Z][\w$]*)\s*\(/g)) {
    if (!LOCATOR_FACTORIES.has(m[1]!)) problems.push(`${m[1]}() is not a locator method`);
  }
  return problems;
}

// ─── Type-checking ───

/**
 * Diagnostics that mean the sample does not match the API. Everything else is
 * what a fragment produces by being one: undeclared names (2304, 2552),
 * unresolvable local imports (2307), a `const` repeated to show alternatives
 * (2451), elisions that do not parse (1xxx), implicit-any and the like.
 */
const API_MISMATCH = new Map<number, string>([
  [2339, 'property does not exist'],
  [2551, 'property does not exist (did you mean …)'],
  [2345, 'argument type is wrong'],
  [2353, 'unknown option'],
  [2554, 'wrong number of arguments'],
  [2555, 'too few arguments'],
  [2559, 'type has no properties in common'],
  [2561, 'unknown option (did you mean …)'],
  [2305, 'module has no such export'],
  [2724, 'module has no such export (did you mean …)'],
  [2614, 'module has no such export'],
  [2322, 'value is not assignable (a wrong option value)'],
  [2820, 'value is not assignable (did you mean …)'],
]);

/**
 * Runner globals a sample may use without importing them. Undeclared, each
 * would be untyped and hide every check behind it: the callback of an
 * undeclared `test` gets an untyped `{ device }`, and an undeclared `expect`
 * returns `any`. So the header imports each one the sample does not declare.
 */
const RUNNER_NAMES = ['test', 'describe', 'expect', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'defineConfig'];

/** Whether the sample binds `name` itself: an import, or a top-level-ish declaration. */
function bindsName(code: string, name: string): boolean {
  const imported = [...code.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}/g)]
    .some((m) => m[1]!.split(',').some((part) => part.trim().split(/\s+as\s+/).pop()!.trim() === name));
  return imported || new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(code);
}

/** The header every sample gets: its own imports stay, `device` is a `Device`, runner names are typed. */
function wrap(sample: Sample): { text: string; headerLines: number } {
  // A sample that declares its own top-level `device` collides with this one
  // (TS2451, ignored); fixture parameters (`async ({ device }) =>`) shadow it.
  const runnerNames = RUNNER_NAMES.filter((name) => !bindsName(sample.code, name));
  const header = [
    "import type { Device as __Device } from 'tapsmith';",
    runnerNames.length ? `import { ${runnerNames.join(', ')} } from 'tapsmith';` : '',
    'declare const device: __Device;',
    'export {};',
  ];
  return { text: `${header.join('\n')}\n${sample.code}\n`, headerLines: header.length };
}

/**
 * `expect(x).toBeVisible()` where `x` comes from a module the sample imports
 * but this check cannot resolve (`new LoginScreen(device)` from
 * `../screens/login.screen.js`): `x` is the error type, overload resolution
 * falls through to `expect(value: unknown): GenericAssertions`, and the
 * locator assertion "does not exist". That is the fragment, not the API.
 */
function fromUnresolvedValue(checker: ts.TypeChecker, sourceFile: ts.SourceFile, start: number): boolean {
  let node: ts.Node | undefined = findNode(sourceFile, start);
  while (node && !ts.isPropertyAccessExpression(node)) node = node.parent;
  if (!node) return false;
  // Through modifiers: `expect(x).not.toBeVisible()`, `expect.soft(x).…`.
  let receiver: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression;
  if (!ts.isCallExpression(receiver)) return false;
  const callee = receiver.expression;
  const isExpect = (ts.isIdentifier(callee) && callee.text === 'expect')
    || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'expect');
  if (!isExpect) return false;
  const arg = receiver.arguments[0];
  return arg !== undefined && (checker.getTypeAtLocation(arg).flags & ts.TypeFlags.Any) !== 0;
}

function findNode(node: ts.Node, pos: number): ts.Node | undefined {
  if (pos < node.getStart() || pos >= node.getEnd()) return undefined;
  for (const child of node.getChildren()) {
    const found = findNode(child, pos);
    if (found) return found;
  }
  return node;
}

interface Mismatch {
  sample: Sample;
  line: number;
  code: number;
  message: string;
}

function typeCheck(samples: Sample[]): Mismatch[] {
  const virtual = new Map<string, { sample: Sample; text: string; headerLines: number }>();
  samples.forEach((sample, i) => {
    const name = path.join(REPO, '.docs-snippets', `${i}${sample.tsx ? '.tsx' : '.ts'}`);
    virtual.set(name, { sample, ...wrap(sample) });
  });

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    jsx: ts.JsxEmit.ReactJSX,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    types: ['node'],
    typeRoots: [path.resolve(import.meta.dirname, '../../node_modules/@types')],
    paths: { tapsmith: [SDK_ENTRY] },
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const v = virtual.get(path.resolve(fileName));
    if (v) return ts.createSourceFile(fileName, v.text, languageVersion, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    return getSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => virtual.has(path.resolve(fileName)) || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => virtual.get(path.resolve(fileName))?.text ?? readFile(fileName);

  const program = ts.createProgram([...virtual.keys()], options, host);
  const checker = program.getTypeChecker();
  const mismatches: Mismatch[] = [];
  for (const [name, v] of virtual) {
    const sourceFile = program.getSourceFile(name)!;
    for (const d of program.getSemanticDiagnostics(sourceFile)) {
      if (!API_MISMATCH.has(d.code) || d.start === undefined) continue;
      if (fromUnresolvedValue(checker, sourceFile, d.start)) continue;
      // TSX samples are React Native components, checked without React's
      // types: their JSX props and children are not assignable to anything.
      if (v.sample.tsx && (d.code === 2322 || d.code === 2820)) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(d.start);
      mismatches.push({
        sample: v.sample,
        line: v.sample.line + line - v.headerLines,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]!,
      });
    }
  }
  return mismatches;
}

// ─── Tests ───

describe('docs TypeScript samples match the SDK API', () => {
  it('finds the samples', () => {
    // A broken extractor would make the guard pass vacuously.
    expect(collectSamples().length).toBeGreaterThan(300);
  });

  it('type-checks every sample against the public surface', () => {
    const problems = typeCheck(collectSamples()).map((m) => `${m.sample.file}:${m.line}  TS${m.code} (${API_MISMATCH.get(m.code)}): ${m.message}`);
    expect(problems, `Docs samples that don't match the API:\n${problems.join('\n')}`).toEqual([]);
  }, 120_000);

  it('names only API methods that exist in inline code', () => {
    const used = new Set<string>();
    const problems = collectCodeSpans().flatMap((span) => unknownNamesIn(span).flatMap((problem) => {
      const allowed = NOT_TAPSMITH.find((entry) => entry.problem === problem && entry.files.includes(span.file));
      if (allowed) {
        used.add(`${allowed.problem} @ ${span.file}`);
        return [];
      }
      return [`${span.file}:${span.line}  \`${span.code}\`: ${problem}`];
    }));
    expect(problems, `Docs prose naming API that doesn't exist:\n${problems.join('\n')}`).toEqual([]);
    const stale = NOT_TAPSMITH.flatMap((entry) => entry.files.map((file) => `${entry.problem} @ ${file}`)).filter((key) => !used.has(key));
    expect(stale, 'NOT_TAPSMITH entries no doc matches any more: remove them').toEqual([]);
  });

  it('reports an inline name that does not exist', () => {
    const spans = codeSpansIn('t.md', 'Locators: `getByText()`, `getByContentDesc()`, `device.webview()` and `device.frobnicate()`.\n');
    expect(spans.flatMap(unknownNamesIn)).toEqual(['getByContentDesc() is not a locator method', 'device.frobnicate() is not a Device method']);
  });

  it('reports a sample that calls a method Device does not have, at its line', () => {
    const md = '# T\n\n```typescript\nawait device.getByContentDesc("Close").tap()\n```\n';
    const samples = samplesIn('t.md', md);
    expect(samples).toHaveLength(1);
    const found = typeCheck(samples);
    expect(found.map((m) => [m.line, m.code])).toEqual([[4, 2339]]);
  }, 120_000);

  it('checks fixture parameters and assertions in samples that import nothing', () => {
    const md = [
      '```typescript',
      'test("x", async ({ device }) => {',
      '  await device.getByContentDesc("Close").tap()',
      '  await expect(device.getByText("Hi")).toBeFrobbed()',
      '})',
      '```',
    ].join('\n');
    expect(typeCheck(samplesIn('t.md', md)).map((m) => [m.line, m.code])).toEqual([[3, 2339], [4, 2339]]);
  }, 120_000);

  it('reports a wrong value for a real option', () => {
    const md = '```ts\ntest.use({ appResetScope: "tests" })\ntest.use({ appReset: "wipe" })\n```\n';
    expect(typeCheck(samplesIn('t.md', md)).map((m) => m.code)).toEqual([2820, 2322]);
  }, 120_000);

  it('reads inline code inside tables', () => {
    const spans = codeSpansIn('t.md', '| Detox | Tapsmith |\n|---|---|\n| `x` | `getByContentDesc()` |\n');
    expect(spans.flatMap(unknownNamesIn)).toEqual(['getByContentDesc() is not a locator method']);
  });

  it('reports options a method does not take', () => {
    const found = typeCheck(samplesIn('t.md', '```ts\nconst webview = await device.webview({ timeout: 60_000 })\n```\n'));
    expect(found.map((m) => m.code)).toEqual([2345]);
  }, 120_000);

  it('ignores what a fragment produces by being one', () => {
    const md = [
      '```typescript',
      'const webview = await device.webview()',
      'const webview = await device.webview("com.example.myapp")',
      'await loginScreen.login(user)',
      'test("x", async ({ device }) => { /* … */ })',
      'import { LoginScreen } from "../screens/login.screen.js"',
      'await expect(new LoginScreen(device).heading).toBeVisible()',
      'await expect(webview.locator(".spinner")).not.toBeVisible()',
      '```',
    ].join('\n');
    expect(typeCheck(samplesIn('t.md', md))).toEqual([]);
  }, 120_000);
});
