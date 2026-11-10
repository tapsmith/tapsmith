// Starts the project's own installed Tapsmith as the plugins' MCP server
// (`tapsmith mcp-server`), never a global or npx-cached copy, so the agent
// drives the Tapsmith version the project's tests run with.
//
// sync.mjs writes it, with `await main(<its arguments>)` appended, into the plugin as
// scripts/mcp-server.mjs (Claude Code's MCP config runs that file) and inline
// into Cursor's and Codex's as `node --input-type=module -e <this file> --`:
// Codex's plugin MCP config has no variable for the plugin's install
// directory to point at a file with. Keep it to `node:` imports for that
// reason, and keep its comments on lines of their own (the inline copy drops
// them).
//
// The project is TAPSMITH_PROJECT_DIR, else CLAUDE_PROJECT_DIR (Claude Code
// sets it for plugin MCP servers), else the working directory (Codex and
// Cursor start servers in the workspace). Tapsmith is resolved from there as
// Node resolves `import 'tapsmith'`; failing that, from the one folder below
// it that holds a Tapsmith config (a monorepo's e2e/ package, say).

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_NAMES = ['tapsmith.config.ts', 'tapsmith.config.js', 'tapsmith.config.mjs'];

/** The folder the agent is working in. */
export function projectDir(env, cwd) {
  return path.resolve(env.TAPSMITH_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || cwd);
}

/** The bin of the tapsmith package `dir` resolves, or undefined when it resolves none. */
export function tapsmithBinFrom(dir) {
  let entry;
  try {
    entry = createRequire(path.join(dir, 'noop.js')).resolve('tapsmith');
  } catch {
    return undefined;
  }
  // From the package's entry up to its package.json, which names its bin.
  for (let d = path.dirname(entry); path.dirname(d) !== d; d = path.dirname(d)) {
    const manifest = path.join(d, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name !== 'tapsmith') return undefined;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tapsmith;
    return bin ? { bin: path.join(d, bin), version: pkg.version } : undefined;
  }
  return undefined;
}

/** Folders directly below `dir` that hold a Tapsmith config. */
function nestedConfigDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .filter((d) => CONFIG_NAMES.some((name) => fs.existsSync(path.join(d, name))))
    .sort();
}

/**
 * Where to run `tapsmith mcp-server` and with which bin, or an error that
 * says what to do.
 */
export function locateTapsmith(start) {
  const direct = tapsmithBinFrom(start);
  if (direct) return { dir: start, ...direct };
  const nested = nestedConfigDirs(start)
    .map((dir) => ({ dir, found: tapsmithBinFrom(dir) }))
    .filter((c) => c.found);
  if (nested.length === 1) return { dir: nested[0].dir, ...nested[0].found };
  if (nested.length > 1) {
    return {
      error:
        `Tapsmith is installed for several projects below ${start} (${nested.map((c) => path.relative(start, c.dir)).join(', ')}). ` +
        'Set TAPSMITH_PROJECT_DIR to the one the agent should use, in the environment you start the agent from.',
    };
  }
  return {
    error:
      `Tapsmith is not installed in ${start}: the plugin runs the project's own Tapsmith, not a global copy. ` +
      'Install it in the project (npm install -D tapsmith) and restart the agent, or set TAPSMITH_PROJECT_DIR ' +
      'to the folder whose node_modules has it.',
  };
}

/** Start the project's `tapsmith mcp-server`, passing on `extraArgs` (`--config <file>`). */
export async function main(extraArgs) {
  const start = projectDir(process.env, process.cwd());
  const found = locateTapsmith(start);
  if (found.error) {
    // stdout carries the MCP protocol: everything else goes to stderr.
    process.stderr.write(`tapsmith plugin: ${found.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`tapsmith plugin: starting tapsmith ${found.version} mcp-server in ${found.dir}\n`);
  process.chdir(found.dir);
  process.argv = [process.execPath, found.bin, 'mcp-server', ...extraArgs];
  await import(pathToFileURL(found.bin).href);
}
