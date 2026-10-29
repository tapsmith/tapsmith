/**
 * Where the npm package keeps its copy of the iOS agent source, and which
 * Tapsmith version put it there. Shared by the writer (`resolveIosAgentDir`
 * in build-ios-agent.ts, which extracts the source and builds into it) and
 * the readers (device xctestrun lookup, `ios setup-device`), so the two can't
 * drift apart.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** `~/.tapsmith/ios-agent` — the agent source an npm install extracts and builds. */
export function npmIosAgentDir(): string {
  return path.join(os.homedir(), '.tapsmith', 'ios-agent');
}

/** Marker file recording the Tapsmith version that extracted {@link npmIosAgentDir}. */
export function npmIosAgentVersionFile(): string {
  return path.join(npmIosAgentDir(), '.tapsmith-version');
}

/** The Tapsmith version that extracted the npm agent source, or undefined without a marker. */
export function npmIosAgentVersion(): string | undefined {
  try {
    return fs.readFileSync(npmIosAgentVersionFile(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** This package's version (`0.0.0` when its package.json can't be read). */
export function tapsmithPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** `p` with the home directory shown as `~`, for messages. */
export function displayPath(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
