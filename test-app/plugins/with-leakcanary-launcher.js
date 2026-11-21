// Expo config plugin that gives the Android app a second MAIN/LAUNCHER entry,
// the one LeakCanary adds to debug builds: an <activity-alias> named
// leakcanary.internal.activity.LeakLauncherActivity (a "Leaks" launcher icon).
//
// With two launcher activities `cmd package resolve-activity` answers the
// system chooser instead of either, and `monkey -c LAUNCHER` may start either
// one. Tapsmith must still start the app's own MainActivity on every launch —
// the first, resets, restartApp() and recovery (PILOT-1402). The alias opens
// the native settings screen, so a wrong launch shows. Android only; must run
// after with-native-settings-screen, whose activity the alias targets.
const { withAndroidManifest } = require("expo/config-plugins")

const ALIAS = "leakcanary.internal.activity.LeakLauncherActivity"
const TARGET = ".NativeSettingsActivity"

module.exports = function withLeakCanaryLauncher(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0]
    if (!app) return mod
    const aliases = (app["activity-alias"] ?? []).filter((a) => a.$["android:name"] !== ALIAS)
    aliases.push({
      $: {
        "android:name": ALIAS,
        "android:targetActivity": TARGET,
        "android:exported": "true",
        "android:label": "Leaks",
      },
      "intent-filter": [
        {
          action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
          category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
        },
      ],
    })
    app["activity-alias"] = aliases
    return mod
  })
}
