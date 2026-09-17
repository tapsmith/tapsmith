# Telemetry

Tapsmith collects a small amount of **anonymous usage data** by default. This page lists exactly what is sent, what never is, and how to turn it off in one line.

Without usage numbers there is no way to tell five users from five thousand, which leaves nothing to prioritise against. That is the whole reason this exists, and transparency about it is the whole reason it is acceptable.

## Opting out

Any one of these disables telemetry completely. Nothing is sent, and no anonymous id is created.

```bash
# Once, for every project on this machine
npx tapsmith telemetry disable

# See the current setting and, if it is off, which switch decided it
npx tapsmith telemetry status
```

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  telemetry: false,
});
```

```bash
# Per shell / per CI job — wins over the config in the "off" direction
TAPSMITH_TELEMETRY=0 npx tapsmith test
```

```bash
# The cross-tool convention (https://consoledonottrack.com) is honoured too
DO_NOT_TRACK=1 npx tapsmith test
```

The switches only ever combine towards **off**. The environment variable wins over the config, the config wins over the machine-wide setting, and `tapsmith telemetry enable` cannot override either of the other two. `tapsmith telemetry status` names the one that decided.

### Seeing exactly what would be sent

```bash
TAPSMITH_TELEMETRY_DEBUG=1 npx tapsmith test
```

prints every event to stderr, prefixed `[telemetry]`, and sends nothing. It is the quickest way to audit the payload against the tables below.

## What is collected

One event is sent when a **test-file run finishes** (`tapsmith run`), plus a one-off `tapsmith install` event the first time a machine creates its anonymous id. When a file is retried after an infrastructure failure (agent disconnect, daemon unavailable) on the paths that retry — the CLI, parallel workers, and UI mode — only the final attempt is reported; the discarded attempt is not counted, so a recovered file still yields one event. Watch mode and the MCP server run a file once and report that single run even when it hit an infrastructure error. Treat the events as a sample of activity, not an exact file count. Events go to [PostHog](https://posthog.com), hosted in its EU region, as a standard PostHog capture envelope:

| Field | Example | Why |
|---|---|---|
| `event` | `"tapsmith run"` or `"tapsmith install"` | Distinguish first installs from ongoing use. |
| `distinct_id` | `"7f3c…"` | A random UUID stored in `~/.tapsmith/telemetry.json`. Not derived from your machine, user, or project. Lets runs from one machine be counted once. |
| `timestamp` | `"2026-09-10T14:03:11.412Z"` | When the event happened. |
| `api_key` | `"phc_…"` | The Tapsmith PostHog project token. Public by design, like every PostHog client key; it can write events, never read them. |
| `properties` | see below | Everything else. |

Every event's `properties` carry:

| Property | Example | Why |
|---|---|---|
| `session_id` | `"a91e…"` | Groups every event of one Tapsmith invocation — a single CLI run (including its parallel workers) or one MCP server session. The entry point sets it once and every forked worker inherits it; it is never stored. |
| `sdk_version` | `"0.4.1"` | Which Tapsmith versions are in use. |
| `node_version` | `"v22.21.0"` | Which Node versions to keep supporting. |
| `os` | `"darwin"` | Host operating system (`darwin`, `linux`, `win32`). |
| `arch` | `"arm64"` | Host CPU architecture. |
| `ci` | `true` | Whether the run was on CI (the `CI` environment variable). |
| `$lib` / `$lib_version` | `"tapsmith"` / `"0.4.1"` | PostHog's convention for naming the client that sent the event. |
| `$geoip_disable` | `true` | Tells PostHog not to derive a location from the connection. The project is also configured to discard client IP addresses before storage. |
| `$process_person_profile` | `false` | Anonymous events: PostHog builds no person profile for the id. |

`tapsmith run` events add:

| Property | Example | Why |
|---|---|---|
| `mode` | `"test"` | Which run path executed the file: `test` (sequential CLI), `test-parallel` (`--workers N`), `ui` (UI mode), `watch` (headless watch mode), `mcp` (the MCP server's `tapsmith_run_tests`). |
| `platform` | `"android"` | `android` or `ios`. |
| `devices` | `1` | Size of the device group the file ran on (`use.devices`). |
| `tests` / `passed` / `failed` / `skipped` | `12` / `11` / `1` / `0` | Counts only. |
| `duration_ms` | `48211` | How long the file took. |

That is the complete list. The payload is a closed set of fields, and Tapsmith's own unit tests assert exactly those key sets so they cannot widen by accident.

## What is never collected

- Test names, describe names, or the contents of test files
- Locators, element text, screenshots, hierarchies, or traces
- App identifiers (`package`, bundle ids), APK/app paths, or anything from your config other than the boolean `telemetry` key
- File paths, project names, or repository names
- Device serials, UDIDs, device names, hostnames, usernames, or email addresses
- IP addresses or IP-derived location. Every event carries `$geoip_disable: true` so PostHog derives no location, and the Tapsmith PostHog project is configured to discard client IP addresses before storage. Both together are what makes this true; if you redirect events with `TAPSMITH_TELEMETRY_ENDPOINT`, your own receiver sees the connection's source address like any HTTPS server, and this guarantee is then yours to keep.
- Anything from your app's network traffic

## The first-run notice

The first time Tapsmith runs tests on a machine it prints a short notice to stderr saying that telemetry is on and how to opt out, then records that the notice was shown (in the same state file as the anonymous id) so it never prints again on that machine. Nobody should learn about this from a firewall log.

## How it is sent

- One HTTPS `POST` per finished test file to PostHog's EU capture endpoint, `https://eu.i.posthog.com/i/v0/e/`, fire-and-forget, bounded by a 3-second timeout. No PostHog SDK is involved; it is a plain `fetch` of the JSON above.
- The processor is PostHog Inc. under its cloud terms, with data held in its EU region. Tapsmith reads the data through PostHog's dashboards and nowhere else.
- Failures are silent. Telemetry never slows a run down, never prints a warning, and never changes an exit code — an offline CI machine behaves identically.
- After three consecutive failures Tapsmith stops trying for the rest of the process.
- Forked worker processes (parallel workers, UI-mode workers, watch-mode children) report their own files and inherit your opt-out. They share one anonymous id and one session id, set by the parent before forking. A fresh machine's first parallel run may emit more than one `install` event, but all carry that single id, so a machine is still counted once (count distinct ids, not raw install events).

## The anonymous id

The id lives in `~/.tapsmith/telemetry.json`, owner-readable only:

```json
{
  "anonymousId": "7f3c1d3a-9d0f-4a9c-b0a5-6d2f4e1c8a11",
  "createdAt": "2026-09-10T14:02:58.001Z",
  "noticeShown": true,
  "enabled": false,
  "installReported": true
}
```

`enabled` is written by `tapsmith telemetry enable|disable` and is absent (meaning on) until you use them; `anonymousId` is created only when the first event is sent, so a machine that runs `tapsmith telemetry disable` first never gets one. Delete the file to rotate the id (the next run counts as a new install and prints the notice again) — but note this also clears a machine-wide opt-out, so if you had run `tapsmith telemetry disable`, run it again afterwards. If the file cannot be written — a read-only home directory, say — Tapsmith uses a throwaway id for that process and sends no `install` event.

## Pointing telemetry somewhere else

`TAPSMITH_TELEMETRY_ENDPOINT` overrides the capture URL, for organisations that want to receive their own copy, route through a proxy, or keep everything inside a self-hosted PostHog:

```bash
TAPSMITH_TELEMETRY_ENDPOINT=https://posthog.internal.example.com/i/v0/e/ npx tapsmith test
```

The payload is the PostHog capture envelope documented above, sent with `Content-Type: application/json`, so any PostHog-compatible endpoint accepts it. It still carries Tapsmith's project token; a self-hosted instance ignores an unknown token, so pair the override with a proxy that swaps in your own if you want the events to land in your project.

The endpoint must be **HTTPS**, or plain HTTP only to a loopback host (`localhost`, `127.0.0.1`, `::1`) for a local proxy. A cleartext endpoint to any other host is refused and telemetry is disabled for that process rather than sent in the clear, and redirects are never followed.

## Where this is implemented

Everything lives in one module, `packages/tapsmith/src/telemetry.ts`, so there is a single place to audit. The runner reports the event; each of the five run paths declares which mode it is (a required option, so a new run path cannot forget to). The unit tests in `packages/tapsmith/src/__tests__/telemetry.test.ts` pin the field list, the opt-outs, and the never-fails behaviour.
