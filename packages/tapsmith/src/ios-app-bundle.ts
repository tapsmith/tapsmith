/**
 * Reads what Tapsmith needs from a built iOS `.app` bundle's Info.plist.
 *
 * `plutil` (part of macOS itself, not Xcode) reads both the binary plists
 * Xcode writes and XML ones, one key at a time, so a key holding a `<date>`
 * or `<data>` elsewhere in the plist cannot break the read.
 */

import * as path from 'node:path';
import { tryExec } from './env-scan.js';

export interface IosAppInfo {
  /** `CFBundleIdentifier`, undefined when it could not be read. */
  bundleId?: string;
  /**
   * `CFBundleSupportedPlatforms`: `iPhoneSimulator` for a simulator build,
   * `iPhoneOS` for a device build. Undefined when the plist has none.
   */
  platforms?: string[];
}

/** `CFBundleIdentifier` of the `.app` at `appPath`, undefined when it cannot be read. */
export function readIosBundleId(appPath: string): string | undefined {
  // `raw`: plutil refuses to write a bare string as JSON.
  return tryExec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Info.plist')]) || undefined;
}

/** The array at `key`, undefined when there is none. */
function extractArray(plist: string, key: string): unknown {
  const out = tryExec('plutil', ['-extract', key, 'json', '-o', '-', plist]);
  if (out === undefined) return undefined;
  try {
    return JSON.parse(out) as unknown;
  } catch {
    return undefined;
  }
}

/** The bundle id and supported platforms of the `.app` at `appPath`. */
export function readIosAppInfo(appPath: string): IosAppInfo {
  const platforms = extractArray(path.join(appPath, 'Info.plist'), 'CFBundleSupportedPlatforms');
  return {
    bundleId: readIosBundleId(appPath),
    platforms: Array.isArray(platforms) && platforms.every((p) => typeof p === 'string') ? platforms : undefined,
  };
}
