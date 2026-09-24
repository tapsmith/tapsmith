/**
 * Content checks for a trace archive recorded against a real device.
 *
 * Split from `verify-trace-archive.mjs` (which drives the traced run) so the
 * checks themselves are unit-testable without a device — see
 * `__tests__/trace-archive-checks.test.mjs`. A check that can never fail is
 * worse than no check, so the ones that depend on the trace containing
 * particular material assert that they found material to work with.
 */

import * as fs from "node:fs"
import { unzipSync } from "fflate"
import { Ajv2020 } from "ajv/dist/2020.js"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Smallest plausible real device screen edge, in pixels. */
const MIN_SCREEN_EDGE = 200

/**
 * The published format contract (PILOT-331). Read from the monorepo rather
 * than the installed package so `--verify-only` against a downloaded CI
 * artifact checks the schema of the checkout it runs in.
 */
const SCHEMA = JSON.parse(
  fs.readFileSync(new URL("../../packages/tapsmith/schema/trace-format.schema.json", import.meta.url), "utf8"),
)
/** The format version the schema describes, i.e. the one the packager writes. */
const FORMAT_VERSION = SCHEMA.$defs.metadata.properties.version.const
const validateArchive = new Ajv2020({ allErrors: true, strict: true }).compile(SCHEMA)

// ─── Archive reading ───

/** Parse a trace archive into the shape the checks below work on. */
export function readArchive(zipPath) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)))
  const text = (name) => new TextDecoder().decode(files[name])
  const ndjson = (name) =>
    files[name] ? text(name).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  const events = ndjson("trace.json")
  return {
    files,
    members: Object.keys(files).sort(),
    metadata: files["metadata.json"] ? JSON.parse(text("metadata.json")) : {},
    events,
    // Actions and assertions both occupy a slot in the action-index space and
    // can own captures.
    steps: events.filter((e) => e.type === "action" || e.type === "assertion"),
    network: ndjson("network.json"),
    sources: files["sources.json"] ? JSON.parse(text("sources.json")) : {},
  }
}

/** Width/height from a PNG's IHDR chunk, or null if it isn't a PNG. */
function pngSize(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * The human-readable name a selector matched on, if it has one that should
 * appear verbatim in a hierarchy dump. Returns null otherwise.
 */
function selectorName(serialized) {
  if (typeof serialized !== "string") return null
  let selector
  try {
    selector = JSON.parse(serialized)
  } catch {
    return null
  }
  const candidate =
    selector.text ??
    selector.textContains ??
    selector.contentDesc ??
    selector.label ??
    selector.hint ??
    selector.role?.name
  return typeof candidate === "string" && candidate.length >= 3 ? candidate : null
}

/**
 * Undo XML attribute escaping so a selector name can be matched literally.
 *
 * Both agents escape attribute values (`ios-agent/.../HierarchyDumper.swift`,
 * and UIAutomator's own serializer on Android) but not identically — iOS emits
 * `&apos;` where a serializer may emit `&#39;` or nothing at all. Unescaping the
 * dump rather than escaping the needle is therefore the portable direction: a
 * label like `Save & Exit` or `Don't` matches whichever entity form the
 * platform chose.
 */
function unescapeXml(xml) {
  return xml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&amp;/g, "&")
}

const pad = (index) => String(index).padStart(3, "0")
const screenshotMember = (index) => `screenshots/action-${pad(index)}-before.png`
const hierarchyMember = (index) => `hierarchy/action-${pad(index)}-before.xml`

// ─── Checks ───

/** Collects failures and notes so one run reports every problem, not just the first. */
class Report {
  failures = []
  notes = []

  check(ok, message, detail) {
    if (ok) return true
    this.failures.push(detail ? `${message}\n      ${detail}` : message)
    return false
  }

  note(message) {
    this.notes.push(message)
  }
}

function checkMetadata(archive, r) {
  const m = archive.metadata
  r.check(m.version === FORMAT_VERSION, `metadata.version should be ${FORMAT_VERSION}, got ${m.version}`)
  r.check(m.testStatus === "passed", `metadata.testStatus should be "passed", got "${m.testStatus}"`)
  r.check(!!m.testName, "metadata.testName is empty")
  r.check(!!m.tapsmithVersion, "metadata.tapsmithVersion is empty")
  r.check(m.actionCount > 0, `metadata.actionCount should be > 0, got ${m.actionCount}`)
  r.check(
    Number.isFinite(m.startTime) && Number.isFinite(m.endTime) && m.endTime >= m.startTime,
    `metadata timestamps are not a valid range: ${m.startTime} → ${m.endTime}`,
  )

  // Device identity has to come off the real device, not the placeholder the
  // runner falls back to when it has no serial.
  r.check(
    !!m.device?.serial && m.device.serial !== "unknown",
    `metadata.device.serial should name the device under test, got "${m.device?.serial}"`,
  )
  // Enrichment comes from a `listDevices` lookup; which fields a platform
  // fills in varies, so require that it resolved *something* rather than
  // pinning a field the daemon may not report for a given target.
  r.check(
    !!m.device?.osVersion || !!m.device?.model,
    "metadata.device has neither model nor osVersion — device enrichment resolved nothing",
  )
  r.note(
    `device: ${m.device?.serial} (${m.device?.model ?? "unknown model"}, ` +
      `os ${m.device?.osVersion ?? "?"}${m.device?.isEmulator ? ", emulator" : ""})`,
  )

  // Without these the checks below would pass on an archive that recorded
  // nothing at all.
  for (const channel of ["screenshots", "snapshots", "network"]) {
    r.check(
      m.traceConfig?.[channel] === true,
      `trace.${channel} was not enabled — the run did not record what these checks verify`,
    )
  }
}

/**
 * Where the runner's terminal-state captures live in an archive's index space.
 *
 * Actions and assertions share one counter filled from 0, and the runner adds a
 * capture one slot past the last step so the viewer has an "after" view for it
 * (it reads the *next* step's before-shot as a step's "after").
 *
 * An `afterAll` hook complicates this: by the time it runs the last test's
 * trace is already packaged, so `appendEventsToTrace` appends the hook's events
 * at `readTraceActionCount(...) + 1` (runner.ts) — the `+ 1` deliberately steps
 * over that terminal slot, leaving a one-slot gap mid-stream. So an archive has
 * a terminal capture at the gap when hook events were appended, and one past
 * the end otherwise; both are legitimate and neither is a hole to complain
 * about.
 */
function stepIndexGaps(steps) {
  const indices = steps.map((s) => s.actionIndex)
  const gaps = []
  for (let i = 1; i < indices.length; i++) {
    for (let missing = indices[i - 1] + 1; missing < indices[i]; missing++) gaps.push(missing)
  }
  return { gaps, trailing: indices.length > 0 ? indices[indices.length - 1] + 1 : 0 }
}

/**
 * The one slot a terminal capture may occupy: the skipped slot when an
 * `afterAll` amendment left a gap, otherwise one past the last step. Never
 * both — the afterAll path appends hook captures but takes no terminal capture
 * of its own, so nothing sits past the last step once a gap exists.
 */
function terminalCaptureIndex(steps) {
  const { gaps, trailing } = stepIndexGaps(steps)
  return gaps.length > 0 ? gaps[0] : trailing
}

function checkEventStream(archive, r) {
  const { steps, metadata } = archive
  if (!r.check(steps.length > 0, "trace.json contains no action or assertion events")) return

  // One index space, filled from 0 and strictly increasing.
  const indices = steps.map((s) => s.actionIndex)
  r.check(indices[0] === 0, `the first step is at index ${indices[0]}, not 0`)
  const notAscending = indices.findIndex((v, i) => i > 0 && v <= indices[i - 1])
  r.check(
    notAscending === -1,
    "step indices are not strictly increasing",
    `got [${indices.join(", ")}]`,
  )

  // At most one hole, exactly one slot wide: the terminal slot an afterAll
  // amendment steps over. Anything else is a lost or mis-indexed step.
  const { gaps, trailing } = stepIndexGaps(steps)
  r.check(
    gaps.length <= 1,
    `step indices have ${gaps.length} missing slots (at ${gaps.join(", ")}); at most one is ` +
      "legitimate (the terminal-capture slot an afterAll amendment skips)",
  )

  // The packager reports the size of the index space, not the step count — the
  // two differ by exactly the skipped slot once hook events are appended.
  r.check(
    metadata.actionCount === trailing,
    `metadata.actionCount (${metadata.actionCount}) should be one past the last step index ` +
      `(${trailing - 1}), i.e. ${trailing}`,
  )

  const outOfOrder = steps.findIndex((s, i) => i > 0 && s.timestamp < steps[i - 1].timestamp)
  r.check(outOfOrder === -1, `step ${outOfOrder} has a timestamp before its predecessor`)

  r.check(
    steps.some((s) => s.type === "action" && s.success),
    "no successful action was recorded",
  )
  r.note(
    `${steps.length} steps: ${steps.filter((s) => s.type === "action").length} actions, ` +
      `${steps.filter((s) => s.type === "assertion").length} assertions`,
  )
}

function checkScreenshots(archive, r) {
  // Every check below is derived from the steps. With none, checkEventStream
  // owns the diagnosis — demanding action-000 captures on top of it would bury
  // the real one under two misleading failures.
  if (archive.steps.length === 0) return
  const members = Object.keys(archive.files).filter((f) => f.startsWith("screenshots/")).sort()
  if (!r.check(members.length > 0, "the archive contains no screenshots")) return

  // Positive material, the counterpart to `verifiedPairings > 0` for hierarchy
  // and `entries.length > 0` for network. Every check below is claim-driven, so
  // if per-step captures stopped being recorded altogether — the pre-action
  // gate or the `hasScreenshotBefore` wiring regressing — each one would skip
  // and the terminal capture alone would satisfy the rest. Not every step
  // claims one by design (the runner's app reset passes skipBeforeCapture), so
  // this asserts "some", not "all".
  r.check(
    archive.steps.some((s) => s.hasScreenshotBefore),
    "no step recorded a before-screenshot — per-action capture is not running at all",
  )

  for (const step of archive.steps) {
    if (!step.hasScreenshotBefore) continue
    r.check(
      screenshotMember(step.actionIndex) in archive.files,
      `step ${step.actionIndex} (${step.action ?? step.assertion}) claims a screenshot but ` +
        `${screenshotMember(step.actionIndex)} is missing`,
    )
  }

  // Nothing stored that no step claims — except the terminal-state captures,
  // which sit in a slot no step occupies (see terminalCaptureIndex).
  const claimIndex = new Map(archive.steps.map((s) => [s.actionIndex, !!s.hasScreenshotBefore]))
  // Exactly one slot is exempt, not both candidates: the afterAll path appends
  // hook events and their captures but takes no terminal capture of its own
  // (runner.ts ends the hook group, flushes, appends — no captureBeforeAction),
  // so once a gap exists nothing legitimately sits past the last step.
  const expectedTerminal = terminalCaptureIndex(archive.steps)
  const unclaimed = members.filter((member) => {
    const index = Number(/action-(\d+)-/.exec(member)?.[1])
    return index !== expectedTerminal && !claimIndex.get(index)
  })
  r.check(unclaimed.length === 0, `screenshot members no step claims: ${unclaimed.join(", ")}`)

  // The terminal capture is not optional: the viewer reads the *next* step's
  // before-shot as a step's "after" view, so without it the last step has no
  // after view at all. The runner takes it whenever the screenshots channel is
  // on (which checkMetadata already required), best-effort — so a missing one
  // means the capture RPC failed and the run reported success anyway.
  r.check(
    screenshotMember(expectedTerminal) in archive.files,
    `no terminal-state screenshot: ${screenshotMember(expectedTerminal)} is missing, ` +
      "so the last step has no \"after\" view",
  )

  // screenshotCount is what the viewer and `tapsmith_read_trace` report. The
  // packager skips a capture whose temp file it cannot read, so a count above
  // the members present is silent data loss.
  r.check(
    archive.metadata.screenshotCount === members.length,
    `metadata.screenshotCount (${archive.metadata.screenshotCount}) does not match the ` +
      `${members.length} screenshot member(s) in the archive`,
  )

  // Real frames: decodable PNGs, all at one plausible screen size.
  const sizes = new Set()
  const digests = new Set()
  for (const member of members) {
    const size = pngSize(archive.files[member])
    if (!r.check(size !== null, `${member} is not a PNG`)) continue
    r.check(
      size.width >= MIN_SCREEN_EDGE && size.height >= MIN_SCREEN_EDGE,
      `${member} is ${size.width}x${size.height} — too small to be a device screenshot`,
    )
    sizes.add(`${size.width}x${size.height}`)
    digests.add(Buffer.from(archive.files[member]).toString("base64"))
  }
  r.check(sizes.size <= 1, `screenshots disagree on screen size: ${[...sizes].join(", ")}`)
  // The driven test navigates, taps, and renders a response, so the captures
  // cannot all be the same frame — that would mean stale or cached captures.
  r.check(
    members.length < 2 || digests.size > 1,
    `all ${members.length} screenshots are byte-identical — captures are not tracking the screen`,
  )
  r.note(
    `${members.length} screenshots at ${[...sizes].join(", ") || "no size"}, ${digests.size} distinct`,
  )

  // Element bounds are recorded in logical points and screenshots in pixels,
  // so a box must fit inside the frame at any device pixel ratio. A degenerate
  // or out-of-frame box means the two coordinate spaces disagree.
  const [frame] = [...sizes]
  if (!frame) return
  const [frameWidth, frameHeight] = frame.split("x").map(Number)
  let checkedBoxes = 0
  for (const step of archive.steps) {
    const b = step.bounds
    if (!b) continue
    checkedBoxes++
    r.check(
      b.right > b.left && b.bottom > b.top,
      `step ${step.actionIndex} recorded a degenerate element box ` +
        `[${b.left},${b.top}][${b.right},${b.bottom}]`,
    )
    // Overlap, not containment: both platforms legitimately report a negative
    // origin (or an edge past the far side) for an element the viewport clips —
    // a partially scrolled row is the common case. What cannot happen is a box
    // sitting entirely off the frame, which is what a coordinate-space mismatch
    // produces.
    r.check(
      b.right > 0 && b.bottom > 0 && b.left < frameWidth && b.top < frameHeight,
      `step ${step.actionIndex} recorded an element box with no overlap with the ${frame} ` +
        `frame: [${b.left},${b.top}][${b.right},${b.bottom}]`,
    )
  }
  r.note(`${checkedBoxes} element boxes checked against the ${frame} frame`)
}

function checkHierarchies(archive, r) {
  // See checkScreenshots: with no steps there is nothing to pair against.
  if (archive.steps.length === 0) return
  const members = Object.keys(archive.files).filter((f) => f.startsWith("hierarchy/")).sort()
  if (!r.check(members.length > 0, "the archive contains no hierarchy snapshots")) return

  // The runner's terminal-state capture takes a hierarchy dump too whenever the
  // snapshots channel is on, so the Hierarchy tab has something to show for the
  // last step. (The capture as a whole is gated on the screenshots channel;
  // checkMetadata required both.)
  const expectedTerminal = terminalCaptureIndex(archive.steps)
  r.check(
    hierarchyMember(expectedTerminal) in archive.files,
    `no terminal-state hierarchy snapshot: ${hierarchyMember(expectedTerminal)} ` +
      "is missing, so the last step has no post-action dump",
  )

  // Same unclaimed-member check the screenshots get: without it a dump filed
  // under a bogus index is invisible here while its screenshot twin is caught.
  const claimIndex = new Map(archive.steps.map((s) => [s.actionIndex, !!s.hasHierarchyBefore]))
  const unclaimed = members.filter((member) => {
    const index = Number(/action-(\d+)-/.exec(member)?.[1])
    return index !== expectedTerminal && !claimIndex.get(index)
  })
  r.check(unclaimed.length === 0, `hierarchy members no step claims: ${unclaimed.join(", ")}`)

  for (const step of archive.steps) {
    if (!step.hasHierarchyBefore) continue
    r.check(
      hierarchyMember(step.actionIndex) in archive.files,
      `step ${step.actionIndex} claims a hierarchy snapshot but ` +
        `${hierarchyMember(step.actionIndex)} is missing`,
    )
  }

  for (const member of members) {
    const xml = new TextDecoder().decode(archive.files[member])
    r.check(xml.trimStart().startsWith("<"), `${member} does not start with an XML tag`)
    // Android dumps <node …>; iOS dumps XCUIElementType* elements.
    r.check(
      /<node[\s>]/.test(xml) || /XCUIElementType/.test(xml),
      `${member} holds no recognisable UI nodes`,
      xml.slice(0, 120),
    )
    r.check(
      (xml.match(/</g) ?? []).length === (xml.match(/>/g) ?? []).length,
      `${member} has unbalanced angle brackets — the dump looks truncated`,
    )
  }

  // The strongest real-device check available: the name an action matched on
  // must be present in the snapshot filed under that action's own index. This
  // fails if captures are paired with the wrong step, or if a dump is stale for
  // the action it belongs to.
  //
  // Why the element is guaranteed to be on screen by capture time: every
  // ElementHandle action runs `_tracedResolve` (which awaits the auto-wait) to
  // completion *before* calling `_tracedAction`, and only the latter takes the
  // before-capture — so an element that appears late during its own auto-wait
  // is still present when the snapshot is taken.
  //
  // Only actions qualify. An assertion's capture is taken *before* it polls, by
  // design, so the trace shows the screen the wait started from — its target
  // legitimately may not be on screen yet.
  //
  // Deliberately not gated on `step.bounds` (which the box check above does
  // skip when absent): bounds come from a separate 100ms `findElement` lookup
  // that races the capture and can miss under load. Gating on it would let a
  // slow device silently drop the only cross-checkable action in a run, and the
  // "found nothing to cross-check" guard below would then fail the build for
  // the wrong reason.
  let verifiedPairings = 0
  for (const step of archive.steps) {
    if (step.type !== "action" || !step.hasHierarchyBefore) continue
    const needle = selectorName(step.selector)
    if (needle === null) continue
    const xml = unescapeXml(new TextDecoder().decode(
      archive.files[hierarchyMember(step.actionIndex)] ?? new Uint8Array(),
    ))
    if (
      r.check(
        xml.includes(needle),
        `action ${step.actionIndex} (${step.action}) resolved an element named "${needle}", but ` +
          `its own hierarchy snapshot (${hierarchyMember(step.actionIndex)}) does not contain it`,
      )
    ) {
      verifiedPairings++
    }
  }
  // Two very different reasons this can come up empty, and conflating them
  // sends a triager the wrong way. The driven test contributes exactly one
  // cross-checkable action, so the "its dump is missing" case is a live risk:
  // captures are best-effort with a 5s timeout, and a slow a11y dump drops the
  // claim without failing the run.
  const namedActions = archive.steps.filter(
    (s) => s.type === "action" && selectorName(s.selector) !== null,
  )
  if (namedActions.length === 0) {
    r.check(
      false,
      "no action recorded a named selector, so capture/step pairing could not be cross-checked " +
        "against real device data",
    )
  } else {
    r.check(
      verifiedPairings > 0,
      `${namedActions.length} action(s) recorded a named selector but none has a hierarchy ` +
        "snapshot to check it against — the dump likely timed out (captures are best-effort), " +
        "so pairing went unverified",
    )
  }
  r.note(
    `${members.length} hierarchy snapshots, ${verifiedPairings} cross-checked against ` +
      "their action's selector",
  )
}

function checkNetwork(archive, r, expectedHost) {
  const entries = archive.network
  if (
    !r.check(
      entries.length > 0,
      "network.json is missing or empty — the app's traffic was not captured",
    )
  ) {
    return
  }

  // Device-captured entries and API-fixture entries are merged and renumbered
  // by the runner before packaging; the body member names derive from these
  // indices, so a collision or gap would orphan a body file.
  const indices = entries.map((e) => e.index)
  r.check(
    JSON.stringify(indices) === JSON.stringify(entries.map((_, i) => i)),
    `network entry indices are not contiguous from 0: [${indices.join(", ")}]`,
  )
  for (const entry of entries) {
    r.check(
      !("requestBody" in entry) && !("responseBody" in entry),
      `network entry ${entry.index} serialized its transient body buffers into network.json`,
    )
    r.check(
      Number.isInteger(entry.actionIndex) &&
        entry.actionIndex >= 0 &&
        entry.actionIndex < Math.max(archive.metadata.actionCount, 1),
      `network entry ${entry.index} is attributed to step ${entry.actionIndex}, outside the recorded steps`,
    )
    for (const key of ["requestBodyPath", "responseBodyPath"]) {
      if (!entry[key]) continue
      r.check(
        entry[key] in archive.files,
        `network entry ${entry.index} points at ${entry[key]}, which is not in the archive`,
      )
    }
  }

  // The app's own HTTPS call must be there, with a real response — pinned to the
  // host the driven test actually calls. Accepting *any* https entry would let
  // the check that matters most pass on somebody else's traffic: `--trace on`
  // discards the config's `trace` object wholesale (see verify-trace-archive.mjs),
  // including the iOS `networkHosts` allowlist, so this run captures a strictly
  // wider set than the rest of the suite — a dev-server or system-service call
  // could stand in for the app's while its own request went missing.
  // A throw here would escape checkArchive and take every failure already
  // collected with it — the opposite of what Report is for. An entry the daemon
  // synthesized from a truncated CONNECT can carry an unparseable url, and this
  // run keeps entries the rest of the suite's allowlist filters out, so treat
  // "cannot parse" as "not the app's".
  const hostOf = (url) => {
    try {
      return new URL(url).hostname
    } catch {
      return null
    }
  }
  const fromApp = (e) =>
    typeof e.url === "string" &&
    e.url.startsWith("https://") &&
    (expectedHost === null || hostOf(e.url) === expectedHost)
  const https = entries.filter(fromApp)
  r.check(
    https.length > 0,
    `no https:// entry captured${expectedHost ? ` for ${expectedHost}` : ""}; urls were ` +
      entries.map((e) => e.url).join(", "),
  )
  const answered = https.filter((e) => e.status >= 200 && e.status < 400 && e.responseBodyPath)
  if (r.check(answered.length > 0, "no https entry captured a successful response with a body")) {
    // A captured JSON body must be stored decoded — the daemon sees gzipped,
    // chunk-framed wire bytes and the Network tab renders what is in the
    // archive.
    const jsonEntry = answered.find((e) => (e.contentType ?? "").includes("json"))
    if (jsonEntry) {
      const body = new TextDecoder().decode(archive.files[jsonEntry.responseBodyPath])
      let parsed = false
      try {
        JSON.parse(body)
        parsed = true
      } catch { /* reported below */ }
      r.check(
        parsed,
        `${jsonEntry.url} declared ${jsonEntry.contentType} but its stored body is not JSON ` +
          "(still compressed or chunk-framed?)",
        body.slice(0, 120),
      )
    }
  }
  r.note(
    `${entries.length} network entries, ${https.length} https` +
      `${expectedHost ? ` from ${expectedHost}` : ""}, ` +
      `${entries.filter((e) => e.responseBodyPath).length} with response bodies`,
  )
}

/**
 * The archive against the published format contract: the JSON Schema a
 * server-side indexer would validate an upload with, plus the
 * cross-references a schema cannot express.
 */
function checkFormat(archive, r) {
  const { members, metadata, events, network, sources } = archive
  const schemaValid = validateArchive({ members, metadata, events, network, sources })
  if (!schemaValid) {
    // One failure per violation, each naming where it is — a schema error
    // without its instance path is unactionable in a CI log.
    for (const e of validateArchive.errors ?? []) {
      // `if`/`then` wrappers repeat the real error one level up; skip them.
      if (e.keyword === "if") continue
      const params = e.params?.missingProperty ? ` ('${e.params.missingProperty}')` : ""
      r.check(false, `schema: ${e.instancePath || "/"} ${e.message}${params}`)
    }
  }

  // Structured paths name sources.json keys, so the Source tab — and an
  // indexer — can resolve every frame from the archive alone.
  if (!metadata.traceConfig?.sources) return
  const framed = archive.steps.filter((s) => Array.isArray(s.stack) && s.stack.length > 0)
  if (!r.check(framed.length > 0, "no step recorded a call stack — source attribution is not running")) return
  let resolved = 0
  for (const step of framed) {
    for (const frame of step.stack) {
      if (
        r.check(
          typeof frame.file === "string" && frame.file in sources,
          `step ${step.actionIndex} has a stack frame in ${frame.file}, which sources.json does not hold`,
        )
      ) {
        resolved++
      }
    }
  }
  r.check(
    !!metadata.testFile && metadata.testFile in sources,
    `metadata.testFile (${metadata.testFile}) is not in sources.json`,
  )
  const schemaState = schemaValid ? "schema-valid" : "schema violations (see failures)"
  r.note(`format v${metadata.version}: ${schemaState}, ${resolved} stack frames resolved to sources.json`)
}

/**
 * Run every content check against a parsed archive.
 *
 * @param archive Parsed by {@link readArchive}.
 * @param options.expectedHost Hostname the driven test calls. The network
 *   checks are pinned to it so they cannot pass on unrelated traffic; pass
 *   `null` only when the caller genuinely does not know.
 * @returns `{ failures, notes }` — `failures` empty means the archive holds
 *   everything a real-device trace should.
 */
export function checkArchive(archive, { expectedHost = null } = {}) {
  const r = new Report()
  checkMetadata(archive, r)
  checkFormat(archive, r)
  checkEventStream(archive, r)
  checkScreenshots(archive, r)
  checkHierarchies(archive, r)
  checkNetwork(archive, r, expectedHost)
  return { failures: r.failures, notes: r.notes }
}
