/**
 * Whether a run's test files use the network APIs that need Tapsmith's
 * network proxy — `route()`, `waitForRequest()`, `waitForResponse()` and
 * `on('request' | 'response')`.
 *
 * The runner starts the proxy on demand at a test's first such call,
 * but by then the app may hold keep-alive connections, opened
 * straight to the server by an earlier test or the startup launch, that
 * bypass it. A run that uses these APIs anywhere therefore starts the proxy
 * when its device session starts, before the app launches; a run that
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
 * Loads the files esbuild has no loader for (images, styles, fonts…) as
 * empty: they hold no test code, and a loader error would end the scan.
 * Decided on the resolved path, not the specifier — `./login.page` is a
 * TypeScript module once resolved, not a `.page` asset.
 */
const emptyAssets: Plugin = {
  name: 'tapsmith-empty-assets',
  setup(b) {
    b.onLoad({ filter: /.*/ }, (args) => {
      if (CODE_EXTENSIONS.has(path.extname(args.path))) return undefined;
      return { contents: '', loader: 'js' };
    });
  },
};

/** The local modules `entries` load, themselves included; throws when esbuild cannot resolve them. */
async function localModules(entries: string[]): Promise<string[]> {
  // Inputs come back relative to the working directory the build ran in.
  const cwd = process.cwd();
  const result = await build({
    absWorkingDir: cwd,
    entryPoints: entries,
    bundle: true,
    write: false,
    metafile: true,
    outdir: 'tapsmith-network-api-scan',
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
    plugins: [emptyAssets],
  });
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

/** A string literal's value, or a template literal's with no `${}` in it. */
function stringValue(node: Node & Record<string, unknown>): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
    const cooked = (node.quasis as Array<{ value: { cooked?: string | null } }>)[0]?.value.cooked;
    return cooked ?? undefined;
  }
  return undefined;
}

function propertyName(member: Node & { computed?: boolean; property?: Node & Record<string, unknown> }): string | undefined {
  const prop = member.property;
  if (!prop) return undefined;
  if (!member.computed && prop.type === 'Identifier') return prop.name as string;
  if (member.computed) return stringValue(prop);
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
        const first = (n.arguments as Array<Node & Record<string, unknown>>)[0];
        const event = first ? stringValue(first) : undefined;
        if (event && NETWORK_EVENTS.has(event)) return true;
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

/** What a scan found, and every local module it read. */
interface NetworkApiScan {
  uses: boolean
  modules: string[]
  /**
   * Some file's imports could not be resolved, so the modules it would load
   * (a helper not written yet) were not read: the answer can change without
   * any module it read changing.
   */
  incomplete: boolean
}

async function scanNetworkApis(files: readonly string[]): Promise<NetworkApiScan> {
  if (files.length === 0) return { uses: false, modules: [], incomplete: false };
  try {
    let modules: string[];
    let incomplete = false;
    try {
      modules = await localModules([...files]);
    } catch {
      // One file esbuild cannot resolve fails the whole build: scan the files
      // one by one, so the others still count, and a file that still fails
      // is read on its own, without the imports it could not resolve.
      const perFile = await Promise.all(files.map((f) => localModules([f]).catch(() => {
        incomplete = true;
        return [path.resolve(f)];
      })));
      modules = perFile.flat();
    }
    const unique = [...new Set(modules)];
    const results = await Promise.all(unique.map(moduleUsesNetworkApis));
    return { uses: results.some(Boolean), modules: unique, incomplete };
  } catch {
    // Only decides when the proxy starts: it still starts on demand.
    return { uses: false, modules: [], incomplete: true };
  }
}

/**
 * Whether any of `files`, or a local module one of them imports, calls a
 * network API. Never throws: a file that cannot be read counts as not using
 * them (its own load error is reported when it runs), and one whose imports
 * cannot be resolved is read on its own.
 */
export async function testFilesUseNetworkApis(files: readonly string[]): Promise<boolean> {
  return (await scanNetworkApis(files)).uses;
}

function modificationTime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * {@link testFilesUseNetworkApis} for a session that outlives its files —
 * watch mode, UI mode, the MCP server — where the user edits tests between
 * runs. Each call answers for the files as they are now, scanning again only
 * when the file list changed, a module the last scan read (a test file, a
 * helper, a fixture) was modified since, or the last scan could not resolve
 * an import; otherwise it costs a stat per module.
 */
export function createNetworkApiScanner(): (files: readonly string[]) => Promise<boolean> {
  let last: {
    files: string; stamps: Array<[string, number]>; scan: Promise<NetworkApiScan>; incomplete: boolean
  } | undefined;
  return async (files) => {
    const key = JSON.stringify([...files].sort());
    const fresh = last && last.files === key && !last.incomplete
      && last.stamps.every(([module, mtime]) => modificationTime(module) === mtime);
    if (!fresh) {
      // Stamped before the scan reads them, so an edit made during the scan
      // is seen by the next call.
      const stampsBefore = new Map(files.map((f) => [f, modificationTime(f)] as const));
      const scan = scanNetworkApis(files);
      const entry = { files: key, stamps: [...stampsBefore], scan, incomplete: false };
      last = entry;
      const { modules, incomplete } = await scan;
      entry.incomplete = incomplete;
      // Only if no later call replaced this entry meanwhile.
      // The files themselves always count, even one the scan could not read.
      if (last === entry) {
        const read = new Set([...files, ...modules]);
        entry.stamps = [...read].map((m) => [m, stampsBefore.get(m) ?? modificationTime(m)] as [string, number]);
      }
    }
    return (await last!.scan).uses;
  };
}
