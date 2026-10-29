/**
 * Whole-bundle "same build" check for an installed app (PILOT-913).
 *
 * An app bundle is a directory tree, and a rebuild can change any file in
 * it: since Xcode 15, a Debug build's main executable is a stub that never
 * changes and the app's code lives in `<App>.debug.dylib`; a React Native
 * build changes `main.jsbundle`; a version bump changes only `Info.plist`.
 * So the only sound "this is the build that is installed" test is that the
 * two trees hold the same entries with the same bytes. `simctl install`
 * copies a bundle byte for byte, so a bundle installed from this exact build
 * compares equal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** What a bundle path holds. Contents are compared separately, for files only. */
interface BundleEntry {
  kind: 'file' | 'dir' | 'symlink' | 'other'
  /** Byte size, for files. */
  size: number
  /** Link target, for symlinks (compared as text, never followed). */
  target?: string
}

const CHUNK_BYTES = 1024 * 1024;

/**
 * True when the two bundle directories hold the same tree: the same relative
 * paths, each the same kind of entry, files with identical bytes and symlinks
 * with identical targets. Symlinks inside the bundles are never followed (a
 * bundle's link can point anywhere); the two roots themselves are, so a
 * configured `app` path may be a link to a build. Directory modes, file
 * modes, timestamps and extended attributes are not compared: content is
 * what defines a build.
 *
 * Cheap differences (an added or removed file, a size change) are found
 * without reading any content, and content comparison stops at the first
 * differing chunk, so only a match reads both bundles in full.
 *
 * Any error (a missing or unreadable bundle, a root that is not a directory)
 * returns false: callers use a mismatch to reinstall, so a false negative
 * costs one redundant install, while a false positive would test stale code.
 */
export async function appBundlesMatch(installedDir: string, candidateDir: string): Promise<boolean> {
  try {
    const [installedRoot, candidateRoot] = await Promise.all([fs.promises.stat(installedDir), fs.promises.stat(candidateDir)]);
    if (!installedRoot.isDirectory() || !candidateRoot.isDirectory()) return false;
    const [installed, candidate] = await Promise.all([listBundle(installedDir), listBundle(candidateDir)]);
    if (installed.size !== candidate.size) return false;
    const files: string[] = [];
    for (const [rel, entry] of candidate) {
      const other = installed.get(rel);
      if (!other || other.kind !== entry.kind || other.size !== entry.size || other.target !== entry.target) return false;
      if (entry.kind === 'file' && entry.size > 0) files.push(rel);
    }
    const bufA = Buffer.allocUnsafe(CHUNK_BYTES);
    const bufB = Buffer.allocUnsafe(CHUNK_BYTES);
    for (const rel of files) {
      if (!(await sameFileBytes(path.join(installedDir, rel), path.join(candidateDir, rel), bufA, bufB))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Every entry under `root`, keyed by its `/`-separated path relative to `root`. */
async function listBundle(root: string): Promise<Map<string, BundleEntry>> {
  const entries = new Map<string, BundleEntry>();
  const pending = [''];
  while (pending.length > 0) {
    const relDir = pending.pop()!;
    for (const dirent of await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const abs = path.join(root, rel);
      if (dirent.isSymbolicLink()) {
        entries.set(rel, { kind: 'symlink', size: 0, target: await fs.promises.readlink(abs) });
      } else if (dirent.isDirectory()) {
        entries.set(rel, { kind: 'dir', size: 0 });
        pending.push(rel);
      } else if (dirent.isFile()) {
        entries.set(rel, { kind: 'file', size: (await fs.promises.lstat(abs)).size });
      } else {
        entries.set(rel, { kind: 'other', size: 0 });
      }
    }
  }
  return entries;
}

/** Byte-for-byte comparison of two files already known to be the same size. */
async function sameFileBytes(a: string, b: string, bufA: Buffer, bufB: Buffer): Promise<boolean> {
  const fa = await fs.promises.open(a, 'r');
  let fb: fs.promises.FileHandle;
  try {
    fb = await fs.promises.open(b, 'r');
  } catch (err) {
    await fa.close();
    throw err;
  }
  try {
    for (;;) {
      const [ra, rb] = await Promise.all([
        fa.read(bufA, 0, CHUNK_BYTES, null),
        fb.read(bufB, 0, CHUNK_BYTES, null),
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}
