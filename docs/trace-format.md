# Trace Archive Format

A Tapsmith trace is a `.zip` file. This page is the contract for what is inside it, for tools that read traces without the [trace viewer](trace-viewer.md): CI dashboards, indexers, and scripts that pull failures out of CI artifacts.

The contract has two parts:

- **This page** covers the version policy, what each member holds, and the rules a JSON Schema can't express.
- **A JSON Schema** for machine validation, shipped in the npm package:

  ```js
  import { createRequire } from "node:module"
  const schemaPath = createRequire(import.meta.url).resolve("tapsmith/trace-format.schema.json")
  ```

  The schema describes an archive *after* it has been unzipped (see [Validating an archive](#validating-an-archive)).

## Versioning

`metadata.json` carries the format version in `version`. **The current format version is `2`.**

| Version | Recorded by | Change |
|---|---|---|
| 1 | Releases up to and including 0.5.0 | Initial format. Local paths are absolute on the recording machine. |
| 2 | Later releases | `testFile`, `appState`, stack-frame `file`s and `sources.json` keys are POSIX paths relative to the project's `rootDir`. |

Branch on `version`, never on `tapsmithVersion`. Builds from source between releases report the last release's number but write the current format.

The version is bumped only for a change an existing reader could misread:

- a field or member is removed or renamed
- a value changes meaning
- a closed set (listed below) gains or loses a value

Additive changes **don't** bump it: a new optional field, event type or archive member, or a new value of an open set.

Rules for readers:

- **Refuse a version newer than you know.** Say what version you found and what you support. Rendering a newer archive anyway can show a plausible-looking but wrong trace. The Tapsmith viewer and `tapsmith_read_trace` refuse with an upgrade hint.
- **Refuse a `metadata.json` with no integer `version`.** It isn't a Tapsmith trace.
- **Ignore what you don't recognise**, including fields, event `type`s and archive members.
- Treat these as **open sets**, which can grow without a version bump:
  - action `category`
  - action `origin`
  - network `routeAction`
  - `appReset` and `appResetScope`
- These are **closed sets**:
  - `testStatus`
  - console `level` and `source`
  - device `platform`

## Archive members

| Member | Format | Present |
|---|---|---|
| `metadata.json` | JSON object | Always |
| `trace.json` | NDJSON, one event per line, in recording order | Always |
| `screenshots/action-NNN-{before,after}.png` | PNG at the device's native resolution | When the screenshots channel is on |
| `hierarchy/action-NNN-{before,after}.xml` | View hierarchy dump. Android emits `<node …>`; iOS emits `XCUIElementType…` elements | When the snapshots channel is on |
| `sources.json` | JSON object: `{ [path]: fileContents }` | When the sources channel is on and a source was readable (each file is capped at 2 MiB) |
| `network.json` | NDJSON, one request per line | When at least one request was captured |
| `network/req-N.bin`, `network/res-N.bin` | Raw request and response bodies | For each entry with a non-empty body |

Every member name is a relative POSIX path with no `..` segment, so extracting an archive can't write outside the target directory.

## Paths

Structured fields that name a file on the recording machine use a **project path**: POSIX separators, relative to the project's `rootDir`. The project root isn't recorded, so an archive reads the same no matter where it was recorded. Two CI runners with different checkout directories produce matching paths for the same test.

These fields are project paths:

- `metadata.testFile`: empty for a manual `device.tracing` trace recorded outside the test runner
- `metadata.appState`
- `file` in every `sourceLocation` and `stack[]` frame
- every key of `sources.json`

A file outside `rootDir` climbs with `..`, for example `../shared/helpers.ts`. A path is never absolute.

Stack-frame `file`s and `sources.json` keys use the same spelling, so a frame resolves to its source with an exact key lookup. That includes frames from `afterAll` hooks, whose events are appended to the last test's trace. The exception is a source file over 2 MiB, or one that couldn't be read, which has no key.

Symlinks are handled in both directions:

- A `rootDir` reached through a link still yields relative paths. A file outside it is recorded relative to where `rootDir` really is, so it reads the same as on a machine where `rootDir` isn't linked.
- When the test file sits under a linked directory, everything under that same link keeps its path under `rootDir`, including the test's helpers and screen objects.
- Any other symlinked file is recorded under its target's path, relative to `rootDir`. That spelling is still portable, but it's the target's, not the link's.

**Free text is display-only** and is recorded as-is: error messages, `errorStack`, the `stack` of an error event, and console messages. It may name absolute local paths, so don't parse it for structure.

## `metadata.json`

| Field | Type | Notes |
|---|---|---|
| `version` | integer | Format version. See [Versioning](#versioning). |
| `tapsmithVersion` | string | SDK version that recorded the trace. |
| `testFile` | project path | |
| `testName` | string | Full title, with `>` between suite levels. |
| `testStatus` | `passed` \| `failed` \| `skipped` \| `running` \| `idle` | Packaged traces only use the first three. |
| `testDuration` | number | ms. |
| `startTime`, `endTime` | number | ms since the Unix epoch, host clock. |
| `device` | device | The primary device. |
| `devices` | device[] | Every device of a [multi-device](multi-device.md) test, primary first. Absent for one device. |
| `traceConfig` | object | Which channels were recorded: `screenshots`, `snapshots`, `sources`, `network`, `deviceLogs` and `daemonLogs`, all booleans. |
| `actionCount` | integer | Size of the action-index space: one past the highest index used. |
| `screenshotCount` | integer | Screenshot members in the archive. |
| `error` | string | The test's error, if it failed. |
| `project` | string | Project name, when projects are configured. |
| `appState`, `appReset`, `appResetScope` | string | The [app reset](configuration.md) in effect. `appState` is a project path. |

A **device** has these fields:

- **Always present:**
  - `serial`
  - `isEmulator`
- **Optional:**
  - `name`: the device's group name, which events carry as `deviceId`
  - `platform`: `android` or `ios`
  - `model`
  - `osVersion`
  - `screenResolution`: `{ width, height }`
  - `packageName`
  - `devicePixelRatio`: element bounds are in logical points and screenshots are in pixels

## `trace.json` events

Every event has these fields:

- `type`: string
- `actionIndex`: integer ≥ 0
- `timestamp`: ms since the epoch
- `deviceId`: optional; the device's group name in multi-device tests

| `type` | Required fields | Notes |
|---|---|---|
| `action` | `category`, `action`, `duration`, `success`, `hasScreenshotBefore`, `hasScreenshotAfter`, `hasHierarchyBefore`, `hasHierarchyAfter` | Optional: `selector` (serialized JSON), `inputValue`, `error`, `errorStack`, `bounds`, `point`, `endPoint`, `sourceLocation`, `stack`, `waitTime`, `retryCount`, `log`, `detail`, `origin`, plus the timing fields below. |
| `assertion` | `assertion`, `passed`, `soft`, `negated`, `duration`, `attempts` | Optional: `selector`, `expected`, `actual`, `error`, `bounds`, `sourceLocation`, `stack`, the `has*` capture flags, and the timing fields. |
| `group-start`, `group-end` | `name` | Brackets hook and test phases, for example `beforeEach Hooks` or `Test`. |
| `console` | `level`, `message`, `source` | `source`: `test` is the test code's console, `device` is logcat or syslog, and `daemon` is tapsmith-core. |
| `error` | `message` | Optional `stack`, which is display text. |
| `attachment` | `name`, `contentType`, `path`, `size` | Reserved: not emitted yet. `path` names an archive member. |

The timing fields are all optional numbers in ms:

- `wallDuration`
- `gapBefore`
- `trailingTime`
- `startTime`
- `endTime`

`wallDuration` is the time the event occupies on the trace's linear timeline, including idle time before it. The last step also absorbs teardown, so the `wallDuration`s add up to `testDuration`.

### Steps and captures

Actions and assertions are **steps**. They share one `actionIndex` space, counted from 0, and no two steps share an index. Other event types carry the index of the step they happened during.

Don't assume the indices are dense or that they appear in file order:

- `trace.json` lists a step when it *completes*. Steps that overlap, such as two devices acting at once in a [multi-device](multi-device.md) test, can appear out of index order. Order steps by `startTime`, falling back to `actionIndex`.
- An index can go unused, for example when a step was abandoned after its index was reserved.

A step's captures are found by name:

- A step with `hasScreenshotBefore` owns `screenshots/action-NNN-before.png`.
- A step with `hasHierarchyBefore` owns `hierarchy/action-NNN-before.xml`.

`NNN` is the `actionIndex`, zero-padded to at least three digits.

After the last step, the runner takes one terminal capture per device, in the slots just past it. These give the last step an "after" view. When an `afterAll` hook's events are appended to the last test's trace, they start after those slots. So the terminal captures sit in a gap one slot per device wide, and no step claims them.

## `network.json` entries

Every entry has these fields:

- `index`: unique within the archive, but not guaranteed to be contiguous or in file order. The body members `network/req-N.bin` and `network/res-N.bin` are named by it.
- `actionIndex`: the step the request is attributed to
- `startTime`, `endTime` and `duration`
- `method`, `url`, `status` and `contentType`
- `requestSize` and `responseSize`
- `requestHeaders` and `responseHeaders`: string → string

Optional fields:

- `deviceId`
- `observedStartTime`: set for a request that began before this test
- `inFlight`: the request was still open when the trace was packaged
- `routeAction`
- `requestBodyPath` and `responseBodyPath`: the archive members that hold the bodies

Bodies are never inlined in `network.json`. A body stays byte-exact, so binary payloads such as gRPC can still be decoded.

A `routeAction` of `passthrough` marks a TLS connection that was tunneled without interception. It is recorded as one `CONNECT` entry per connection, with no request or response detail.

## Validating an archive

The schema describes format version 2 only; it rejects a v1 archive's absolute paths. So check `metadata.version` before validating. Validate a v2 archive against the schema. Read a v1 archive knowing its paths are absolute, or skip it. Refuse anything newer.

The schema's root describes an unzipped archive, with these keys:

| Key | Contents |
|---|---|
| `members` | The zip's member names |
| `metadata` | Parsed `metadata.json` |
| `events` | Parsed `trace.json` lines |
| `network` | Parsed `network.json` lines |
| `sources` | Parsed `sources.json` |

It uses JSON Schema 2020-12:

```js
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { unzipSync, strFromU8 } from "fflate"
import { Ajv2020 } from "ajv/dist/2020.js"

const require = createRequire(import.meta.url)
const schema = JSON.parse(readFileSync(require.resolve("tapsmith/trace-format.schema.json"), "utf8"))
const validate = new Ajv2020({ allErrors: true }).compile(schema)

const files = unzipSync(readFileSync("trace.zip"))
const ndjson = (name) => (files[name] ? strFromU8(files[name]).split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const archive = {
  members: Object.keys(files),
  metadata: JSON.parse(strFromU8(files["metadata.json"])),
  events: ndjson("trace.json"),
  network: ndjson("network.json"),
  sources: files["sources.json"] ? JSON.parse(strFromU8(files["sources.json"])) : {},
}
if (archive.metadata.version !== 2) {
  // v1: absolute paths, not covered by this schema. Newer: refuse.
  throw new Error(`format version ${archive.metadata.version} is not validated by this schema`)
}
if (!validate(archive)) console.error(validate.errors)
```

The schema checks each member's shape but not the links between them. Check these separately:

- each `*BodyPath` and each claimed capture names a member that exists
- each stack frame's `file` is a `sources.json` key, when the sources channel is on and the file was under the 2 MiB cap

Tapsmith's device CI validates a real archive on every PR against both the schema and these links (`e2e/utils/trace-archive-checks.mjs`).
