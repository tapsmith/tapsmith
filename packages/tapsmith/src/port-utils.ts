/**
 * TCP port utilities shared by the CLI and the parallel dispatcher.
 *
 * Lives in its own module to avoid pulling cli.ts (and its heavy import
 * graph) into dispatcher.ts.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import * as net from 'node:net';

/**
 * Pick a free ephemeral TCP port by binding `0` on loopback, reading the
 * assigned port, then closing the server. Avoids the collision window that
 * random-in-a-range schemes have when multiple CLI invocations race.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('Failed to acquire ephemeral port'));
      }
    });
  });
}

/**
 * Whether every address `host:port` resolves to refuses a TCP connection:
 * nothing listens there, so there is no daemon to wait for. A gRPC readiness
 * wait cannot say that — it retries until its deadline, a full second spent
 * on every start without a daemon.
 *
 * Only a refusal from every address counts: `localhost` can resolve to `::1`
 * before `127.0.0.1`, and the daemon listens on `127.0.0.1` alone. Anything
 * else — a connection, no answer within `timeoutMs`, an address that does not
 * resolve within it, a port out of range — is `false`, and the caller asks
 * gRPC as before.
 */
export async function connectionRefused(address: string, timeoutMs = 500): Promise<boolean> {
  const colon = address.lastIndexOf(':');
  const port = Number(address.slice(colon + 1));
  const host = address.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
  if (colon <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return false;
  let addresses: string[];
  let lookupTimer: NodeJS.Timeout | undefined;
  try {
    // A slow resolver must not cost more than the gRPC wait it replaces.
    const resolved = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        lookupTimer = setTimeout(() => reject(new Error('lookup timed out')), timeoutMs);
      }),
    ]);
    addresses = resolved.map((a) => a.address);
  } catch {
    return false;
  } finally {
    clearTimeout(lookupTimer);
  }
  if (addresses.length === 0) return false;
  const refused = await Promise.all(addresses.map((ip) => new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (result: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(false));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'ECONNREFUSED'));
  })));
  return refused.every(Boolean);
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Find PIDs listening on a TCP port. Works on macOS (lsof) and Linux (fuser). */
export function findPidsOnPort(port: string | number): number[] {
  try {
    if (process.platform === 'darwin') {
      // -sTCP:LISTEN restricts matches to the listening socket. Without it,
      // lsof also returns processes with *established* connections to the
      // port — including the caller's own gRPC probe socket, so the
      // stale-daemon kill loops in cli.ts/dispatcher.ts SIGTERMed the CLI
      // itself (silent exit 143 during startup).
      return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n))
        .filter(pid => pid !== process.pid);
    }
    // Linux: ss (iproute2) with -l restricts matches to listening sockets.
    // fuser was used previously, but it read the wrong stream (PIDs go to
    // stdout, not stderr — so it never found anything) and, like lsof
    // without -sTCP:LISTEN, it matches both ends of established
    // connections. -H drops the header; -p appends
    // users:(("cmd",pid=N,fd=M)) per socket.
    const result = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf-8' });
    const pids = [...(result.stdout || '').matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    return [...new Set(pids)].filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Free a TCP host port we're about to use as an agent forward target by
 * killing any stale process listening on it. The common offender is a
 * leftover iOS `TapsmithAgent` (XCUITest socket server) from a previous iOS
 * run — its host-localhost socket squats on the port we want to use for
 * `adb forward`, silently shadowing the Android agent and routing every
 * subsequent command to the wrong device. The same issue can happen with
 * a leftover `tapsmith-core` daemon from a crashed previous run.
 *
 * We only kill processes whose command name matches a known stale-agent
 * pattern (`TapsmithAgen`, `tapsmith-core`, `xctest`) so we never touch
 * unrelated user processes.
 */
export function freeStaleAgentPort(
  port: number,
  onProgress?: (event: { port: number; pid: number; command: string }) => void,
): void {
  const pids = findPidsOnPort(port);
  if (pids.length === 0) return;

  const stalePatterns = /TapsmithAgen|tapsmith-core|xctest/;
  for (const pid of pids) {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
      if (!stalePatterns.test(cmd)) continue;
      if (onProgress) {
        onProgress({ port, pid, command: cmd });
      } else {
        process.stderr.write(`${DIM}Freeing agent port ${port} from stale ${cmd} (pid ${pid}).${RESET}\n`);
      }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    } catch {
      // ps failed (process gone) — nothing to do
    }
  }
}

/** The agent port a daemon started without `--agent-port` forwards to. */
export const DEFAULT_AGENT_PORT = 18700;

const DAEMON_PROGRAM = 'tapsmith-core';

/**
 * The pids of the `tapsmith-core` daemons in `ps -A -ww -o pid=,args=` output
 * whose agent port is `port` (`--agent-port`, else the default), leaving out
 * `excludePids`. The program may be a path, spaces and all; only its basename
 * has to be the daemon's.
 */
export function parseDaemonsOnAgentPort(ps: string, port: number, excludePids: ReadonlySet<number>): number[] {
  const pids: number[] = [];
  for (const raw of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    if (excludePids.has(pid)) continue;
    const command = match[2];
    let at = -1;
    for (let i = command.indexOf(DAEMON_PROGRAM); i !== -1; i = command.indexOf(DAEMON_PROGRAM, i + 1)) {
      const prefix = command.slice(0, i);
      const rest = command.slice(i + DAEMON_PROGRAM.length);
      if ((prefix === '' || (prefix.startsWith('/') && prefix.endsWith('/'))) && (rest === '' || rest.startsWith(' '))) {
        at = i;
        break;
      }
    }
    if (at === -1) continue;
    const args = command.slice(at + DAEMON_PROGRAM.length).trim().split(/\s+/);
    let agentPort = DEFAULT_AGENT_PORT;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--agent-port') agentPort = Number(args[++i]);
      else if (args[i].startsWith('--agent-port=')) agentPort = Number(args[i].slice('--agent-port='.length));
    }
    if (agentPort === port) pids.push(pid);
  }
  return pids;
}

/**
 * The running daemons whose agent port is `port` — other sessions' (a
 * sequential run on a custom `daemonAddress` uses the default agent port
 * too), so its `adb forward` and runner on that port are live, not stale.
 * Undefined when the processes cannot be read.
 */
export function daemonsOnAgentPort(port: number, excludePids: ReadonlySet<number>): number[] | undefined {
  try {
    const ps = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf-8', timeout: 5_000 });
    return parseDaemonsOnAgentPort(ps, port, new Set([...excludePids, process.pid]));
  } catch {
    return undefined;
  }
}
