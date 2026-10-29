/**
 * Read every test file's test names in a child process, for the check that a
 * `--grep` selects something before `tapsmith test` touches a device.
 * See selection-preflight-child.ts for why it is a child.
 */

import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveChildLoader } from './child-scripts.js';

export interface PreflightRequest {
  type: 'discover-names';
  files: string[];
}

export type PreflightResponse =
  /** Sent first: the process that imports the files (under tsx, a grandchild). */
  | { type: 'pid'; pid: number }
  | { type: 'names'; results: Array<{ file: string; names?: string[]; error?: string }> };

/** Long enough for a slow machine to import a large suite under tsx. */
const PREFLIGHT_TIMEOUT_MS = 60_000;

/**
 * Each file's test names, or `undefined` for a file that failed to load (and
 * for every file when the child itself failed or timed out): the run then goes
 * ahead and reports whatever is wrong itself.
 */
export function discoverTestNames(
  files: string[],
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<Map<string, string[] | undefined>> {
  // import.meta.dirname is src/ or dist/; the package root is one level up.
  const jsScript = path.resolve(import.meta.dirname, 'selection-preflight-child.js');
  const tsScript = path.resolve(import.meta.dirname, 'selection-preflight-child.ts');
  const script = !fs.existsSync(jsScript) && fs.existsSync(tsScript) ? tsScript : jsScript;
  const pkgDir = path.resolve(import.meta.dirname, '..');
  // From every file being checked, not this shard's: a shard of .js files
  // still has to import the suite's .ts files to answer the same way.
  const loader = resolveChildLoader([script], files, pkgDir);
  const unknown = new Map<string, string[] | undefined>(files.map((f) => [f, undefined]));

  return new Promise((resolve) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(script, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        // Not detached: it stays in the terminal's foreground process group,
        // so Ctrl-C reaches it — and, under tsx, the grandchild that imports
        // the files — even when the CLI itself dies by the signal, with no
        // 'exit' event to clean up from.
        ...(loader ? { execPath: loader } : {}),
        env: { ...process.env, NODE_PATH: path.resolve(pkgDir, '..') },
      });
    } catch {
      resolve(unknown);
      return;
    }
    // Under tsx the files are imported by a grandchild that tsx does not
    // pass SIGKILL to, so the importer reports its pid and is killed itself.
    let importerPid: number | undefined;
    const killTree = (): void => {
      for (const pid of [importerPid, child.pid]) {
        if (pid === undefined) continue;
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    };
    let settled = false;
    const settle = (result: Map<string, string[] | undefined>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('exit', killTree);
      resolve(result);
    };
    process.once('exit', killTree);
    const timer = setTimeout(() => {
      killTree();
      settle(unknown);
    }, timeoutMs);
    timer.unref?.();

    child.on('message', (msg: PreflightResponse) => {
      if (msg?.type === 'pid') importerPid = msg.pid;
      else if (msg?.type === 'names') settle(new Map(msg.results.map((r) => [r.file, r.names])));
    });
    child.on('error', () => settle(unknown));
    // 'disconnect', not 'exit': 'exit' can arrive before the names message has
    // been read, while every message is delivered before the channel closes.
    child.on('disconnect', () => settle(unknown));
    const request: PreflightRequest = { type: 'discover-names', files };
    child.send(request, (err) => { if (err) settle(unknown); });
  });
}
