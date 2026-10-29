/**
 * The Node.js floor, and what the CLI's entry does about the runtime before
 * loading anything else.
 *
 * This module is imported by `bin.ts` ahead of the CLI, on whatever Node the
 * user happens to run, so it must stay import-free and use nothing newer than
 * the oldest Node it is meant to turn away.
 */

/** The oldest Node.js major Tapsmith runs on. Matches `engines.node` in package.json. */
export const MIN_NODE_MAJOR = 22;

export function isSupportedNodeVersion(version: string): boolean {
  const major = parseInt(version.split('.')[0], 10);
  return major >= MIN_NODE_MAJOR;
}

function unsupportedNodeParts(version: string): { message: string; fix: string } {
  return {
    message: `You are running Node.js ${version}. Tapsmith requires Node.js ${MIN_NODE_MAJOR} or newer.`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org), then run the command again.`,
  };
}

/** What the CLI prints, before doing anything else, on an unsupported Node. */
export function unsupportedNodeMessage(version: string): string {
  const { message, fix } = unsupportedNodeParts(version);
  return `${message}\n${fix}`;
}

/**
 * The same refusal under `--json`: the documented error envelope, so a script
 * or agent reading stdout gets one JSON document (docs/api-reference.md, JSON output).
 */
export function unsupportedNodeJson(version: string): string {
  return JSON.stringify({ error: { code: 'UNSUPPORTED_NODE', ...unsupportedNodeParts(version) } }, null, 2) + '\n';
}

const DISABLE_TYPELESS_WARNING = '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON';

/**
 * Drop Node's MODULE_TYPELESS_PACKAGE_JSON warnings for this process and the
 * children it forks: the runtime equivalent of `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`,
 * which the bin cannot put in its shebang because Node before 20.11 rejects
 * the flag ("node: bad option") before the version check could explain why.
 * It fires when a user's typeless project has ES-module `.js` files (the
 * config, plain-JS tests) and advises adding `"type": "module"`, which can
 * break an Expo/React Native app. Every other warning passes through.
 *
 * This process gets a `process.emit` filter (the flag can no longer take
 * effect here); forked children get the flag itself, through
 * `process.execArgv`, which `fork()` passes on by default — as it passed on
 * the shebang's flag to the worker, UI-mode, watch and MCP children.
 */
export function ignoreTypelessPackageWarnings(): void {
  if (!process.execArgv.includes(DISABLE_TYPELESS_WARNING)) process.execArgv.push(DISABLE_TYPELESS_WARNING);
  const emit = process.emit as (event: string | symbol, ...args: unknown[]) => boolean;
  process.emit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'warning' && (args[0] as { code?: unknown } | undefined)?.code === 'MODULE_TYPELESS_PACKAGE_JSON') return false;
    return emit.call(this, event, ...args);
  } as typeof process.emit;
}
