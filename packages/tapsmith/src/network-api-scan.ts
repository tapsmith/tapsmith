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

const RESOLVING = Symbol('tapsmith-network-api-scan-resolving');

/**
 * Marks a relative or absolute import esbuild cannot resolve as external, so
 * one missing file (a helper not written yet, a lazy `import()` of a
 * generated path) does not fail the build and drop the rest of the graph.
 * Records the folder the missing file would be written into: writing it
 * changes that folder's modification time, which tells a session scanner to
 * scan again.
 */
function unresolvedAsExternal(missingFolders: Set<string>): Plugin {
  return {
    name: 'tapsmith-unresolved-external',
    setup(b) {
      b.onResolve({ filter: /^(\.\.?([\\/]|$)|[\\/])/ }, async (args) => {
        if (args.kind === 'entry-point' || args.pluginData === RESOLVING) return undefined;
        const resolved = await b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: RESOLVING,
        });
        if (resolved.errors.length === 0) return undefined; // esbuild resolves it as usual
        missingFolders.add(path.dirname(path.resolve(args.resolveDir, args.path)));
        return { path: args.path, external: true };
      });
    },
  };
}

/**
 * The local modules `entries` load, themselves included, and the folders of
 * the relative imports that could not be resolved. Throws when esbuild cannot
 * build them (a syntax error, a missing entry, an unresolvable alias).
 */
async function localModules(entries: string[]): Promise<{ modules: string[]; missingFolders: string[] }> {
  // Inputs come back relative to the working directory the build ran in.
  const cwd = process.cwd();
  const missingFolders = new Set<string>();
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
    plugins: [unresolvedAsExternal(missingFolders), emptyAssets],
  });
  const modules = Object.keys(result.metafile.inputs)
    // Inputs are relative to the working directory; namespaced ones (`ns:…`)
    // are esbuild's own.
    .filter((input) => !/^[a-z-]+:/.test(input))
    .map((input) => path.resolve(cwd, input));
  return { modules, missingFolders: [...missingFolders] };
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
  /** Folders a missing local import would be written into. */
  missingFolders: string[]
  /** The scan itself failed unexpectedly: its answer is not to be reused. */
  failed: boolean
}

async function scanNetworkApis(files: readonly string[]): Promise<NetworkApiScan> {
  if (files.length === 0) return { uses: false, modules: [], missingFolders: [], failed: false };
  try {
    let graph: { modules: string[]; missingFolders: string[] };
    try {
      graph = await localModules([...files]);
    } catch {
      // A file esbuild cannot build (a syntax error) fails the whole build:
      // build the files one by one, so the others still count, and read a
      // file that still fails on its own. Its edit is what changes the answer.
      const perFile = await Promise.all(files.map((f) => localModules([f]).catch(() => ({
        modules: [path.resolve(f)],
        missingFolders: [] as string[],
      }))));
      graph = {
        modules: perFile.flatMap((g) => g.modules),
        missingFolders: perFile.flatMap((g) => g.missingFolders),
      };
    }
    const unique = [...new Set(graph.modules)];
    const results = await Promise.all(unique.map(moduleUsesNetworkApis));
    return { uses: results.some(Boolean), modules: unique, missingFolders: [...new Set(graph.missingFolders)], failed: false };
  } catch {
    // Only decides when the proxy starts: it still starts on demand.
    return { uses: false, modules: [], missingFolders: [], failed: true };
  }
}

/**
 * Whether any of `files`, or a local module one of them imports, calls a
 * network API. Never throws: a file that cannot be read counts as not using
 * them (its own load error is reported when it runs), and an import that
 * cannot be resolved is skipped.
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
 * helper, a fixture) was modified since, or a missing import may have been
 * written (its folder changed); otherwise it costs a stat per module.
 */
export function createNetworkApiScanner(): (files: readonly string[]) => Promise<boolean> {
  let last: {
    files: string; stamps: Array<[string, number]>; scan: Promise<NetworkApiScan>; failed: boolean
  } | undefined;
  return async (files) => {
    const key = JSON.stringify([...files].sort());
    const fresh = last && last.files === key && !last.failed
      && last.stamps.every(([module, mtime]) => modificationTime(module) === mtime);
    if (!fresh) {
      // Stamped before the scan reads them, so an edit made during the scan
      // is seen by the next call.
      const stampsBefore = new Map(files.map((f) => [f, modificationTime(f)] as const));
      const scan = scanNetworkApis(files);
      const entry = { files: key, stamps: [...stampsBefore], scan, failed: false };
      last = entry;
      const { modules, missingFolders, failed } = await scan;
      entry.failed = failed;
      // Only if no later call replaced this entry meanwhile.
      // The files themselves always count, even one the scan could not read.
      if (last === entry) {
        const read = new Set([...files, ...modules, ...missingFolders]);
        entry.stamps = [...read].map((m) => [m, stampsBefore.get(m) ?? modificationTime(m)] as [string, number]);
      }
    }
    return (await last!.scan).uses;
  };
}
