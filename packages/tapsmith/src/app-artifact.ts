/**
 * The app build a run installs: the config's `apk` (Android) or `app` (iOS),
 * resolved against `rootDir`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithConfig } from './config.js';

/**
 * The resolved path of the app build the config installs, or `undefined`
 * when it configures none (the run then tests whatever is on the device).
 *
 * Throws when the configured path does not exist. A path to nothing — a typo,
 * a CI artifact step that failed, the wrong flavor directory — must stop the
 * run before the install check: otherwise an app already on the device
 * stands in for the missing build and the run passes against it.
 */
export function resolveAppArtifact(config: Pick<TapsmithConfig, 'platform' | 'apk' | 'app' | 'rootDir'>): string | undefined {
  const ios = config.platform === 'ios';
  const configured = ios ? config.app : config.apk;
  if (!configured) return undefined;
  const resolved = path.resolve(config.rootDir, configured);
  if (fs.existsSync(resolved)) return resolved;
  const key = ios ? 'app' : 'apk';
  const what = ios ? 'iOS app' : 'App APK';
  // The raw value too when it was relative: the resolved path alone hides
  // which rootDir it was resolved against.
  const from = path.isAbsolute(configured) ? `config \`${key}\`` : `config \`${key}\`: "${configured}", relative to ${config.rootDir}`;
  throw new Error(
    `${what} not found at ${resolved} (from ${from}). `
    + `Build the app, or fix \`${key}\` in your Tapsmith config.`,
  );
}
