/**
 * Cheap "has this build changed?" stamps (PILOT-1397).
 *
 * The install check that proves a device holds the configured build reads
 * both builds in full (an md5 of the APK on each side, a byte comparison of
 * the whole `.app`): half a second or more for a 100 MB release APK. A
 * long-lived session (UI mode, watch, MCP) checks before every run, so it
 * runs the full check only when something changed since the last one: the
 * build on disk (its file sizes and modification times) or the copy on the
 * device (its installed path, size and time). Both are read without reading
 * any content.
 *
 * A stamp is only ever used to skip a check that already passed for the very
 * same stamps. Any stamp that cannot be read is `undefined`, and the caller
 * runs the full check.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * A stamp of every entry under a directory: relative path, kind, size,
 * modification time, inode and change time, hashed, with the root's real
 * path. The inode and change time catch a rebuild whose tool normalises
 * mtimes (a reproducible archive extracted over the old build, a Nix store
 * path): writing a file always moves its ctime. Symlinks are not followed
 * (their targets are in the stamp); the root itself is, as `appBundlesMatch`
 * does.
 */
async function treeStamp(root: string): Promise<string> {
  const hash = createHash('sha1');
  hash.update(`root ${await fs.promises.realpath(root)}\n`);
  const pending = [''];
  while (pending.length > 0) {
    const relDir = pending.pop()!;
    const entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of entries) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const abs = path.join(root, rel);
      const st = await fs.promises.lstat(abs);
      if (dirent.isSymbolicLink()) {
        hash.update(`l ${rel} ${await fs.promises.readlink(abs)}\n`);
      } else if (dirent.isDirectory()) {
        hash.update(`d ${rel}\n`);
        pending.push(rel);
      } else {
        hash.update(`f ${rel} ${st.size} ${st.mtimeMs} ${st.ino} ${st.ctimeMs}\n`);
      }
    }
  }
  return hash.digest('hex');
}

/**
 * The stamp of a build on disk: an APK's size, modification time and inode
 * (a rebuild that writes a new file changes the inode even within one mtime
 * tick), or a `.app` bundle's whole tree. `undefined` when it cannot be read.
 */
export async function localBuildStamp(artifact: string): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(artifact);
    if (st.isDirectory()) return `tree:${await treeStamp(artifact)}`;
    return `file:${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return undefined;
  }
}

function run(file: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => resolve(err ? undefined : String(stdout)));
  });
}

/**
 * The stamp of the APK(s) installed for `packageName`: each file's path,
 * size and modification time, from one `adb shell`. Every install puts the
 * APK in a freshly named directory, so a reinstall changes the stamp even
 * when it installs the same bytes. `undefined` when the package is not
 * installed or the query fails.
 */
export async function installedApkStamp(serial: string, packageName: string): Promise<string | undefined> {
  // `pm path` lists the base APK and any splits; the package name is a Java
  // identifier, safe to pass through the device shell unquoted.
  if (!/^[A-Za-z0-9_.]+$/.test(packageName)) return undefined;
  const out = await run(
    'adb',
    ['-s', serial, 'shell', `stat -c '%n %s %Y' $(pm path ${packageName} | sed -n 's/^package://p')`],
    10_000,
  );
  const lines = out?.split('\n').map((l) => l.trim()).filter((l) => /^\/\S+ \d+ \d+$/.test(l)) ?? [];
  return lines.length > 0 ? `apk:${lines.join('|')}` : undefined;
}

/**
 * Where each simulator app was last found, by `udid` and bundle id. Asking
 * `simctl` costs most of a second, several on a busy host, so a session asks
 * once and reuses the answer while that bundle directory still exists. A
 * reinstall that writes the bundle elsewhere, or an uninstall, removes it,
 * and the next stamp asks again; one that writes it in place changes the
 * tree's stamp.
 */
const simulatorContainers = new Map<string, string>();

/**
 * The stamp of the `.app` installed on a simulator for `bundleId`: its
 * container path and whole tree. `simctl install` writes the bundle anew, so
 * a reinstall changes the stamp. `undefined` when it is not installed or the
 * lookup fails.
 */
export async function installedSimulatorAppStamp(
  udid: string,
  bundleId: string,
  /** Where an earlier process found it, used like this process's own memo. */
  knownContainer?: string,
): Promise<string | undefined> {
  const key = `${udid}\n${bundleId}`;
  let container = simulatorContainers.get(key) ?? knownContainer;
  if (container && !(await fs.promises.stat(container).then((st) => st.isDirectory(), () => false))) container = undefined;
  if (!container) {
    container = (await run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], 10_000))?.trim();
    if (!container) {
      simulatorContainers.delete(key);
      return undefined;
    }
    simulatorContainers.set(key, container);
  }
  try {
    return `app:${container}:${await treeStamp(container)}`;
  } catch {
    simulatorContainers.delete(key);
    return undefined;
  }
}
