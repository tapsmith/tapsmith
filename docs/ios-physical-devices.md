# iOS physical devices

Tapsmith supports running tests against real iPhones and iPads over USB. This page covers the basic setup — everything you need to run tests on a real device. If you also want HTTPS capture in your traces, head to [iOS physical device network capture](./ios-physical-device-network-tracing.md) after finishing this page. Decrypted bodies are available for clients that trust Tapsmith's CA; use passthrough for pinned or embedded-root hosts that do not.

Simulators are easier (nothing to sign, nothing to install). Use simulators for fast iteration and physical devices when you specifically need to validate hardware-dependent behavior (camera, NFC, biometrics, signed receipts, real carrier network, battery, etc.).

## Prerequisites

- macOS with Xcode 15 or later
- An Apple Developer account (free accounts work; note the 7-day profile expiry caveat below)
- `libimobiledevice` (`brew install libimobiledevice`)
- A physical iOS device paired with this Mac

Run the preflight — it verifies each of these and prints the exact command to fix anything missing:

```sh
tapsmith ios setup-device
```

## One-time setup

1. **Plug the device in** via USB.

2. **Trust the Mac from the device.** When the "Trust This Computer?" dialog appears on the phone, tap **Trust** and enter your passcode.

3. **Enable Developer Mode on the device.** Settings → Privacy & Security → Developer Mode → **On**. The device will reboot.

4. **Register the device with your Apple Developer team.** Open Xcode → Window → Devices and Simulators, wait for the device to appear, and click **Use for Development**. Xcode auto-creates the development provisioning profile. This is the one step that can't be automated from the command line — Xcode owns device registration.

5. **Verify with `tapsmith ios setup-device`.** Every row should be ✓ and your device should be listed as "ready for tapsmith test". If it says "not paired" or "Developer Mode off", go back through steps 1-4.

6. **Build the signed Tapsmith agent for your device.**

   ```sh
   tapsmith ios build-agent
   ```

   This auto-detects the Apple Developer team from Xcode's Accounts preferences, runs `xcodebuild build-for-testing` with automatic signing, and writes the resulting `.xctestrun` under `.build-device/` in the agent source directory: `ios-agent/.build-device/` in your checkout, or `~/.tapsmith/ios-agent/.build-device/` when Tapsmith is installed from npm. `tapsmith test` finds that build on its own, so you don't need to set `iosXctestrun`, and the command says so. (For a checkout build it also prints an absolute `iosXctestrun:` line, in case you want to pin it; it offers none for the npm build, which an upgrade replaces.) First run takes 60–120s; incremental rebuilds are <10s. If you have multiple teams, pass `--team-id XXXXXXXXXX` to skip the prompt.

   Rebuild when you upgrade Tapsmith, switch teams/devices, or your profile expires. With an npm install, upgrading Tapsmith makes the old build unusable: `tapsmith test` and `tapsmith ios setup-device` then say it was built by the previous version and ask you to run `tapsmith ios build-agent` again. **Free Apple Developer accounts expire provisioning profiles every 7 days** — Tapsmith will warn you when you're within three days of expiry.

7. **Run your first test.** The first run installs the Tapsmith runner on the device and will fail with *"Developer App Certificate is not trusted"*. That's expected — it's the cue for the next step.

   ```sh
   tapsmith test --config <your-config>
   ```

8. **Trust the developer certificate on the device.** Settings → General → VPN & Device Management → **Apple Development: _Your Name_** → **Trust**. You only need to do this once per (device, Apple Developer team) pair. Paid accounts often skip this entirely — Xcode auto-trusts at registration time. Free accounts need to re-trust each time the 7-day profile rolls.

9. **Disable Auto-Lock while testing.** Settings → Display & Brightness → Auto-Lock → **Never**. XCUITest can't interact with a locked screen. Restore your usual setting after the session.

10. **Re-run `tapsmith test`.** From now on, installs and launches are automatic.

On every subsequent run, Tapsmith checks whether the dev cert is still trusted *before* launching the test suite. If trust has rolled (free account expiry, cert rotation), you get an immediate, actionable error with the Settings path — no more 60-second mid-test hangs.

## Running tests

Tapsmith auto-detects both the UDID and the xctestrun for physical devices, so a minimal config is just `platform: 'ios'` + `app` + `package`:

```ts
import { defineConfig } from 'tapsmith';

export default defineConfig({
  platform: 'ios',
  app: './build/MyApp-Device.app',   // device-signed build of your app
  package: 'com.example.myapp',
});
```

What Tapsmith fills in for you:

- **Device UDID** — when `device` is omitted, Tapsmith picks the single paired USB iOS device. Zero or more than one → actionable error.
- **`iosXctestrun`** — when omitted (and `TAPSMITH_IOS_XCTESTRUN` is unset), Tapsmith uses the newest `*iphoneos*.xctestrun` that `tapsmith ios build-agent` built. It looks first under `ios-agent/.build-device/Build/Products/` in the project directory or a parent of it (a Tapsmith checkout), then under `~/.tapsmith/ios-agent/.build-device/Build/Products/` (an npm install). It uses the npm build only if the installed Tapsmith version built it. If you set `iosXctestrun`, it is resolved against `rootDir` (by default the directory you run `tapsmith test` from). If the file it names does not exist, `tapsmith test` stops before starting the agent and names the path.

Both can be overridden:

```ts
export default defineConfig({
  platform: 'ios',
  app: './build/MyApp-Device.app',
  package: 'com.example.myapp',
  device: '00008140-00096C9014F3001C',
  iosXctestrun: 'ios-agent/.build-device/Build/Products/TapsmithAgentUITests_TapsmithAgentUITests_iphoneos26.4-arm64.xctestrun',
});
```

### Running simulator and device together

Use projects to target both from a single `tapsmith test` invocation:

```ts
export default defineConfig({
  projects: [
    {
      name: 'ios-sim',
      use: {
        platform: 'ios',
        simulator: 'iPhone 16',
        app: './build/MyApp.app',
        package: 'com.example.myapp',
      },
    },
    {
      name: 'ios-phys',
      use: {
        platform: 'ios',
        app: './build/MyApp-Device.app',
        package: 'com.example.myapp',
        // device + iosXctestrun auto-detected
      },
    },
  ],
});
```

```sh
tapsmith test                    # runs both projects
tapsmith test --project ios-phys # just the physical device
```

| Field | Simulator | Physical device |
|---|---|---|
| `simulator` | Name or UDID | — |
| `device` | — | Auto-detected (or UDID override) |
| `iosXctestrun` | Simulator-slice xctestrun | Auto-detected: `ios-agent/.build-device/` in a checkout, `~/.tapsmith/ios-agent/.build-device/` for npm |
| `app` | Simulator-slice `.app` | Device-signed `.app` |

## Want network capture too?

If you need HTTPS request/response bodies in your traces, set up [iOS physical device network capture](./ios-physical-device-network-tracing.md). It's a separate one-time step per device involving a mobileconfig profile and MITM CA trust. Clients that reject that CA need passthrough, which keeps traffic working without decrypted bodies.

## Want video recording?

Tapsmith records physical-device video via `ffmpeg`'s AVFoundation backend. Two prerequisites beyond the standard physical-device setup above:

1. **Install ffmpeg.** `brew install ffmpeg` is enough; the daemon checks `PATH` and surfaces an actionable error if it's missing.
2. **Pair and trust the device.** AVFoundation only sees iPhones that have been paired in Xcode and have accepted the "Trust This Computer" prompt — the same prompt you accepted during the one-time setup above.

Once both are in place, set `video: 'on'` (or any other mode — see [api-reference.md#video-recording](./api-reference.md#video-recording)) and run as usual. Recordings land in `<outputDir>/videos/`.

**Caveat — multi-device matching.** AVFoundation lists video devices by friendly name (e.g. "Sam's iPhone"), not UDID. When multiple iPhones are plugged in with similar names, the daemon's name-based match may pick the wrong one. The pragmatic workaround is to rename the device in iOS Settings → General → About → Name to something unique. A future Swift helper (CoreMediaIO) will let us match on UDID directly.

**ffmpeg CPU cost.** Roughly one CPU core for 30 fps 1080p `libx264 -preset ultrafast`. Disable video on machines that are already CPU-bound by other workers.

## Known limitations

Some simulator-only APIs don't work on physical devices and will return a clear `UNSUPPORTED_ON_PHYSICAL_DEVICE` error at test time:

- `device.clearAppData(...)` — physical devices don't expose their app container filesystem to the host. Use `--force-install` to reinstall the bundle instead.
- `device.setClipboard(...)` / `device.getClipboard(...)` — blocked by the iOS 16+ paste permission dialog. Seed/read the clipboard from within your app via a test-only debug hook.
- `device.openDeepLink(...)` — no `devicectl` equivalent of `simctl openurl`. Add a test-only button that calls `UIApplication.shared.open(url)`.
- `device.setColorScheme(...)` — simulator-only. Set light/dark mode manually.
- `device.grantPermission(...)` / `device.revokePermission(...)` — simulator-only. Let the XCUITest UIInterruptionMonitor tap through the in-app dialogs.
- `device.saveAppState(...)` / `device.restoreAppState(...)` — simulator-only. Use simulator-based setup projects for reusable auth state.

Other caveats:

- **Slow test resets.** Physical devices don't have the simctl fast-path for `restartApp`. Instead the agent does a full XCUITest relaunch (~8s per reset).
- **Only one test run per physical device at a time.** The dispatcher already assigns one device per worker.

## Troubleshooting

Run `tapsmith ios setup-device` first — it surfaces most setup issues with actionable fix instructions. Common failure modes:

**"No Account for Team 'XXXXXXXXXX'"** — Xcode doesn't have the Apple ID that owns that team signed in. Open Xcode → Settings → Accounts and sign in.

**"No profiles for 'dev.tapsmith.agent.xctrunner' were found"** — Your device isn't registered under the selected team. Open Xcode → Window → Devices and Simulators and wait for auto-registration.

**"Developer Mode off" in `tapsmith ios setup-device`** — Settings → Privacy & Security → Developer Mode → On, then confirm after the device restarts.

**"Unable to install TapsmithAgentUITests-Runner"** — the developer profile isn't trusted on the device. Settings → General → VPN & Device Management → trust it.

**"iproxy not found"** — `brew install libimobiledevice`.

**`Password:` prompt mid-test, right after "Starting iOS agent…"** — Xcode 26's CoreDevice calls `sudo -- /usr/bin/true` before mounting the Developer Disk Image. Tapsmith itself doesn't call sudo. Eliminate the prompt permanently by allowing that single binary without a password:

```sh
echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/true" | sudo tee /etc/sudoers.d/zz-tapsmith-xcode-ddi
sudo chmod 440 /etc/sudoers.d/zz-tapsmith-xcode-ddi
```

`/usr/bin/true` is a literal no-op (exit 0, no side effects), so scoping NOPASSWD to it is safe. The `zz-` prefix is important: sudoers uses last-match-wins rule resolution, so without it a user-specific file like `/etc/sudoers.d/<username>` can silently override the Tapsmith grant. `tapsmith ios setup-device` checks whether `sudo -n /usr/bin/true` succeeds. Run `sudo -k` first so a cached sudo password (from the `sudo tee` above) cannot make it pass; then an overriding file shows up as the passwordless-sudo check still failing after you add the rule.

**"not paired" in `tapsmith ios setup-device`** — Xcode → Window → Devices and Simulators → "Use for Development".

**A device shown as "not connected — ignored"** — this Mac remembers it (it was plugged in before, or is paired with another Mac), but it is not reachable now. It does not count toward the result, and `tapsmith list-devices` leaves it out. Plug it in if it is the device you want to test on.
