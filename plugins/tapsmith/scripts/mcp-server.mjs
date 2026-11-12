// Starts the project's own installed Tapsmith as the plugins' MCP server
// (`tapsmith mcp-server`), never a global or npx-cached copy, so the agent
// drives the Tapsmith version the project's tests run with.
//
// It asks for the server that works in the project's running UI-mode session
// and runs headless when there is none (`mcp-server --prefer-ui`), through
// TAPSMITH_MCP_PREFER_UI rather than the flag: a project on a Tapsmith from
// before that server ignores the variable and runs headless, where the flag
// would stop it. A value already set (`0`, to stay headless) is left alone.
//
// sync.mjs writes it, with `await main(<its arguments>)` appended, into the plugin as
// scripts/mcp-server.mjs (Claude Code's MCP config runs that file) and inline
// into Cursor's and Codex's as `node --input-type=module -e <this file> --`:
// Codex's plugin MCP config has no variable for the plugin's install
// directory to point at a file with. Keep it to `node:` imports for that
// reason, keep its comments on lines of their own (the inline copy drops
// them), and write no `${` (no template literals): Cursor substitutes
// `${NAME}` placeholders in a plugin's MCP config, which would rewrite the
// inline script.
//
// The project is TAPSMITH_PROJECT_DIR, else CLAUDE_PROJECT_DIR (Claude Code
// sets it for plugin MCP servers), else the first workspace folder in
// WORKSPACE_FOLDER_PATHS (Cursor sets it; Cursor's MCP servers have been seen
// to start outside the workspace), else the working directory (Codex starts
// servers in the session's directory). Tapsmith is resolved from there as
// Node resolves `import 'tapsmith'`; failing that, from the one folder below
// it that holds a Tapsmith config (a monorepo's e2e/ package, say).

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_NAMES = ['tapsmith.config.ts', 'tapsmith.config.js', 'tapsmith.config.mjs'];

/**
 * The first folder in Cursor's WORKSPACE_FOLDER_PATHS that exists. Its
 * separator for several folders is not documented, so the whole value is
 * tried first, then its parts split on commas and on the path list separator.
 */
function firstWorkspaceFolder(value) {
  if (!value) return undefined;
  const candidates = [value, ...value.split(new RegExp('[,' + path.delimiter + ']'))]
    .map((v) => v.trim())
    .filter(Boolean);
  return candidates.find((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The folder the agent is working in. */
function projectDir(env, cwd) {
  return path.resolve(
    env.TAPSMITH_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || firstWorkspaceFolder(env.WORKSPACE_FOLDER_PATHS) || cwd,
  );
}

/** The bin of the tapsmith package `dir` resolves, or undefined when it resolves none. */
function tapsmithBinFrom(dir) {
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

/**
 * `execArgv` without the inline launcher's own options (`--input-type`, and
 * `-e`/`--eval` or `-p`/`--print` with its script). Tapsmith forks its
 * children with the parent's execArgv, and Node refuses to start a file
 * under `--input-type`.
 */
function childExecArgv(execArgv) {
  const kept = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (['-e', '--eval', '-p', '--print', '--input-type'].includes(arg)) {
      i++;
      continue;
    }
    if (/^--(input-type|eval|print)=/.test(arg)) continue;
    kept.push(arg);
  }
  return kept;
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
function locateTapsmith(start) {
  if (!fs.existsSync(start)) {
    return {
      error:
        'The project folder ' + start + ' does not exist. Check TAPSMITH_PROJECT_DIR (or CLAUDE_PROJECT_DIR), ' +
        'or start the agent from the folder that holds your Tapsmith config.',
    };
  }
  const direct = tapsmithBinFrom(start);
  if (direct) return { dir: start, ...direct };
  const nested = nestedConfigDirs(start)
    .map((dir) => ({ dir, found: tapsmithBinFrom(dir) }))
    .filter((c) => c.found);
  if (nested.length === 1) return { dir: nested[0].dir, ...nested[0].found };
  if (nested.length > 1) {
    return {
      error:
        'Tapsmith is installed for several projects below ' + start + ' (' +
        nested.map((c) => path.relative(start, c.dir)).join(', ') + '). ' +
        'Start the agent from that project\'s folder, or set TAPSMITH_PROJECT_DIR to it in the environment you start ' +
        'the agent from (Codex passes no such variable on to MCP servers: start Codex from the folder instead).',
    };
  }
  return {
    error:
      'Tapsmith is not installed in ' + start + ": the plugin runs the project's own Tapsmith, not a global copy. " +
      'Install it in the project (npm install -D tapsmith) and restart the agent. If it is installed in another ' +
      'folder, start the agent from that folder, or set TAPSMITH_PROJECT_DIR to it in the environment you start the ' +
      'agent from (Codex passes no such variable on to MCP servers: start Codex from the folder instead).',
  };
}

/** Start the project's `tapsmith mcp-server`, passing on `extraArgs` (`--config <file>`). */
async function main(extraArgs) {
  const start = projectDir(process.env, process.cwd());
  const found = locateTapsmith(start);
  if (found.error) {
    // stdout carries the MCP protocol: everything else goes to stderr.
    process.stderr.write('tapsmith plugin: ' + found.error + '\n');
    process.exitCode = 1;
    return;
  }
  process.stderr.write('tapsmith plugin: starting tapsmith ' + found.version + ' mcp-server in ' + found.dir + '\n');
  process.chdir(found.dir);
  if (!process.env.TAPSMITH_MCP_PREFER_UI) process.env.TAPSMITH_MCP_PREFER_UI = '1';
  // In place: Node and Tapsmith read this array when they fork.
  process.execArgv.splice(0, process.execArgv.length, ...childExecArgv(process.execArgv));
  process.argv = [process.execPath, found.bin, 'mcp-server', ...extraArgs];
  await import(pathToFileURL(found.bin).href);
}

await main(process.argv.slice(2));
