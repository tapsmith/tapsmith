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
// servers in the session's directory). Tapsmith is found from there as
// Node finds a package (the nearest node_modules/tapsmith); failing that,
// from the one folder below it that holds a Tapsmith config (a monorepo's e2e/ package, say).
//
// When it finds none (the plugin was installed before Tapsmith, the natural
// order for an agent that installs Tapsmith itself), it still starts an MCP
// server rather than exiting: agents never see a server's stderr, and Claude
// Code does not retry a failed server for 15 minutes. That setup server says
// why there are no Tapsmith tools, in its instructions and in every tool
// call, and looks again every second and on every request. Once Tapsmith is
// installed it starts the project's `tapsmith mcp-server` as a child, hands
// it the client's initialize, tells the client its tools changed, and passes
// every message through from then on.

import { spawn } from 'node:child_process';
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

/**
 * The bin of the tapsmith package `dir` finds as Node finds a package (the
 * nearest node_modules/tapsmith in it or a folder above), or undefined when
 * there is none or it is not fully installed yet. Read from disk every time,
 * not through require.resolve: Node caches the package.json files it has
 * looked for, missing ones included, so a process that looked before an
 * install would never see it.
 */
function tapsmithBinFrom(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkgDir = path.join(d, 'node_modules', 'tapsmith');
    if (fs.existsSync(pkgDir)) {
      let pkg;
      let real;
      try {
        real = fs.realpathSync(pkgDir);
        pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
      } catch {
        return undefined;
      }
      if (pkg.name !== 'tapsmith') return undefined;
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tapsmith;
      if (!bin || !fs.existsSync(path.join(real, bin))) return undefined;
      return { bin: path.join(real, bin), version: pkg.version };
    }
    if (path.dirname(d) === d) return undefined;
  }
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
      'Install it in the project (npm install -D tapsmith): its tools load as soon as it is installed. If it is installed in another ' +
      'folder, start the agent from that folder, or set TAPSMITH_PROJECT_DIR to it in the environment you start the ' +
      'agent from (Codex passes no such variable on to MCP servers: start Codex from the folder instead).',
  };
}

/** The MCP protocol versions the setup server answers in, newest first. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The setup server's one tool, which also answers once Tapsmith is loaded. */
const SETUP_TOOL = 'tapsmith_setup_status';

/** How often the setup server looks for an install, in milliseconds. */
const SETUP_POLL_MS = 1000;

/**
 * How long the poll waits before starting a server again after one exited as
 * it started (an install still being written, say). A request tries at once.
 */
const SETUP_RETRY_MS = 5000;

/** The child's environment: TAPSMITH_MCP_PREFER_UI defaults to 1 (see the top of the file). */
function serverEnv(env) {
  return env.TAPSMITH_MCP_PREFER_UI ? env : { ...env, TAPSMITH_MCP_PREFER_UI: '1' };
}

/**
 * Serve MCP on stdio until Tapsmith is installed, then start the project's
 * `tapsmith mcp-server` as a child and pass messages through to it.
 */
function serveUntilInstalled(start, extraArgs, firstError) {
  let error = firstError;
  let child;
  let childReady = false;
  let initRequest;
  let protocolVersion = PROTOCOL_VERSIONS[1];
  let loadedVersion;
  let retryAt = 0;
  const queued = [];
  const pending = new Set();
  const replayId = 'tapsmith-plugin-initialize';

  const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const reason = () => 'Tapsmith is not loaded yet. ' + error;

  function toChild(message) {
    if (message.id !== undefined && message.method) pending.add(message.id);
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function startChild(found) {
    loadedVersion = found.version;
    process.stderr.write('tapsmith plugin: starting tapsmith ' + found.version + ' mcp-server in ' + found.dir + '\n');
    child = spawn(process.execPath, [...childExecArgv(process.execArgv), found.bin, 'mcp-server', ...extraArgs], {
      cwd: found.dir,
      env: serverEnv(process.env),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.stdin.on('error', () => {});
    // Decoded as a stream, so a character split across two reads stays whole.
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) fromChild(line);
      }
    });
    child.on('exit', (code, signal) => {
      const how = signal ? 'signal ' + signal : 'code ' + code;
      if (!childReady) {
        // It never started (an install still being written, say): serve as before and try again later.
        child = undefined;
        pending.clear();
        retryAt = Date.now() + SETUP_RETRY_MS;
        error = 'Tapsmith ' + found.version + ' is installed in ' + found.dir + ', but its MCP server exited with ' + how +
          ' as it started (its output is in the agent\'s MCP server log). It is started again on the next call.';
        process.stderr.write('tapsmith plugin: ' + error + '\n');
        for (const queuedMessage of queued.splice(0)) handle(queuedMessage);
        return;
      }
      // Calls the server never answered get an answer rather than hang.
      const why = "Tapsmith's MCP server exited with " + how + '.';
      for (const id of pending) fail(id, -32603, why);
      pending.clear();
      process.exitCode = code ?? 1;
      process.stdin.destroy();
      clearInterval(poll);
    });
    toChild({ jsonrpc: '2.0', id: replayId, method: 'initialize', params: { ...initRequest.params, protocolVersion } });
  }

  function fromChild(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(line + '\n');
      return;
    }
    if (message.id !== undefined && !message.method) pending.delete(message.id);
    if (message.id === replayId) {
      // The client already has the setup server's answer; the server's own is not passed on.
      childReady = true;
      toChild({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
      for (const queuedMessage of queued.splice(0)) handle(queuedMessage);
      return;
    }
    process.stdout.write(line + '\n');
  }

  /** Start the server if Tapsmith is installed now and the client has initialized. */
  function check(fromPoll) {
    if (child || !initRequest || (fromPoll && Date.now() < retryAt)) return;
    const found = locateTapsmith(start);
    if (found.error) {
      error = found.error;
      return;
    }
    startChild(found);
  }

  function handle(message) {
    const isRequest = message.id !== undefined && message.method;
    if (isRequest && message.method === 'tools/call' && message.params?.name === SETUP_TOOL && child) {
      if (!childReady) return queued.push(message);
      return reply(message.id, {
        content: [{
          type: 'text',
          text: 'Tapsmith ' + loadedVersion + ' is loaded, and its tapsmith_* tools are ready. If they are not in your tool list, ' +
            'reconnect the tapsmith MCP server (/mcp in Claude Code) or restart the agent.',
        }],
      });
    }
    if (child) {
      if (!childReady) return queued.push(message);
      return toChild(message);
    }
    if (!isRequest) return;
    switch (message.method) {
      case 'initialize': {
        initRequest = message;
        const asked = message.params?.protocolVersion;
        protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1];
        reply(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
          serverInfo: { name: 'tapsmith', version: '0.0.0-setup' },
          // Kept by the client for the whole session, so true after a switch too.
          instructions: 'When this session started, Tapsmith was not loaded: ' + error + ' Until it is, the only tool is ' +
            SETUP_TOOL + '. Once that is fixed the tapsmith_* tools load without a restart: if they are in your tool list, ' +
            'this no longer applies.',
        });
        return;
      }
      case 'ping':
        return reply(message.id, {});
      case 'tools/list':
        return reply(message.id, {
          tools: [{
            name: SETUP_TOOL,
            description: 'Why the Tapsmith tools are not available yet. ' + reason() +
              ' Call this again once that is fixed: the tapsmith_* tools then load without a restart.',
            inputSchema: { type: 'object', properties: {} },
          }],
        });
      case 'resources/list':
        return reply(message.id, { resources: [] });
      case 'resources/templates/list':
        return reply(message.id, { resourceTemplates: [] });
      case 'tools/call':
        return reply(message.id, { isError: true, content: [{ type: 'text', text: reason() }] });
      default:
        return fail(message.id, -32601, 'Method not found: ' + message.method);
    }
  }

  function receive(message) {
    // Every request looks again first, so a call right after an install reaches Tapsmith.
    if (message.method && message.method !== 'initialize') check(false);
    handle(message);
  }

  const poll = setInterval(() => check(true), SETUP_POLL_MS);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    input += data;
    let nl;
    while ((nl = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, nl);
      input = input.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Parse error');
        continue;
      }
      receive(message);
    }
  });
  process.stdin.on('end', () => {
    clearInterval(poll);
    if (child) child.stdin.end();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      clearInterval(poll);
      if (child && child.exitCode === null) child.kill(signal);
      else process.exit(0);
    });
  }
}

/** Start the project's `tapsmith mcp-server`, passing on `extraArgs` (`--config <file>`). */
async function main(extraArgs) {
  const start = projectDir(process.env, process.cwd());
  const found = locateTapsmith(start);
  if (found.error) {
    // stdout carries the MCP protocol: everything else goes to stderr.
    process.stderr.write('tapsmith plugin: ' + found.error + '\n');
    serveUntilInstalled(start, extraArgs, found.error);
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
