import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

function projectHash(): string {
  return crypto
    .createHash('sha256')
    .update(process.cwd())
    .digest('hex')
    .slice(0, 8);
}

const UI_PORT_PREFIX = 'ui-port-';

/**
 * Where a UI server publishes its MCP port.
 *
 * Beside the daemon registry, and for the same reason: `os.tmpdir()` reads
 * `TMPDIR`, which an MCP client may drop when it spawns its server (the
 * reference stdio transport passes a small allow-list). A client-launched
 * headless server and a shell-launched UI server would then disagree about
 * this path — and the headless one uses it to find out which daemons the UI
 * session owns, so disagreeing means claiming a daemon mid-run.
 */
export function uiPortFilePath(): string {
  return path.join(daemonStateDir(), `${UI_PORT_PREFIX}${projectHash()}`);
}

/**
 * Make sure the state directory exists before something writes into it.
 *
 * Nothing else creates it in UI mode: the registry's `mkdir` lives behind the
 * writes a UI server deliberately never makes. On a fresh machine the port
 * file write then failed with ENOENT into a `catch` that swallows it, no UI
 * server was discoverable, and headless sessions went back to claiming the
 * daemon it was driving — the bug this file's location exists to prevent,
 * reappearing on exactly the installs that never saw it work.
 */
export function ensureDaemonStateDir(): void {
  try {
    fs.mkdirSync(daemonStateDir(), { recursive: true, mode: 0o700 });
  } catch {
    // Best effort: the caller's own write reports the real problem.
  }
}

/**
 * Every UI server's port file, not just this project's.
 *
 * Two project directories share the default daemon address, so a UI session in
 * one can own the daemon a headless session in the other is about to adopt.
 * The question "is this daemon someone's UI run?" is machine-wide.
 */
export function allUiPortFiles(): string[] {
  try {
    const dir = daemonStateDir();
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(UI_PORT_PREFIX))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Registry of daemons started by headless MCP sessions in this project.
 *
 * A session that starts its own daemon picks a free port, so nothing else can
 * find it: the next session probes the default address, misses, and starts
 * another daemon against the same device. Recording the address here lets
 * sessions reuse a running daemon the way they already reuse one on the
 * default port.
 */
export function mcpDaemonRegistryPath(): string {
  // Under the home directory, not the temp dir, because `os.tmpdir()` reads
  // `TMPDIR` — and an MCP server is spawned by its client, which may sanitize
  // the environment (the reference stdio transport passes only a small
  // allow-list, dropping `TMPDIR`). The path would then differ between a
  // client-launched session and a shell-launched one, so two sessions in the
  // same project would keep separate registries and each start its own daemon:
  // exactly the pile-up this file exists to prevent.
  //
  // Its own subdirectory, so the permission tightening in `privateRegistryFile`
  // applies here and never to a `~/.tapsmith` the user shares with other tools.
  return path.join(daemonStateDir(), `mcp-daemons-${projectHash()}.json`);
}

/**
 * Where daemons started by this project's headless MCP sessions write their
 * output (unless `TAPSMITH_DAEMON_LOG` names another file).
 *
 * A file, not the server's stderr: the daemon is started `--outlive-parent`
 * so another session can adopt it, and a pipe to a server that has exited is
 * one nobody reads.
 */
export function mcpDaemonLogPath(): string {
  return path.join(daemonStateDir(), `mcp-daemon-${projectHash()}.log`);
}

function daemonStateDir(): string {
  const home = os.homedir();
  if (home) return path.join(home, '.tapsmith', 'daemons');
  // No home directory to speak of: fall back to a per-user temp directory. The
  // name is derived only from the project path, so on a multi-user host anyone
  // could otherwise plant a file and hand the session a daemon address of their
  // choosing — which is why the writer verifies the directory before trusting
  // it (see `privateRegistryFile`).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `tapsmith-${uid}`);
}

export function mcpActivityFilePath(): string {
  if (process.env.TAPSMITH_MCP_ACTIVITY_FILE) {
    return path.resolve(process.env.TAPSMITH_MCP_ACTIVITY_FILE);
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    return path.join(os.tmpdir(), `tapsmith-mcp-activity-${uid}.ndjson`);
  }
  return path.join(os.homedir() || os.tmpdir(), '.tapsmith', 'mcp-activity.ndjson');
}
