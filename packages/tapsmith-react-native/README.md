# @tapsmith/react-native

In-app reset hooks for [Tapsmith](https://tapsmith.dev). One component around your app's root navigator turns Tapsmith's between-test app reset from a cold relaunch (7–13 s on an iOS simulator) into an acknowledged in-process reset (well under a second). Resets still happen once per test file by default; because they are now cheap, a file that needs a fresh app before **every test** can opt in with `test.use({ appResetScope: 'test' })`.

```tsx
// app/_layout.tsx or src/app/_layout.tsx (Expo Router) — or your root component
import * as Linking from 'expo-linking';
import { Stack } from 'expo-router';
import { TapsmithTestHooks } from '@tapsmith/react-native';

export default function RootLayout() {
  return (
    <TapsmithTestHooks
      urlPrefix={Linking.createURL('/')}
      enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === '1'}
    >
      <Stack />
    </TapsmithTestHooks>
  );
}
```

Wrap your root navigator (`<Stack />`, `<Tabs />`, or the default template's `<AppTabs />`): the hooks remount it after every reset, so no screen keeps React state from the previous test. Mounted beside the navigator instead, they remount nothing, and a screen that stays mounted — every visited tab of a tab navigator — keeps its state into the next test.

- `children` — your root navigator, remounted after every reset (rendered as-is when the hooks are disabled). Keep the navigation container above the hooks: expo-router's root layout already renders inside it; in a bare React Navigation app, put the hooks inside `<NavigationContainer>`, never around it.
- `clear` — stores to wipe on every reset (anything with `clear()` or `clearAll()`, e.g. `[AsyncStorage]` from `@react-native-async-storage/async-storage`, which the stock Expo template does not include, or an MMKV instance).
- `onReset` — your own reset (sign out, drop in-memory state). Navigation needs none: the hooks reset it on every reset, so each tab's own stack is back on its first screen (expo-router, or React Navigation with a `linking` config).
- `onReload` + `track` — keep a restored `appState` between tests: `track` lists the stores the app persists data in (counted writes), and `onReload` drops in-memory state and reads it back from storage. While a test writes nothing, the next test's reset runs `onReload` instead of restoring the archive and relaunching. Report writes the hooks cannot see with `markTapsmithWrite()`. See [Keeping restored app state between tests](https://tapsmith.dev/guides/warm-reset/#keeping-restored-app-state-between-tests).
- `urlPrefix` / `scheme` — how Tapsmith should build reset links into your app. Expo: `Linking.createURL('/')`; bare React Native: `scheme="myapp"`.
- `enabled` — whether the hooks are on. Pass it from your app's own code as shown: `__DEV__` covers dev builds, and `EXPO_PUBLIC_TAPSMITH_HOOKS=1` at build time covers Release builds made for e2e. The check has to be in your app, because Expo inlines `EXPO_PUBLIC_*` variables only in app code, never inside `node_modules`. When off, the component renders only its children.

Tapsmith detects the hooks automatically — no config changes. See the [Warm app reset guide](https://tapsmith.dev/guides/warm-reset/).

Never enable the hooks in a production build: a reset link can clear local storage and navigate the app.
