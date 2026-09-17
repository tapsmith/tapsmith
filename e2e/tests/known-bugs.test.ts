/**
 * Open known-bug placeholders. Each entry stays as a `.skip` test so the
 * issue ID remains visible in test output and `grep`-able in CI; flip to
 * `test()` once the underlying behavior is implemented and the assertion
 * makes sense as a real regression check.
 *
 * Bugs that have been fixed already live in `locator-regressions.test.ts`.
 */
import { describe, test } from "tapsmith"

describe("Known bugs (open)", () => {
  // ─── PILOT-134: cross-file isolation ───
  // https://samsmithyeah.atlassian.net/browse/PILOT-134
  // Tests across different files share installed-app state in some configs.
  // Not testable in a single file — exists here as a tracker so the bug
  // doesn't disappear from the suite.
  test.skip("PILOT-134: cross-file test isolation", () => {})

  // ─── PILOT-135: tap() should auto-scroll off-screen targets ───
  // https://samsmithyeah.atlassian.net/browse/PILOT-135
  // Today users have to call `scrollIntoView()` explicitly; Playwright
  // auto-scrolls on actionable operations like tap.
  test.skip("PILOT-135: tap() should auto-scroll to off-screen elements", () => {})

  // ─── PILOT-195: pressRecentApps() leaves launcher in foreground ───
  // https://samsmithyeah.atlassian.net/browse/PILOT-195
  // Under parallel workers, the test that runs immediately after
  // pressRecentApps() fails its session preflight because the launcher is
  // foregrounded. Tracked as a flake in CI.
  test.skip("PILOT-195: pressRecentApps() should restore the test app to foreground", () => {})
})
