/**
 * Whether a run's test files use the network APIs that need Tapsmith's
 * network proxy — `route()`, `waitForRequest()`, `waitForResponse()` and
 * `on('request' | 'response')` (PILOT-1013).
 *
 * The runner starts the proxy on demand at a test's first such call
 * (PILOT-775), but by then the app may hold keep-alive connections, opened
 * straight to the server by an earlier test or the startup launch, that
 * bypass it. A run that uses these APIs anywhere therefore starts the proxy
 * when its device session starts, before the app's first request; a run that
 * never uses them pays nothing.
 *
 * Static, since the session opens before any test runs: esbuild resolves each
 * test file's local import graph (helpers, fixtures, screen objects, tsconfig
 * `paths`), and every module in it is parsed and searched for those calls on
 * any object. Package imports are not followed. A call the scan cannot see (a
 * dynamic property name, a call inside a package) still starts the proxy on
 * demand, as before.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, type Node } from 'acorn';
import { build, transform, type Loader, type Plugin } from 'esbuild';

/** Methods that start network capture whatever their arguments. */
const NETWORK_METHODS = new Set(['route', 'waitForRequest', 'waitForResponse']);
/** `on()` events that start it. */
const NETWORK_EVENTS = new Set(['request', 'response']);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']);

/**
 * Leaves imports esbuild has no loader for (images, styles, fonts…)
 * unresolved: they hold no test code, and a loader error would end the scan.
 */
const externalAssets: Plugin = {
  name: 'tapsmith-external-assets',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const ext = path.extname(args.path);
      if (ext === '' || CODE_EXTENSIONS.has(ext)) return undefined;
      return { path: args.path, external: true };
    });
  },
};

/** The local modules `entries` load, themselves included; throws when esbuild cannot resolve them. */
async function localModules(entries: string[]): Promise<string[]> {
  const result = await build({
    entryPoints: entries,
    bundle: true,
    write: false,
    metafile: true,
    outdir: 'tapsmith-network-api-scan',
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
    plugins: [externalAssets],
  });
  const cwd = process.cwd();
  return Object.keys(result.metafile.inputs)
    // Inputs are relative to the working directory; namespaced ones (`ns:…`)
    // are esbuild's own.
    .filter((input) => !/^[a-z-]+:/.test(input))
    .map((input) => path.resolve(cwd, input));
}

function loaderFor(file: string): Loader | undefined {
  switch (path.extname(file)) {
    case '.ts': case '.mts': case '.cts': return 'ts';
    case '.tsx': return 'tsx';
    case '.jsx': return 'jsx';
    case '.js': case '.mjs': case '.cjs': return 'js';
    default: return undefined; // JSON and the rest hold no calls.
  }
}

function propertyName(member: Node & { computed?: boolean; property?: Node & { name?: string; value?: unknown } }): string | undefined {
  const prop = member.property;
  if (!prop) return undefined;
  if (!member.computed && prop.type === 'Identifier') return prop.name;
  if (member.computed && prop.type === 'Literal' && typeof prop.value === 'string') return prop.value;
  return undefined;
}

/** Whether `node` (an AST) contains a call that starts network capture. */
function containsNetworkCall(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsNetworkCall);
  const n = node as Node & Record<string, unknown>;
  if (n.type === 'CallExpression') {
    const callee = n.callee as Node & Record<string, unknown>;
    if (callee?.type === 'MemberExpression') {
      const name = propertyName(callee);
      if (name && NETWORK_METHODS.has(name)) return true;
      if (name === 'on') {
        const first = (n.arguments as Array<Node & { value?: unknown }>)[0];
        if (first?.type === 'Literal' && typeof first.value === 'string' && NETWORK_EVENTS.has(first.value)) return true;
      }
    }
  }
  for (const key of Object.keys(n)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = n[key];
    if (child && typeof child === 'object' && containsNetworkCall(child)) return true;
  }
  return false;
}

async function moduleUsesNetworkApis(file: string): Promise<boolean> {
  const loader = loaderFor(file);
  if (!loader) return false;
  try {
    const source = await fs.promises.readFile(file, 'utf8');
    const { code } = await transform(source, { loader, format: 'esm', logLevel: 'silent' });
    return containsNetworkCall(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
  } catch {
    return false;
  }
}

/**
 * Whether any of `files`, or a local module one of them imports, calls a
 * network API. Never throws: a file that cannot be read or resolved counts
 * as not using them (its own load error is reported when it runs).
 */
export async function testFilesUseNetworkApis(files: readonly string[]): Promise<boolean> {
  if (files.length === 0) return false;
  let modules: string[];
  try {
    modules = await localModules([...files]);
  } catch {
    // One file esbuild cannot resolve fails the whole build: scan the files
    // one by one, so the others still count.
    const perFile = await Promise.all(files.map((f) => localModules([f]).catch(() => [] as string[])));
    modules = perFile.flat();
  }
  const unique = [...new Set(modules)];
  const results = await Promise.all(unique.map(moduleUsesNetworkApis));
  return results.some(Boolean);
}
