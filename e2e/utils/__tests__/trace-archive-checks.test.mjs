/**
 * Tests for the trace-archive content checks used by
 * `verify-trace-archive.mjs`.
 *
 * The verifier's whole job is to fail when a real-device trace is wrong, so its
 * risk is a check that can never fire. Each case here starts from a synthetic
 * archive that passes everything, breaks exactly one thing, and asserts the
 * matching failure is reported — the same discipline as reverting a fix to
 * prove a regression test works.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as zlib from "node:zlib"
import { zipSync } from "fflate"

import { checkArchive, readArchive } from "../trace-archive-checks.mjs"

const encode = (s) => new TextEncoder().encode(s)
/** Mirrors `EXPECTED_HOST` in verify-trace-archive.mjs. */
const EXPECTED_HOST = "jsonplaceholder.typicode.com"

// ─── A synthetic archive that should pass every check ───

/** A solid-colour PNG at a plausible device resolution. */
function screenPng(rgb, width = 1080, height = 2400) {
  // One filter byte per row plus 3 bytes per pixel, all one colour, so the
  // deflate stream stays tiny even at phone resolution.
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = rgb[0]
      raw[row + 2 + x * 3] = rgb[1]
      raw[row + 3 + x * 3] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const T0 = 1_700_000_000_000
/** rootDir-relative, as a format v2 archive records every local path. */
const TEST_FILE = "tests/api-calls.test.ts"
const SCREEN_FILE = "screens/api-calls.screen.ts"

/** How both agents escape an attribute value before it reaches the dump. */
function escapeXmlAttr(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Android-shaped hierarchy dump containing the given labels, as archive bytes. */
function hierarchy(...labels) {
  const nodes = labels
    .map((l, i) => `<node index="${i}" class="android.widget.Button" text="${l}" />`)
    .join("")
  return encode(`<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${nodes}</hierarchy>`)
}

/**
 * Build a passing archive. `mutate` receives the loose parts before they are
 * zipped so a case can break exactly one thing.
 */
function buildArchive(mutate = () => {}) {
  const parts = {
    metadata: {
      version: 2,
      tapsmithVersion: "0.5.0",
      testFile: TEST_FILE,
      testName: "API Calls screen > fetches and displays user",
      testStatus: "passed",
      testDuration: 4200,
      startTime: T0,
      endTime: T0 + 4200,
      device: {
        serial: "emulator-5554",
        isEmulator: true,
        model: "sdk_gphone64_arm64",
        osVersion: "16",
      },
      traceConfig: {
        screenshots: true,
        snapshots: true,
        sources: true,
        network: true,
        deviceLogs: true,
        daemonLogs: true,
      },
      actionCount: 3,
      screenshotCount: 4,
    },
    events: [
      {
        type: "action",
        actionIndex: 0,
        timestamp: T0 + 100,
        category: "navigation",
        action: "openDeepLink",
        duration: 900,
        success: true,
        hasScreenshotBefore: true,
        hasScreenshotAfter: false,
        hasHierarchyBefore: true,
        hasHierarchyAfter: false,
        stack: [{ file: TEST_FILE, line: 6, column: 5 }],
      },
      {
        type: "assertion",
        actionIndex: 1,
        timestamp: T0 + 1100,
        assertion: "toBeVisible",
        selector: JSON.stringify({ text: "API Calls" }),
        duration: 120,
        passed: true,
        soft: false,
        negated: false,
        attempts: 1,
        hasScreenshotBefore: true,
        hasHierarchyBefore: true,
        stack: [{ file: SCREEN_FILE, line: 3 }, { file: TEST_FILE, line: 7 }],
      },
      {
        type: "action",
        actionIndex: 2,
        timestamp: T0 + 1400,
        category: "tap",
        action: "tap",
        selector: JSON.stringify({ role: { role: "button", name: "Fetch User" } }),
        bounds: { left: 40, top: 300, right: 320, bottom: 380 },
        duration: 210,
        success: true,
        hasScreenshotBefore: true,
        hasScreenshotAfter: false,
        hasHierarchyBefore: true,
        hasHierarchyAfter: false,
        stack: [{ file: TEST_FILE, line: 8 }],
      },
    ],
    sources: {
      [TEST_FILE]: "// api-calls test source\n",
      [SCREEN_FILE]: "// screen object source\n",
    },
    screenshots: {
      // Distinct frames: the screen changes as the test navigates and taps.
      "screenshots/action-000-before.png": screenPng([10, 10, 10]),
      "screenshots/action-001-before.png": screenPng([20, 20, 20]),
      "screenshots/action-002-before.png": screenPng([30, 30, 30]),
      // Trailing terminal-state capture past the last action.
      "screenshots/action-003-before.png": screenPng([40, 40, 40]),
    },
    hierarchies: {
      "hierarchy/action-000-before.xml": hierarchy("Home"),
      "hierarchy/action-001-before.xml": hierarchy("API Calls", "Fetch User"),
      "hierarchy/action-002-before.xml": hierarchy("API Calls", "Fetch User"),
      "hierarchy/action-003-before.xml": hierarchy("API Calls", "User"),
    },
    network: [
      {
        index: 0,
        actionIndex: 2,
        startTime: T0 + 1500,
        endTime: T0 + 1900,
        method: "GET",
        url: "https://jsonplaceholder.typicode.com/users/1",
        status: 200,
        contentType: "application/json; charset=utf-8",
        requestSize: 0,
        responseSize: 220,
        duration: 400,
        responseBodyPath: "network/res-0.bin",
        requestHeaders: {},
        responseHeaders: { "content-type": "application/json" },
      },
    ],
    bodies: {
      "network/res-0.bin": encode(JSON.stringify({ id: 1, name: "Leanne Graham" })),
    },
  }

  mutate(parts)

  const files = {
    "metadata.json": encode(JSON.stringify(parts.metadata, null, 2)),
    "trace.json": encode(parts.events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
    ...parts.screenshots,
    ...parts.hierarchies,
    ...parts.bodies,
  }
  if (parts.sources) files["sources.json"] = encode(JSON.stringify(parts.sources))
  if (parts.network.length > 0) {
    files["network.json"] = encode(parts.network.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapsmith-archive-checks-"))
  const zipPath = path.join(dir, "trace.zip")
  fs.writeFileSync(zipPath, zipSync(files))
  return zipPath
}

/** Failures reported for an archive built with the given mutation. */
function failuresFor(mutate) {
  const zipPath = buildArchive(mutate)
  try {
    return checkArchive(readArchive(zipPath), { expectedHost: EXPECTED_HOST }).failures
  } finally {
    fs.rmSync(path.dirname(zipPath), { recursive: true, force: true })
  }
}

function assertFails(mutate, pattern) {
  const failures = failuresFor(mutate)
  assert.ok(
    failures.some((f) => pattern.test(f)),
    `expected a failure matching ${pattern}\ngot:\n${failures.map((f) => `  - ${f}`).join("\n") || "  (none)"}`,
  )
}

// ─── The baseline has to pass, or nothing below proves anything ───

test("a well-formed real-device archive passes every check", () => {
  const zipPath = buildArchive()
  try {
    const { failures, notes } = checkArchive(readArchive(zipPath), { expectedHost: EXPECTED_HOST })
    assert.deepEqual(failures, [])
    // The checks that could silently no-op must report they found material.
    assert.ok(notes.some((n) => /1 cross-checked/.test(n)), notes.join("\n"))
    assert.ok(notes.some((n) => /1 element boxes checked/.test(n)), notes.join("\n"))
    assert.ok(notes.some((n) => /4 screenshots at 1080x2400, 4 distinct/.test(n)), notes.join("\n"))
    assert.ok(notes.some((n) => /format v2: schema-valid, 4 stack frames resolved/.test(n)), notes.join("\n"))
  } finally {
    fs.rmSync(path.dirname(zipPath), { recursive: true, force: true })
  }
})

// ─── metadata ───

test("catches a trace recorded with a sub-channel disabled", () => {
  assertFails((p) => { p.metadata.traceConfig.network = false }, /trace\.network was not enabled/)
  assertFails((p) => { p.metadata.traceConfig.snapshots = false }, /trace\.snapshots was not enabled/)
})

test("catches an unresolved device identity", () => {
  assertFails((p) => { p.metadata.device.serial = "unknown" }, /device\.serial should name the device/)
  assertFails((p) => {
    delete p.metadata.device.osVersion
    delete p.metadata.device.model
  }, /neither model nor osVersion/)
})

test("catches a failed or empty test being passed off as verified", () => {
  assertFails((p) => { p.metadata.testStatus = "failed" }, /testStatus should be "passed"/)
  assertFails((p) => { p.metadata.actionCount = 0 }, /actionCount should be > 0/)
})

// ─── format contract (PILOT-331) ───

test("catches an archive in a format version other than the one the schema describes", () => {
  assertFails((p) => { p.metadata.version = 1 }, /metadata\.version should be 2, got 1/)
  assertFails((p) => { p.metadata.version = 3 }, /metadata\.version should be 2, got 3/)
})

test("reports each schema violation with the path that broke it", () => {
  assertFails(
    (p) => { p.metadata.testFile = "/home/runner/work/tapsmith/e2e/tests/api-calls.test.ts" },
    /schema: \/metadata\/testFile /,
  )
  assertFails((p) => { delete p.events[0].hasScreenshotAfter }, /schema: \/events\/0 .*hasScreenshotAfter/)
  assertFails((p) => { delete p.network[0].url }, /schema: \/network\/0 .*'url'/)
  assertFails((p) => { p.events[1].stack[0].file = "C:/work/screens/api-calls.screen.ts" }, /schema: \/events\/1\/stack\/0\/file /)
})

test("does not claim the archive is schema-valid when it is not", () => {
  // The note is what a triager reads next to the failures in a CI log.
  const zipPath = buildArchive((p) => { delete p.network[0].url })
  try {
    const { failures, notes } = checkArchive(readArchive(zipPath), { expectedHost: EXPECTED_HOST })
    assert.ok(failures.some((f) => /^schema: /.test(f)), failures.join("\n"))
    assert.ok(!notes.some((n) => /schema-valid/.test(n)), notes.join("\n"))
    assert.ok(notes.some((n) => /schema violations/.test(n)), notes.join("\n"))
  } finally {
    fs.rmSync(path.dirname(zipPath), { recursive: true, force: true })
  }
})

test("catches a member that would escape the archive root when extracted", () => {
  assertFails((p) => { p.bodies["network/../../escape.bin"] = encode("x") }, /schema: \/members\/\d+ /)
})

test("catches a stack frame whose file sources.json does not hold", () => {
  assertFails(
    (p) => { delete p.sources[SCREEN_FILE] },
    /step 1 has a stack frame in screens\/api-calls\.screen\.ts, which sources\.json does not hold/,
  )
})

test("catches a test file sources.json does not hold", () => {
  assertFails((p) => { delete p.sources[TEST_FILE] }, /metadata\.testFile \(tests\/api-calls\.test\.ts\) is not in sources\.json/)
})

test("catches a trace whose steps recorded no call stacks at all", () => {
  // The frame/sources cross-check is claim-driven, so without this it would
  // pass vacuously if stack capture stopped working.
  assertFails((p) => { for (const e of p.events) delete e.stack }, /no step recorded a call stack/)
})

// ─── event stream ───

test("catches a gap wider than the one slot an afterAll amendment skips", () => {
  assertFails((p) => {
    p.events[2].actionIndex = 5
    p.metadata.actionCount = 6
  }, /step indices have 3 missing slots \(at 2, 3, 4\)/)
})

test("catches steps that do not start at 0 or do not ascend", () => {
  assertFails((p) => { for (const e of p.events) e.actionIndex += 1 }, /first step is at index 1, not 0/)
  assertFails((p) => { p.events[2].actionIndex = 1 }, /not strictly increasing/)
})

test("catches actionCount that is not one past the last step index", () => {
  assertFails((p) => { p.metadata.actionCount = 9 }, /actionCount \(9\) should be one past the last step index \(2\), i\.e\. 3/)
})

/** The extra hook step an `afterAll` amendment appends, past the skipped slot. */
function appendHookStep(p) {
  p.events.push({
    type: "action",
    actionIndex: 4, // 3 is the terminal-capture slot the amendment steps over
    timestamp: T0 + 4000,
    category: "device",
    action: "clearAppData",
    duration: 300,
    success: true,
    hasScreenshotBefore: true,
    hasScreenshotAfter: false,
    hasHierarchyBefore: true,
    hasHierarchyAfter: false,
  })
  p.metadata.actionCount = 5
  p.screenshots["screenshots/action-004-before.png"] = screenPng([60, 60, 60])
  p.hierarchies["hierarchy/action-004-before.xml"] = hierarchy("Home")
  p.metadata.screenshotCount = 5
}

test("tolerates the one-slot gap an afterAll amendment leaves", () => {
  // `appendEventsToTrace` appends hook events at `readTraceActionCount() + 1`,
  // stepping over the terminal-capture slot — so a correct archive for a file
  // with an afterAll hook has a hole at the old actionCount, the terminal
  // capture sitting in it, and actionCount one past the appended events.
  assert.deepEqual(failuresFor(appendHookStep), [])
})

test("rejects a capture in the trailing slot once an afterAll gap exists", () => {
  // Steps 0,1,2 then a gap at 3 then 4 — the terminal capture belongs in 3.
  // The afterAll path appends hook captures but takes no terminal capture of
  // its own, so nothing legitimately sits at 5.
  assertFails((p) => {
    appendHookStep(p)
    p.screenshots["screenshots/action-005-before.png"] = screenPng([70, 70, 70])
    p.metadata.screenshotCount = 6
  }, /screenshot members no step claims: screenshots\/action-005-before\.png/)

  assertFails((p) => {
    appendHookStep(p)
    p.hierarchies["hierarchy/action-005-before.xml"] = hierarchy("Ghost")
  }, /hierarchy members no step claims: hierarchy\/action-005-before\.xml/)
})

test("still requires the terminal capture in the slot the gap marks", () => {
  assertFails((p) => {
    appendHookStep(p)
    delete p.screenshots["screenshots/action-003-before.png"]
    p.metadata.screenshotCount = 4
  }, /no terminal-state screenshot: screenshots\/action-003-before\.png is missing/)
})

test("catches steps recorded out of chronological order", () => {
  assertFails((p) => { p.events[2].timestamp = T0 }, /timestamp before its predecessor/)
})

// ─── screenshots ───

test("catches a claimed screenshot with no member behind it", () => {
  assertFails(
    (p) => { delete p.screenshots["screenshots/action-002-before.png"] },
    /step 2 \(tap\) claims a screenshot but screenshots\/action-002-before\.png is missing/,
  )
})

test("catches per-action screenshot capture having stopped entirely", () => {
  // Every screenshot check is claim-driven, so if no step claims one they all
  // skip and the terminal capture alone would satisfy the rest.
  assertFails((p) => {
    for (const e of p.events) e.hasScreenshotBefore = false
    p.screenshots = { "screenshots/action-003-before.png": screenPng([10, 10, 10]) }
    p.metadata.screenshotCount = 1
  }, /no step recorded a before-screenshot — per-action capture is not running at all/)
})

test("tolerates a step that legitimately claims no screenshot", () => {
  // The runner's app reset passes skipBeforeCapture, so "some" is the invariant,
  // not "all".
  assert.deepEqual(
    failuresFor((p) => {
      p.events[0].hasScreenshotBefore = false
      p.events[0].hasHierarchyBefore = false
      delete p.screenshots["screenshots/action-000-before.png"]
      delete p.hierarchies["hierarchy/action-000-before.xml"]
      p.metadata.screenshotCount = 3
    }),
    [],
  )
})

test("distinguishes a missing dump from a missing named selector", () => {
  // Named selector present but its dump absent — the capture timed out.
  assertFails((p) => {
    p.events[2].hasHierarchyBefore = false
    delete p.hierarchies["hierarchy/action-002-before.xml"]
  }, /1 action\(s\) recorded a named selector but none has a hierarchy snapshot/)

  // No named selector at all — a different diagnosis.
  assertFails(
    (p) => { delete p.events[2].selector },
    /no action recorded a named selector/,
  )
})

test("catches a screenshot member no step claims", () => {
  assertFails(
    (p) => { p.screenshots["screenshots/action-007-before.png"] = screenPng([9, 9, 9]) },
    /screenshot members no step claims: screenshots\/action-007-before\.png/,
  )
})

test("catches a missing terminal-state screenshot", () => {
  // The viewer reads the next step's before-shot as a step's "after" view, so
  // dropping the trailing capture leaves the last step with no after view.
  assertFails((p) => {
    delete p.screenshots["screenshots/action-003-before.png"]
    p.metadata.screenshotCount = 3
  }, /no terminal-state screenshot: screenshots\/action-003-before\.png is missing/)
})

test("catches screenshotCount disagreeing with the members present", () => {
  // What the packager skips on an unreadable temp file, it still counts.
  assertFails((p) => { p.metadata.screenshotCount = 0 }, /screenshotCount \(0\) does not match the 4 screenshot member/)
})

test("catches a missing terminal-state hierarchy snapshot", () => {
  assertFails(
    (p) => { delete p.hierarchies["hierarchy/action-003-before.xml"] },
    /no terminal-state hierarchy snapshot: hierarchy\/action-003-before\.xml is missing/,
  )
})

test("catches captures that are not decodable images", () => {
  assertFails(
    (p) => { p.screenshots["screenshots/action-001-before.png"] = encode("not a png") },
    /screenshots\/action-001-before\.png is not a PNG/,
  )
})

test("catches a placeholder-sized capture", () => {
  assertFails(
    (p) => { p.screenshots["screenshots/action-001-before.png"] = screenPng([1, 1, 1], 1, 1) },
    /is 1x1 — too small to be a device screenshot/,
  )
})

test("catches captures that disagree on the screen size", () => {
  assertFails(
    (p) => { p.screenshots["screenshots/action-001-before.png"] = screenPng([2, 2, 2], 720, 1280) },
    /screenshots disagree on screen size/,
  )
})

test("catches a run where every capture is the same frame", () => {
  assertFails((p) => {
    const frame = screenPng([50, 50, 50])
    for (const key of Object.keys(p.screenshots)) p.screenshots[key] = frame
  }, /screenshots are byte-identical/)
})

test("catches an element box with no overlap with the captured frame", () => {
  assertFails(
    (p) => { p.events[2].bounds = { left: 2000, top: 300, right: 3000, bottom: 380 } },
    /no overlap with the 1080x2400 frame/,
  )
  assertFails(
    (p) => { p.events[2].bounds = { left: 40, top: 300, right: 40, bottom: 300 } },
    /degenerate element box/,
  )
})

test("tolerates a clipped element box that runs off the frame edge", () => {
  // Both platforms report a negative origin for a partially scrolled row; that
  // is not a coordinate-space bug.
  assert.deepEqual(
    failuresFor((p) => { p.events[2].bounds = { left: -20, top: -40, right: 320, bottom: 80 } }),
    [],
  )
})

// ─── hierarchy snapshots ───

test("catches a claimed hierarchy snapshot with no member behind it", () => {
  assertFails(
    (p) => { delete p.hierarchies["hierarchy/action-001-before.xml"] },
    /step 1 claims a hierarchy snapshot but hierarchy\/action-001-before\.xml is missing/,
  )
})

test("catches a dump with no UI nodes in it", () => {
  assertFails(
    (p) => { p.hierarchies["hierarchy/action-000-before.xml"] = encode("<hierarchy></hierarchy>") },
    /holds no recognisable UI nodes/,
  )
})

test("catches a truncated dump", () => {
  assertFails((p) => {
    const xml = new TextDecoder().decode(p.hierarchies["hierarchy/action-000-before.xml"])
    // Cut mid-tag, the way a dropped read truncates a dump.
    p.hierarchies["hierarchy/action-000-before.xml"] = encode(xml.slice(0, xml.length - 6))
  }, /unbalanced angle brackets/)
})

test("catches a snapshot paired with the wrong action", () => {
  // Action 2 tapped "Fetch User"; give its slot the snapshot from before the
  // screen was reached, as a mis-indexed capture would.
  assertFails(
    (p) => { p.hierarchies["hierarchy/action-002-before.xml"] = hierarchy("Home") },
    /action 2 \(tap\) resolved an element named "Fetch User", but its own hierarchy snapshot/,
  )
})

test("matches a selector name through the dump's XML escaping", () => {
  // Agents escape attribute values, and not identically (iOS emits &apos;,
  // serializers may emit &#39;). A label with a quotable character must still
  // match, or the verifier cries wolf on a correct trace.
  for (const label of ["Save & Exit", "Don't", 'The "Best" <One>']) {
    assert.deepEqual(
      failuresFor((p) => {
        p.events[2].selector = JSON.stringify({ role: { role: "button", name: label } })
        p.hierarchies["hierarchy/action-002-before.xml"] = hierarchy(escapeXmlAttr(label))
      }),
      [],
      `label ${label} should match its escaped dump`,
    )
  }
})

test("catches a hierarchy member no step claims", () => {
  assertFails(
    (p) => { p.hierarchies["hierarchy/action-009-before.xml"] = hierarchy("Ghost") },
    /hierarchy members no step claims: hierarchy\/action-009-before\.xml/,
  )
})

test("reports when no action had a named selector to cross-check", () => {
  assertFails((p) => { delete p.events[2].selector }, /capture\/step pairing could not be cross-checked/)
})

test("does not cross-check an auto-waiting assertion against its own snapshot", () => {
  // An assertion captures before it polls, so its target may legitimately be
  // absent from its snapshot. Only the action's pairing is enforced.
  const failures = failuresFor((p) => {
    p.hierarchies["hierarchy/action-001-before.xml"] = hierarchy("Fetch User")
  })
  assert.deepEqual(failures, [])
})

// ─── network ───

test("does not abandon the report when an entry's url will not parse", () => {
  // A throw out of checkArchive would lose every failure collected so far.
  const failures = failuresFor((p) => {
    p.network[0].url = "https://"
    p.metadata.testStatus = "failed"
  })
  assert.ok(
    failures.some((f) => /testStatus should be "passed"/.test(f)),
    `earlier failures must survive an unparseable url; got:\n${failures.join("\n")}`,
  )
  assert.ok(failures.some((f) => /no https:\/\/ entry captured for/.test(f)), failures.join("\n"))
})

test("reports only the real diagnosis for an archive with no steps", () => {
  // A trace whose event log failed to write but which still carries capture
  // members: every capture check is derived from the steps, so with none it has
  // nothing to say and must not invent a terminal-capture failure at index 0
  // on top of the real "no events" diagnosis.
  const failures = failuresFor((p) => {
    p.events = []
    p.metadata.actionCount = 0
    p.screenshots = { "screenshots/action-002-before.png": screenPng([10, 10, 10]) }
    p.hierarchies = { "hierarchy/action-002-before.xml": hierarchy("Home") }
    p.metadata.screenshotCount = 1
  })
  assert.ok(failures.some((f) => /contains no action or assertion events/.test(f)), failures.join("\n"))
  assert.deepEqual(failures.filter((f) => /no terminal-state/.test(f)), [], failures.join("\n"))
  assert.deepEqual(failures.filter((f) => /no step claims/.test(f)), [], failures.join("\n"))
})

test("catches traffic that was never captured", () => {
  assertFails((p) => { p.network = []; p.bodies = {} }, /network\.json is missing or empty/)
})

test("catches transient body buffers leaking into network.json", () => {
  assertFails(
    (p) => { p.network[0].responseBody = { type: "Buffer", data: [1, 2, 3] } },
    /serialized its transient body buffers/,
  )
})

test("catches an entry pointing at a body that is not in the archive", () => {
  assertFails((p) => { p.bodies = {} }, /points at network\/res-0\.bin, which is not in the archive/)
})

test("catches an entry attributed to a step that does not exist", () => {
  assertFails((p) => { p.network[0].actionIndex = 42 }, /attributed to step 42, outside the recorded steps/)
})

test("catches a response body stored still compressed", () => {
  assertFails(
    (p) => { p.bodies["network/res-0.bin"] = zlib.gzipSync(Buffer.from('{"id":1}')) },
    /is not JSON \(still compressed or chunk-framed\?\)/,
  )
})

test("catches a capture session that saw no https traffic", () => {
  assertFails((p) => {
    p.network[0].url = "http://127.0.0.1:8081/symbolicate"
  }, /no https:\/\/ entry captured for jsonplaceholder\.typicode\.com/)
})

test("will not accept another host's https traffic in place of the app's", () => {
  // `--trace on` drops the config's networkHosts allowlist, so this run sees
  // more than the app's own requests. An unrelated https entry must not stand
  // in for the request the driven test actually makes.
  assertFails((p) => {
    p.network[0].url = "https://registry.example.com/v1/ping"
  }, /no https:\/\/ entry captured for jsonplaceholder\.typicode\.com/)
})

test("ignores an unrelated json entry when judging the app's response body", () => {
  // A foreign entry with an undecodable body must not fail the run: only the
  // app's own response is judged.
  assert.deepEqual(
    failuresFor((p) => {
      // Ordered *before* the app's entry, which is where an unfiltered
      // `.find(contentType includes json)` would pick it up.
      p.network.unshift({
        index: 0,
        actionIndex: 2,
        startTime: T0 + 1500,
        endTime: T0 + 1600,
        method: "GET",
        url: "https://metro.example.com/status",
        status: 200,
        contentType: "application/json",
        requestSize: 0,
        responseSize: 4,
        duration: 100,
        responseBodyPath: "network/res-9.bin",
        requestHeaders: {},
        responseHeaders: {},
      })
      // Not JSON, and not an encoding decodeHttpBody handles (zstd) — the
      // foreign-entry case that would fail the run on a correct archive.
      p.bodies["network/res-9.bin"] = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      // Re-number so the entries stay contiguous, as the packager guarantees.
      p.network.forEach((e, i) => { e.index = i })
    }),
    [],
  )
})
