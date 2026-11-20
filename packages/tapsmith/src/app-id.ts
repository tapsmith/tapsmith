/**
 * The characters an app id may hold on each platform, as the daemon checks
 * them before any app RPC (`validate_app_id` in tapsmith-core's
 * grpc_server.rs) — the two must stay in step. `doctor` and `init` use this
 * to flag an id every launch would refuse, before a run gets that far.
 *
 * - Android package names: letters, digits, dots and underscores.
 * - iOS bundle ids: letters, digits, dots and hyphens (Apple's rule, so
 *   Expo's default `com.anonymous.my-app` works), and underscores, which
 *   the daemon also accepts.
 *
 * Neither may start with a hyphen.
 */

export type AppIdPlatform = 'android' | 'ios';

const ANDROID_ID = /^[A-Za-z0-9._]+$/;
const IOS_ID = /^[A-Za-z0-9._-]+$/;

/** Why `id` cannot name an app on `platform`, or undefined when it can. */
export function appIdProblem(id: string, platform: AppIdPlatform): string | undefined {
  if (platform === 'android') {
    if (ANDROID_ID.test(id)) return undefined;
    return `${JSON.stringify(id)} is not a valid Android package name: it may contain only letters, digits, dots and underscores`;
  }
  if (IOS_ID.test(id) && !id.startsWith('-')) return undefined;
  return `${JSON.stringify(id)} is not a valid iOS bundle identifier: it may contain only letters, digits, dots, hyphens and underscores, and must not start with a hyphen`;
}

/**
 * `init`'s warning for an id the daemon would refuse, or undefined for a
 * valid one: the config is still written, so the user can fix it there.
 */
export function appIdWarning(id: string, platform: AppIdPlatform): string | undefined {
  const problem = appIdProblem(id, platform);
  return problem && `${problem}, so Tapsmith cannot launch the app until package is set to the id the app is built with`;
}
