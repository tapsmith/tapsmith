# iOS physical device network capture

Decrypted HTTPS request/response bodies in your traces, on real iPhones/iPads. **You don't need this for basic testing** — if you just want to run tests on a real device, start with [iOS physical devices](./ios-physical-devices.md).

This page covers the extra one-time setup: installing a mobileconfig profile on the device that routes Wi-Fi traffic through Tapsmith's MITM proxy, then trusting Tapsmith's CA so iOS will decrypt HTTPS.

## Prerequisites

- Everything in [iOS physical devices](./ios-physical-devices.md) already working — a test must run green before adding network capture
- The device and the Mac on the same Wi-Fi network

## Enable network tracing in your config

```ts
import { defineConfig } from 'tapsmith';

export default defineConfig({
  platform: 'ios',
  app: './build/MyApp-Device.app',
  package: 'com.example.myapp',
  trace: {
    mode: 'on',
    // Strongly recommended on physical iOS — the Wi-Fi proxy is system-wide
    // so the trace otherwise includes every app and background service.
    networkHosts: ['*.myapp.com', 'api.example.com'],
  },
});
```

With `trace.mode` off, Tapsmith starts no proxy until a test calls `device.route()`, `waitForRequest()` or `waitForResponse()`, which start it on demand. Turning `trace.mode` on starts it for every test, so the trace records each test's traffic.

## One-time device setup

Run this command. It handles stealth mode, SSID detection, profile generation, and drops a walkthrough for the on-device steps:

```sh
tapsmith ios network configure <udid> --fix-firewall
```

What it does:

1. **Disables macOS Application Firewall stealth mode** (if on). Stealth mode silently drops inbound TCP SYNs to user processes — even binaries that are explicitly allowed in the firewall list. Without this, the iPhone on Wi-Fi can't reach the Tapsmith proxy on the Mac's LAN IP and traces will show zero network entries. `--fix-firewall` runs the sudo command for you (prompts once for password); without the flag Tapsmith just prints the command for you to run manually.
2. **Detects the current Wi-Fi SSID**, or prompts you for one interactively if macOS won't reveal it (14+ redacts SSID from `ipconfig getsummary` unless the calling process has Location Services permission — Tapsmith doesn't, so we ask). You can also pass `--ssid "Name"` explicitly.
3. **Generates the mobileconfig profile** under `~/.tapsmith/devices/<UDID>.mobileconfig` and reveals it in Finder for AirDrop.
4. **Prints the on-device walkthrough** — AirDrop, install, trust the Tapsmith CA.

Walk through the on-device steps once:

1. **Send** the profile. Finder has it pre-selected — right-click → Share → AirDrop → your iPhone. (Email / Messages work too.)
2. **Install** it. Settings shows a "Profile Downloaded" banner — tap it → Install → enter passcode → Install.
3. **Trust the Tapsmith CA.** Settings → General → About → Certificate Trust Settings → toggle **Tapsmith MITM CA**. This row only appears *after* step 2 — the profile install is what makes iOS reveal it.
4. **Set the proxy URL.** Settings → Wi-Fi → **(i)** next to your network → Configure Proxy → **Automatic** → enter the URL printed by the command above (e.g. `http://192.168.4.38:9037/tapsmith.pac`) → **Save**. This is a one-time step per Wi-Fi network. The profile handles the CA cert (the part that genuinely requires a mobileconfig); the proxy URL must be set manually because iOS doesn't enforce proxy settings from profiles on unsupervised devices.

Then verify end-to-end:

```sh
tapsmith ios network verify <udid>
```

This starts the proxy, asks you to load an HTTPS page in Safari, then reports whether Tapsmith saw the traffic and decrypted it. Catches the three common failure modes (profile not installed, CA not trusted, firewall blocking) with specific fix-it hints.

From then on, `tapsmith test` will capture full HTTPS traffic into the trace.

## What gets captured

The Wi-Fi HTTP proxy is applied **system-wide** by iOS — no per-app scoping is available without MDM enrollment. That means Tapsmith's MITM proxy sees traffic from every app and background service running on the device:

- iOS system services (captive portal checks, weather, analytics, iCloud sync)
- Any other app you have running (Mail, Safari, Messages, etc.)
- The app under test

Two things help:

1. **Use a host allowlist** in `tapsmith.config.ts`:

   ```ts
   trace: {
     mode: 'on',
     networkHosts: ['*.myapp.com', 'api.example.com'],
   }
   ```

   Only entries whose hostname matches one of the patterns end up in traces. `*` matches any number of characters, `*.example.com` matches `api.example.com`, `cdn.example.com`, and `example.com` itself. Case-insensitive.

2. **Close unrelated apps** on the phone. iOS background services are unavoidable but Mail / Safari / Messages go quiet.

On iOS **simulators** the filtering is handled per-PID at the kernel level by the macOS Network Extension redirector, so simulator runs aren't noisy and `networkHosts` is rarely needed there.

## Host IP drift

The mobileconfig profile bakes in the Mac's LAN IP at the time you ran `ios network configure`. If your Mac switches Wi-Fi networks (coffee shop → office), the baked-in IP goes stale and iOS silently fails to route traffic.

Tapsmith handles this for you: on every `tapsmith test` run with tracing enabled, the host-IP sidecar (`~/.tapsmith/devices/<udid>.meta.json`) is compared against the current Wi-Fi IP. If they differ, you're warned to run `tapsmith ios network configure <udid> --refresh`, which regenerates the profile and walks you through reinstalling it and entering the new proxy URL on the device. Regeneration is instant; the reinstall is a quick AirDrop-and-tap.

## Changing `trace.networkHosts`

Good news: iOS fetches the PAC script from the Tapsmith daemon very aggressively — empirically, on nearly every new host load, not just on Wi-Fi join. That means when you change `trace.networkHosts` in `tapsmith.config.ts`, the new filter takes effect on the next `tapsmith test` run with no manual intervention on the phone — no Wi-Fi toggle, no profile reinstall.

If you ever need to confirm iOS picked up a change, run the daemon with `RUST_LOG=info` and watch for `Served /tapsmith.pac` log lines with the expected `host_count` field.

You can also refresh manually:

```sh
tapsmith ios network configure <udid> --refresh
```

## Security note

While network capture runs (a trace that records network, or a test that mocks with `device.route()` or waits on the network), Tapsmith's MITM proxy binds on `0.0.0.0:<port>` (all network interfaces) so the iPhone can reach it over Wi-Fi. This means **any device on the same local network** could potentially route HTTP/HTTPS traffic through the proxy and have it decrypted by the Tapsmith CA. The proxy has no authentication.

In practice this is only a concern on untrusted networks (coffee shops, shared offices). On a private home/lab Wi-Fi it's a non-issue. If you're on a shared network, either restrict to simulator-only tracing (which binds on `127.0.0.1`) or ensure your Mac's firewall allows only the specific iPhone's IP. The proxy is only bound while a `tapsmith test` session that captures or mocks network traffic, or `tapsmith ios network verify`, is running — from the first test that needs it until the session ends. It's not a persistent listener.

## Known limitations

- **VPN apps on the device bypass HTTP proxy.** The MITM proxy won't see traffic the VPN is handling.
- **Certificate pinning or embedded roots break decryption** for specific apps and SDKs, including some Firestore/gRPC clients. Configure `networkPassthroughHosts` for known pinned hosts; HTTP/2-capable cert rejects may also fall back dynamically. Passthrough connections show up as a `CONNECT` entry marked `passthrough`, without request or response bodies.
- **Parallel device setup.** Each device gets its own deterministic port derived from its UDID, so multiple devices can share the same Mac and proxy process.

## Troubleshooting

**Traces show zero network entries.** Run `tapsmith ios network verify <udid>` — it walks through the three most common causes (stealth mode on, profile not installed, device not on the profile's Wi-Fi) and prints the specific fix.

**Traces show HTTPS entries with empty bodies.** For normal system-trust clients, the CA isn't trusted. Settings → General → About → Certificate Trust Settings → toggle Tapsmith MITM CA. Remember the row only appears after the mobileconfig profile is installed. For pinned or embedded-root clients, configure passthrough; HTTP/2-capable cert rejects may also appear as `CONNECT passthrough`.

**"Device not routing through proxy"** after switching Wi-Fi networks. Run `tapsmith ios network configure <udid> --refresh` and reinstall the new profile on the device. Tapsmith will flag this automatically on the next `tapsmith test` run.

**SSID detection bails with a redacted placeholder.** macOS 14+ redacts Wi-Fi SSIDs unless the process has Location Services permission. Pass `--ssid "YourWiFiName"` explicitly, or answer Tapsmith's interactive prompt.
