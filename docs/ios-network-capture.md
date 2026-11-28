# iOS network capture

Tapsmith can record the HTTP/HTTPS traffic the app under test makes during iOS tests, with request/response bodies, headers, timing, and per-test attribution in the trace viewer's Network tab when the app accepts Tapsmith's MITM CA. Clients that use embedded roots, certificate pinning, custom TLS verification, or unsupported transports may need `networkPassthroughHosts`; HTTP/2-capable clients that reject the generated certificate can be tunneled dynamically and appear as passthrough markers. Both **iOS simulators** and **physical iOS devices** are supported on macOS.

Simulators go through a macOS Network Extension (no on-device configuration needed — see [simulator setup](#first-run-setup) below). Physical devices use a Wi-Fi proxy configuration profile (a `.mobileconfig` that Tapsmith generates per device) — see the [physical device section](#physical-ios-devices) below.

## How it works

Tapsmith's daemon (`tapsmith-core`) runs a local MITM proxy for each worker. On Android the daemon redirects the device's traffic into it (see [How capture works](network.md#how-capture-works)). **On iOS**, it uses a different mechanism because simulators share the host's network stack:

- The daemon spawns **`Mitmproxy Redirector.app`**, a small signed launcher that ships with [mitmproxy](https://mitmproxy.org) and manages a macOS **Network Extension** (NE). The NE intercepts TCP flows from specific processes on the host and redirects them over a per-worker Unix socket into Tapsmith's MITM proxy.
- The daemon sends the NE an `InterceptConf` naming the simulator's processes: every app installed in it, matched by its executable's path inside that simulator's data directory (`…/<UDID>/data/…`), so an app is intercepted from its first connection after a launch; and the PIDs of the simulator's process tree (`launchd_sim` and descendants), re-read every two seconds, for the runtime's own processes such as a WebView's networking process. Each worker daemon only sees its own simulator's flows — **parallel iOS workers don't collide**, and the user's host browser traffic is never touched.
- The MITM proxy reads the real hostname from the client's TLS ClientHello SNI extension (not the resolved IP the NE reports), dials upstream with that hostname as SNI, mints a per-host certificate signed by the Tapsmith CA, and captures the decrypted request/response pair into the trace when the client trusts that CA. If an HTTP/2-capable client rejects the generated certificate, Tapsmith tunnels later connections for that host so the app keeps working.

The CA is installed into the simulator's trust store automatically via `xcrun simctl keychain add-root-cert` at the start of each capture session. That is enough for normal system-trust clients, but not for SDKs that bring their own root store or pin certificates.

## First-run setup

**Prerequisite:** macOS with [Homebrew](https://brew.sh).

The fastest path is to use Tapsmith's interactive setup command, which checks your environment, extracts the redirector automatically, and walks you through approving the macOS Network Extension:

```sh
brew install mitmproxy
npx tapsmith ios network setup-simulator
```

`tapsmith ios network setup-simulator` reports each step with a ✓ / ✗ status, opens System Settings directly to the correct pane if approval is still needed, and polls until the Network Extension flips to `[activated enabled]`. On a machine where the extension has registered (after a first simulator run with capture) you'll see:

1. `✓ mitmproxy is installed`
2. `⚠ Network Extension is registered but not yet approved`
3. Tapsmith opens **System Settings → General → Login Items & Extensions → Network Extensions**
4. Click **(i)** next to the `Network Extensions` row, toggle **Mitmproxy Redirector** on, enter your password
5. Tapsmith detects the state change and prints `✓ iOS simulator network capture is ready.`

On a brand-new install it instead reports `○ Network Extension has not been registered yet`, explains what happens on the first run, and exits 0 — see below.

From this point on, whenever `npx tapsmith test` starts network capture — with each test when tracing records network (the default when tracing is on), otherwise for a run whose tests mock or wait on the network (see [Network prerequisites](network.md#prerequisites)) — it silently spawns the redirector and routes traffic through Tapsmith's MITM proxy.

### If the Network Extension isn't registered yet

On a truly fresh machine the Network Extension is registered the first time Tapsmith spawns the redirector (which happens automatically on your first `tapsmith test` run that captures network: one with tracing on, or one whose tests use `device.route()`). If `tapsmith ios network setup-simulator` reports that the extension has not been registered yet, nothing is wrong (it exits 0); do the following:

1. Run any iOS test once to trigger the registration prompt:
   ```sh
   npx tapsmith test tests/some-ios-test.ts --trace on
   ```
   (Or any test with tracing enabled.)
2. macOS will show a **"System Extension Blocked"** dialog. Click through to System Settings.
3. Approve the extension in **System Settings → General → Login Items & Extensions → Network Extensions**.
4. Re-run `npx tapsmith ios network setup-simulator` to verify, or just re-run your tests.

### Manual fallback

If you prefer to do the setup by hand (or if `tapsmith ios network setup-simulator` doesn't work for some reason):

```sh
brew install mitmproxy
sudo mitmproxy --mode local:Safari   # press `q` to quit once it launches
```

Then open **System Settings → General → Login Items & Extensions → Network Extensions**, click the **(i)** info button, and toggle **Mitmproxy Redirector** on.

Verify with:

```sh
systemextensionsctl list
```

You should see a row ending in `[activated enabled]` for `org.mitmproxy.macos-redirector.network-extension`.

## Configuration

Network capture is on by default whenever tracing is enabled. Control it via the `network` field in `TraceConfig`:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  platform: "ios",
  trace: {
    mode: "retain-on-failure",
    network: true, // default — set to false to disable capture
  },
  // ...
});
```

With `network: false`, traces record no network traffic, and a run whose tests never call `device.route()`, `waitForRequest()`, `waitForResponse()` or `device.on('request' | 'response')` starts no capture, so it needs no mitmproxy install or SE approval. Tests that do mock or wait on the network still start capture and need the extension.

### Overriding the redirector location

By default, Tapsmith looks for the redirector at:

1. The path in `$TAPSMITH_REDIRECTOR_APP` (if set)
2. `/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector` (the brew unpack location)
3. `~/.tapsmith/redirector/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector` (on-demand extract from the brew cask tarball)

Set `TAPSMITH_REDIRECTOR_APP=/path/to/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector` to point at a custom location (e.g. a CI-managed redirector, or a hand-signed Tapsmith fork).

## CI setup

See the [iOS network capture on CI](./ci-setup.md#ios-network-capture-on-ci) section: GitHub-hosted runners need no setup (capture uses the system-proxy fallback), and per-device capture on a self-hosted runner needs the redirector set up once.

## Troubleshooting

### `Mitmproxy Redirector.app not found`

The redirector binary is missing. Run the [first-run setup](#first-run-setup) above, or set `TAPSMITH_REDIRECTOR_APP` to point at an existing redirector binary. The error message lists the fallback search paths.

### System Extension is installed but `[activated waiting for user]`

You installed the SE but haven't approved it yet. Go to **System Settings → General → Login Items & Extensions → Network Extensions → (i)** and toggle it on. The state should change to `[activated enabled]`.

### SE control-channel timeout

Error text (one line, printed once per session; a later watch or MCP run of the same session says only that capture is still unavailable):

```
[tapsmith] Network capture disabled: iOS network capture unavailable for <udid>: Mitmproxy Redirector System Extension did not connect within 10–20 s …
```

After spawning the redirector launcher, Tapsmith waits for the macOS System Extension to dial back into this daemon's Unix socket (`/tmp/tapsmith-redirector-<daemon-pid>.sock`). The wait is 10 s on an idle Mac and grows with the host's load average, up to 20 s. If the extension has not dialled back by then, capture is off for that test (tests that don't use the network still run normally; `device.route()`, `waitForRequest()` and `waitForResponse()` fail with `Network capture disabled`).

**Capture comes back by itself.** Tapsmith keeps the launch and its socket: when the extension dials back late, which is the usual case on a busy Mac, the next test's capture start picks the session up. If it still has not dialled back a minute later, the next test launches the redirector again. Each Tapsmith session (each `--workers` worker, each concurrent `tapsmith test`) has its own socket and redirector, and their launches are serialised across the Mac, so one session's retries never disturb another's capture.

When the extension was installed and approved before the launch, `tapsmith doctor` reports it as enabled, because it is: it was only late, and the message carries the advice below instead of pointing at doctor. (When it was not enabled yet, as on a first run whose approval prompt was dismissed, the message says to approve it, and points at `npx tapsmith doctor` and `npx tapsmith ios network setup-simulator`.) If the timeout keeps happening with the extension enabled:

1. **Check system load.** `uptime` shows the load averages. On a Mac running parallel simulators, Xcode builds or emulators, the extension can need well over 10 s. Quit other heavy processes or run fewer workers.

2. **Stop this session's redirector only.** The error names this session's socket; stop the redirector launched for it with:
   ```sh
   pkill -9 -f '/tmp/tapsmith-redirector-<daemon-pid>.sock'
   ```
   Don't kill every `Mitmproxy Redirector` process: that stops the network capture of every other Tapsmith session on the Mac. Redirectors left behind by a Tapsmith daemon that has died (a crash, a SIGKILL'd IDE) are already cleaned up automatically before each launch.

3. **Reboot macOS.** The Network Extension's state can drift over long uptime or across macOS updates. A reboot resets both the extension and any lingering kernel state.

Verify success on the next run by looking for `System Extension control channel connected` (or, after a late dial-back, `connected late; network capture recovered`) in the daemon debug logs (`RUST_LOG=tapsmith_core=debug TAPSMITH_DAEMON_LOG=daemon.log npx tapsmith test`, then read `daemon.log`).

### Network entries missing from the trace (`network.json` not in the archive)

Check the daemon logs — run `RUST_LOG=tapsmith_core=debug TAPSMITH_DAEMON_LOG=daemon.log npx tapsmith test` and look in `daemon.log` for lines from `tapsmith_core::ios_redirect` (control channel connection, initial InterceptConf, intercepted flows) and `tapsmith_core::network_proxy` (MITM handshakes). Common causes:

- **`failed reading TLS ClientHello`** — the app closed the connection before sending the handshake. Usually a transient issue; rerun the test.
- **`upstream TLS handshake failed for <host>: UnknownIssuer`** — the upstream server uses a certificate chain not in Tapsmith's webpki roots. This affects some Apple-internal services; it does not affect standard public HTTPS endpoints.
- **`simulator_processes returned 0 PIDs`** — the simulator isn't booted, or `ps` parsing couldn't find it. Check `xcrun simctl list devices booted`.

### Requests to localhost are not captured

A simulator shares the Mac's network stack, so an app that calls `http://localhost:4610` (or `127.0.0.1`) reaches a server running on the Mac: your dev API server, a mock backend, or a server the test itself starts. That request works, but **no capture route sees it**. macOS never hands connections to the loopback interface to the Network Extension, and the [system-proxy fallback](#when-the-network-extension-is-unavailable) bypasses `localhost` and `127.0.0.1`. Those requests are missing from the trace (a trace with no other traffic has no `network.json`), and `device.route()`, `device.waitForRequest()` and `device.waitForResponse()` never see them. Tapsmith cannot change this: the extension is mitmproxy's signed redirector, and loopback traffic never reaches it.

Tapsmith notices these connections while capture is running and says so, once per test file for each server, as a warning on the test result and in each affected trace's console:

```
⚠ Network capture warning: the app connected to a server on this Mac's loopback interface (127.0.0.1:4610), and an iOS simulator's network capture cannot see requests to localhost: …
```

A failed test whose routes never fired lists the same server first among the possible reasons. Tapsmith checks the app's open connections every two seconds and as each test ends, so a connection that opens and closes between two checks can go unnoticed; HTTP clients usually keep a connection open for several seconds after a request, so it is normally caught. Connections to development tools are not reported: Metro started by the Expo or React Native CLI (on 8081 or whichever port it picked), React DevTools on 8097, the legacy Expo CLI on 19000–19002, and the Reactotron and Flipper desktop apps. To silence a local helper you know about, add its address to `trace.networkIgnoreHosts` (`127.0.0.1`, or `[::1]` for IPv6); that also silences every other server on that address.

**The fix: address the Mac by its LAN address instead of `localhost`.** A request to the Mac's own Wi-Fi or Ethernet address leaves the app on a real interface, so the Network Extension captures it like any other request, and routes see it. The server must listen on that interface too (`0.0.0.0`, or the address itself), not on `127.0.0.1` only. `ipconfig getifaddr en0` prints the address of the Mac's first network interface (try `en1` if it prints nothing); a VPN address (Tailscale's `100.x.y.z`, say) works too while the VPN is up.

- **An app that reads its server address at build time** (an Expo app's `EXPO_PUBLIC_API_HOST`, a React Native config file): build the app for tests with the Mac's address, for example `EXPO_PUBLIC_API_HOST=$(ipconfig getifaddr en0) npx expo run:ios --configuration Release`. On CI, run the same command on the macOS runner that runs the tests, so the build points at that runner.
- **A server the test starts**: listen on every interface and hand the app the Mac's address, by deep link or a field the test fills in. The helper below picks the first non-internal IPv4 address, preferring `en*` interfaces:

```typescript
import { networkInterfaces } from "node:os"

// How an iOS simulator reaches a server this test process hosts, so that
// network capture sees its requests. (An Android emulator uses 10.0.2.2.)
export function hostLanAddress(): string {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })),
  )
  const pick = candidates.find((c) => /^en\d+$/.test(c.name)) ?? candidates[0]
  if (!pick) throw new Error("This Mac has no non-loopback IPv4 address")
  return pick.address
}
```

Then `server.listen(port, "0.0.0.0")` and `` device.openDeepLink(`myapp://chat?server=http://${hostLanAddress()}:${port}`) ``.

The same applies on Android, where the emulator reaches the Mac as `10.0.2.2` rather than `localhost`: that traffic is captured, though a cleartext port other than 80 needs [`networkHttpPorts`](network.md#local-firebase-emulators-and-custom-http-ports).

### When the CA certificate can't be installed

`xcrun simctl keychain add-root-cert` goes through CoreSimulator, which can stall on a loaded machine (most often a CI runner booting several simulators). Tapsmith tries the install up to three times, for at most about 40 seconds in all. When every attempt fails, it checks the simulator's trust store on disk, since an earlier run (or an attempt that timed out) may already have installed the CA. If the CA is there, capture carries on as usual.

If it isn't, the simulator would reject every certificate the proxy presents, so Tapsmith stops decrypting HTTPS for the rest of the session instead of breaking the app's requests. It passes HTTPS through to the real servers and prints a warning:

```text
[tapsmith] Network capture warning: Could not install Tapsmith's CA certificate on the simulator (tried 2 times): simctl keychain add-root-cert timed out after 6s (CoreSimulatorService may be wedged). HTTPS is passed through to its servers uncaptured, …
```

What that means for the run:

- The app's HTTPS requests still work.
- Each HTTPS connection appears in the trace's Network tab only as a `passthrough` entry, and the tab and the Metadata tab say HTTPS was passed through. The trace's `metadata.json` records `"networkHttpsPassthrough": true` for the device.
- `device.route()`, `waitForRequest()` and `waitForResponse()` cannot see HTTPS. A network wait that times out says why, and so does the warning for a test whose routes never fired.
- Plain HTTP is still captured, mocked and waited on as usual.

Passthrough lasts until Tapsmith exits. To recover, run the tests again. UI mode, watch mode and the MCP server keep one session (and print the warning once), so quit and restart them. If it keeps happening, shut the simulator down (`xcrun simctl shutdown <udid>`) or restart CoreSimulator (`killall -9 com.apple.CoreSimulator.CoreSimulatorService`, which stops every running simulator) before the next run.

### My host's web browser traffic went through Tapsmith's proxy

This should not happen with the Network Extension: it filters by PID, so only the simulator's process tree's traffic is redirected and your browser's PID is not in the filter. Host traffic in a trace means the daemon used the [system-proxy fallback](#when-the-network-extension-is-unavailable); the trace viewer's Network tab says so in a banner, and the trace's `metadata.json` records `"networkCaptureRoute": "ios-system-proxy"` for the device.

If your Mac can't reach the network after a run, a daemon may have been killed while it held the fallback. `npx tapsmith doctor` reports this as `macOS system proxy left behind…` with the exact command to clear it, and the next Tapsmith daemon to start resets it automatically. To clear it by hand:

```sh
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off
```

You can also remove the (no-longer-used) legacy sudoers file that older Tapsmith versions installed:

```sh
sudo rm /etc/sudoers.d/zzz-tapsmith-networksetup
```

### Parallel iOS workers still see empty network tabs

Verify the fix is in place: run with debug logs and look for `tapsmith_core::ios_redirect` lines showing **different `/tmp/tapsmith-redirector-*.sock` paths per worker**. Each worker daemon should have its own session. If multiple workers share a socket path, you are running an older build — upgrade.

### When the Network Extension is unavailable

If the redirector cannot be started (the extension is not approved, or its control channel does not connect within its 10–20 s wait), the daemon can fall back to setting the **macOS system HTTP/HTTPS proxy** on the active network service. This is what CI runners use, where a System Extension cannot be approved. It is host-wide: the trace records whatever any process on the Mac sends (browser preconnects, `trustd` OCSP checks, other apps), and `localhost` and `127.0.0.1` are on the bypass list, so requests to a server on the Mac's loopback interface are *not* captured, as they are not through the Network Extension either (see [Requests to localhost are not captured](#requests-to-localhost-are-not-captured)).

**The fallback is used on CI only.** When the `CI` environment variable is set (as it is on GitHub Actions, GitLab, CircleCI, Buildkite and most other CI systems), the daemon falls back and prints, once per device:

```
[tapsmith] Network capture warning: <udid>: capturing through the macOS system-proxy fallback (the Network Extension redirector is unavailable). This is host-wide: …
```

On a developer Mac the Network Extension is available, so an NE failure there is a real problem to fix, not something to paper over by recording your own browsing. Capture is disabled instead, with `Network capture disabled: iOS network capture unavailable for <udid>: …` saying why, and a pointer to `npx tapsmith doctor` when the cause is one doctor checks (the extension missing or not approved; a [control-channel timeout](#se-control-channel-timeout) carries its own advice). The daemon launches the redirector again at most once a minute (each failed launch costs a 10–20 s wait), picking up a late dial-back from the previous launch on any test in between, so once you fix the extension, capture comes back within a minute without restarting UI mode. To allow the fallback locally anyway, or to refuse it on CI, set:

| `TAPSMITH_IOS_SYSTEM_PROXY_FALLBACK` | Effect |
| --- | --- |
| unset | Fallback allowed only when `CI` is set (and not `false`/`0`, in any case) |
| `1` / `true` / `on` / `yes` | Always allow the fallback |
| `0` / `false` / `off` / `no` | Never use the fallback, even on CI |

**One daemon at a time.** There is only one system proxy per Mac, so only one daemon can hold the fallback. The owner is recorded in `~/.tapsmith/ios-system-proxy.json` under a file lock:

- A second daemon that needs the fallback while another live daemon holds it gets `Network capture disabled: … another Tapsmith daemon (pid N) already routes the macOS system proxy …`, instead of re-pointing the proxy at itself and leaving the first daemon capturing nothing. Parallel iOS workers (`--workers N`) on a runner without the Network Extension therefore capture on one worker only.
- A proxy you configured yourself (Charles, Proxyman, a corporate proxy) is never overwritten; the fallback is refused with the command to turn it off if it was left behind.
- A daemon only switches the proxy off while it still owns it, so the first daemon to exit can't turn it off under another. It puts back your original proxy bypass list (unless you have changed it since). A disabled HTTP/HTTPS proxy server/port you had saved is replaced, not restored: `networksetup` can only write a server by switching it on, and briefly enabling a proxy you had turned off is worse than losing the saved address.
- If a daemon dies without cleaning up, the next daemon to start resets the proxy, and `npx tapsmith doctor` flags it in the meantime.

Once a daemon has fallen back it keeps the fallback (and the same proxy port) across tests until it exits, switches device, or is asked for a device-isolated capture (a [multi-device group](#multi-device-groups) on the same daemon), which releases the host-wide proxy and retries the redirector instead. Each device's trace records `"networkCaptureRoute": "ios-system-proxy"` in `metadata.json`, which the trace viewer's Network tab shows as a warning banner.

### Multi-device groups

Each device of a [device group](multi-device.md) captures on its own daemon, and the runner labels every entry with the device that captured it. That label is only honest on a per-device route, so for a group the runner asks each daemon to **require isolation**: the system-proxy fallback above is refused and that device's capture is disabled with a message naming the device (`Network capture disabled: [bob] …`), instead of recording the whole Mac's traffic under one device's name. The other members keep capturing, and the disabled member retries the redirector on its next test rather than staying disabled for the run — a single-device run remembers the failure for a minute and skips the 10–20 s redirector wait on the tests in between (taking a late dial-back if one arrived), going straight to the system proxy on CI or straight to "capture disabled" locally.

The stock mitmproxy launcher reuses any `mitmproxy` extension configuration that is not yet connected, so two daemons launching within the same ~150 ms used to overwrite each other's socket path, and the second one silently lost the extension. Every daemon on the Mac (group members, `--workers N`, UI mode, a concurrent headless run) now takes a per-user lock (`~/.tapsmith/ios-redirector-launch.lock`) from spawning the launcher until the extension has connected back and accepted its first configuration (or the dial-back wait ran out) and the launcher process has exited (it is stopped if it has not, 5 s later), plus half a second; the capture itself starts as soon as the extension connects, and the lock is released in the background. So launches don't overlap; the runner also starts a group's captures one at a time. The lock is best-effort: if it cannot be taken (other launches have held it for 30 s, which takes a queue of failing or unusually slow launches, or the lock file cannot be locked at all), the daemon launches anyway and logs `serialised=false`. If a device still reports `Network Extension redirector unavailable`, look for `serialised=true` on the `spawning redirector launcher` line and `System Extension control channel connected` in each daemon's debug log.

### Physical iOS device network capture

See the [Physical iOS devices](#physical-ios-devices) section below — physical devices use a different setup flow (`tapsmith ios network configure`) because they can't share the macOS Network Extension that simulators use.

## Physical iOS devices

Physical iPhones/iPads have their own network stack — the macOS Network Extension redirector used for simulators only intercepts host-originated traffic, so it can't route a real device. Tapsmith therefore uses a different mechanism for physical devices: a per-device **configuration profile** (`.mobileconfig`) that installs a Wi-Fi HTTP proxy on the device pointing at the host Mac's LAN IP, plus the Tapsmith MITM CA.

### How it works (physical)

1. `tapsmith ios network configure <udid>` generates a `.mobileconfig` containing two payloads:
   - `com.apple.wifi.managed` — targets your current Wi-Fi SSID with an automatic (PAC) proxy, `http://<host-ip>:<deterministic-port>/tapsmith.pac`, that falls back to a direct connection when Tapsmith isn't running. The port is `9000 + CRC32(udid) % 1000`, so it's stable per device and multiple devices can run in parallel without colliding.
   iOS does not apply a profile's proxy settings on a device that isn't supervised, so you also enter that PAC URL in the device's Wi-Fi settings once (step 4 below).
   - `com.apple.security.root` — the Tapsmith CA, for HTTPS trust.
2. You install the profile on the device once (AirDrop / email / Messages), trust the CA in **Settings → General → About → Certificate Trust Settings**, and set the Wi-Fi proxy URL.
3. When `tapsmith test` targets that device, the daemon binds its MITM proxy on `0.0.0.0:<deterministic-port>` so the device can reach it over Wi-Fi. Traffic flows through the same MITM engine as the simulator path, producing identical `NetworkEntry` records in the trace.

### First-run setup (physical)

Prerequisites — `tapsmith ios setup-device` checks the host tools, device pairing and the agent build for you; Developer Mode you check on the device:

- Xcode 15+ with command-line tools
- `libimobiledevice` installed (`brew install libimobiledevice`)
- A signed TapsmithAgent built for iOS device (`tapsmith ios build-agent`)
- Your device plugged in via USB, paired with Xcode, Developer Mode enabled

Then, for each physical device you want to test against:

```sh
# 1. Verify environment + see the device's UDID
tapsmith ios setup-device

# 2. Generate the mobileconfig (auto-detects host Wi-Fi IP, SSID, device name)
tapsmith ios network configure <UDID>
```

Follow the on-screen walkthrough to install the profile on the device:

1. AirDrop the generated `~/.tapsmith/devices/<UDID>.mobileconfig` to the iPhone (or email it).
2. On the device, open **Settings → General → VPN & Device Management**, tap the "Tapsmith Network Capture" profile, then "Install" → enter passcode → "Install".
3. Trust the CA: **Settings → General → About → Certificate Trust Settings → Tapsmith MITM CA → full trust**.
4. Set the proxy: **Settings → Wi-Fi → (i)** next to your network → **Configure Proxy → Automatic** → enter the URL the command printed (`http://<host-ip>:<port>/tapsmith.pac`) → **Save**.

Then run `tapsmith ios network verify <UDID>` to check it end to end. From then on, `tapsmith test` against that UDID captures traffic whenever capture runs (see [iOS physical device network capture](ios-physical-device-network-tracing.md) for the full walkthrough).

### Scoping what gets captured (physical only)

iOS applies the `com.apple.wifi.managed` HTTP proxy **system-wide** — there's no per-app scoping available without MDM enrollment. The MITM proxy therefore sees traffic from every app and background service running on the device, not just the app under test. iOS's own chatty background services (captive portal checks, Apple ID refresh, analytics, iCloud sync) will show up in the trace alongside your app's requests.

Use `trace.networkHosts` in your config to scrub the noise:

```ts
import { defineConfig } from 'tapsmith'

export default defineConfig({
  platform: 'ios',
  device: '00008140-00096C9014F3001C',
  trace: {
    mode: 'on',
    // Only keep entries whose hostname matches one of these patterns.
    // Glob syntax: `*` matches any number of characters;
    // `*.example.com` matches `api.example.com`, `cdn.example.com`,
    // and `example.com` itself. Case-insensitive.
    networkHosts: ['*.myapp.com', 'api.partner.example'],
  },
})
```

Tapsmith applies the filter when stopping the capture, so filtered-out entries never touch the trace archive. If you don't set `networkHosts`, every entry is kept (current behaviour).

**Simulators** already filter per-PID at the kernel level via the macOS Network Extension redirector, so `networkHosts` is mostly redundant on sim runs — but it still works there if you want belt-and-braces filtering.

### Running parallel physical devices

The deterministic per-UDID port means multiple physical devices on the same Wi-Fi network each get their own host port without collision. Run `tapsmith ios network configure` once per device; each installs a profile with a distinct port, and parallel worker buckets dispatch independently.

### When the host's Wi-Fi IP changes

The mobileconfig embeds the host's LAN IP at generation time. If you move between Wi-Fi networks (or DHCP reassigns your IP), the installed profile goes stale and the device will hit connection-refused when it tries the proxy. Regenerate:

```sh
tapsmith ios network configure <UDID> --refresh
```

It prints the steps: remove the old profile on the device (**Settings → General → VPN & Device Management → Tapsmith Network Capture → Remove Profile**), install and trust the new one, and replace the proxy URL in the device's Wi-Fi settings with the new one it prints. The proxy URL carries the Mac's IP, so this last step is the one that actually fixes an IP change.

Tapsmith also detects this at test time: if the daemon notices that the host's current Wi-Fi IP doesn't match the IP recorded in `~/.tapsmith/devices/<UDID>.meta.json`, it prints a warning in the trace with the `tapsmith ios network configure <UDID> --refresh` command to run.

### Troubleshooting (physical)

**"No Tapsmith network profile found for device …"** — you haven't generated the mobileconfig yet. Run `tapsmith ios network configure <UDID>`.

**"Host Wi-Fi IP changed since mobileconfig was generated"** — see [When the host's Wi-Fi IP changes](#when-the-hosts-wi-fi-ip-changes).

**The device isn't routing traffic through the proxy** — check that the device is actually on the SSID the mobileconfig targets (not cellular or a different Wi-Fi). Also confirm the profile is installed and CA trust is enabled.

**HTTPS requests fail with certificate errors** — for normal system-trust clients, the Tapsmith CA probably isn't trusted on the device. Go to **Settings → General → About → Certificate Trust Settings** and enable full trust for "Tapsmith MITM CA". If the app uses certificate pinning or embedded roots, trusting the CA may not be enough; configure `networkPassthroughHosts` for that host. HTTP/2-capable clients may also fall back dynamically and show `CONNECT passthrough` entries instead of decrypted requests.

**A VPN app is installed on the device** — VPN apps bypass Wi-Fi HTTP proxy. Disable the VPN for the duration of testing. This is a known limitation.

**Device signing expired (free Apple Developer account)** — free accounts rotate profiles every 7 days. Rerun `tapsmith ios build-agent` to refresh the signed runner.

## Security and privacy

- The Tapsmith CA is generated once per machine and stored under `~/.tapsmith/ca.pem`. It is installed into the simulator's trust store at the start of the first capture session and **persists** there across subsequent runs. Tapsmith does not currently remove the CA at session end — to wipe it, `xcrun simctl erase <udid>` (erases the simulator) or remove the cert manually from the simulator's keychain.
- Only traffic from the simulator's apps and process tree is routed through the proxy. Host browsers, IDEs, and other apps are unaffected.
- The macOS system proxy (`networksetup -setwebproxy`) is only touched when the Network Extension is unavailable and Tapsmith falls back to it, which by default happens on CI only (see [When the Network Extension is unavailable](#when-the-network-extension-is-unavailable)). In that mode every process on the Mac is proxied, so the trace can contain host traffic (browser preconnects, `trustd` OCSP checks) alongside the simulator's — be careful sharing such a trace; its `metadata.json` records `"networkCaptureRoute": "ios-system-proxy"` and the viewer flags it. Tapsmith disables the proxy again when the daemon exits and restores your proxy bypass list; the server/port values it wrote stay visible in `networksetup -getwebproxy` with `Enabled: No`.
- Request and response bodies are truncated to 1 MiB each in the captured trace to prevent runaway memory usage.

## Attribution

Tapsmith's iOS network capture builds on the [mitmproxy](https://mitmproxy.org) project's `mitmproxy_rs` macOS redirector, which is MIT-licensed. Specifically, Tapsmith vendors the `mitmproxy_ipc.proto` schema (in `packages/tapsmith-core/vendor/mitmproxy_ipc.proto`) and depends at runtime on the `Mitmproxy Redirector.app` binary shipped with `brew install mitmproxy`. Tapsmith does not bundle or fork mitmproxy itself.

MIT License © Mitmproxy contributors — see the [mitmproxy_rs LICENSE](https://github.com/mitmproxy/mitmproxy_rs/blob/main/LICENSE).
