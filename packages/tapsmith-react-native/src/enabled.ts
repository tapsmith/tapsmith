/**
 * Test hooks belong in test builds only. The fallback gate, used when the app
 * passes no `enabled` prop, is `__DEV__` (dev clients, Expo Go, `expo start`)
 * or `EXPO_PUBLIC_TAPSMITH_HOOKS=1` inlined at build time.
 *
 * The env read here only works where the bundler inlines it inside
 * node_modules: a `file:`-linked package, or a bare React Native Babel config
 * such as babel-plugin-transform-inline-environment-variables. Expo's Babel
 * preset never inlines `EXPO_PUBLIC_*` inside node_modules, so in an
 * npm-installed Expo app this stays `undefined` in a Release build. That is
 * why the docs have the app pass
 * `enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}` from
 * its own code, where Expo does inline it (PILOT-774).
 *
 * The access must stay the literal `process.env.EXPO_PUBLIC_TAPSMITH_HOOKS`
 * member expression: inliners match that shape, and a dynamic lookup is never
 * replaced.
 */
declare const __DEV__: boolean | undefined;
// React Native provides a minimal `process.env`; declared here so the package needs no Node types.
declare const process: { env?: Record<string, string | undefined> } | undefined;

export function hooksEnabledByDefault(): boolean {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === '1';
}
