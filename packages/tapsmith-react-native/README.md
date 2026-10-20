# @tapsmith/react-native

In-app reset hooks for [Tapsmith](https://tapsmith.dev). One line in your app's root turns Tapsmith's between-test app reset from a cold relaunch (7–13 s on an iOS simulator) into an acknowledged in-process reset (well under a second). Resets still happen once per test file by default; because they are now cheap, a file that needs a fresh app before **every test** can opt in with `test.use({ appResetScope: 'test' })`.

```tsx
// app/_layout.tsx (Expo Router) — or your root component
import * as Linking from 'expo-linking';
import { Stack } from 'expo-router';
import { TapsmithTestHooks } from '@tapsmith/react-native';

export default function RootLayout() {
  return (
    <>
      <Stack />
      <TapsmithTestHooks
        urlPrefix={Linking.createURL('/')}
        enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === '1'}
      />
    </>
  );
}
```

- `clear` — stores to wipe on every reset (anything with `clear()` or `clearAll()`, e.g. `[AsyncStorage]` from `@react-native-async-storage/async-storage`, which the stock Expo template does not include, or an MMKV instance).
- `onReset` — your own reset (sign out, drop in-memory state, reset navigation).
- `urlPrefix` / `scheme` — how Tapsmith should build reset links into your app. Expo: `Linking.createURL('/')`; bare React Native: `scheme="myapp"`.
- `enabled` — whether the hooks are on. Pass it from your app's own code as shown: `__DEV__` covers dev builds, and `EXPO_PUBLIC_TAPSMITH_HOOKS=1` at build time covers Release builds made for e2e. The check has to be in your app, because Expo inlines `EXPO_PUBLIC_*` variables only in app code, never inside `node_modules`. When off, the component renders nothing.

Tapsmith detects the hooks automatically — no config changes. See the [Warm app reset guide](https://tapsmith.dev/guides/warm-reset/).

Never enable the hooks in a production build: a reset link can clear local storage and navigate the app.
