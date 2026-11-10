#!/bin/bash
#
# Host-side unit tests for the iOS agent's pure logic (no simulator needed).
# Compiles the sources under test together with the test file against the
# macOS XCTest framework (for XCUIElement.ElementType and friends) and runs
# the result.
#
# Usage: ios-agent/Tests/run-unit-tests.sh

set -euo pipefail
cd "$(dirname "$0")/.."

SDK="$(xcrun --sdk macosx --show-sdk-path)"
FRAMEWORKS="$(xcode-select -p)/Platforms/MacOSX.platform/Developer/Library/Frameworks"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/OcclusionAnalyzerTests/main.swift \
  TapsmithAgent/OcclusionAnalyzer.swift \
  TapsmithAgent/CellFrames.swift \
  TapsmithAgent/NonAppElements.swift \
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/occlusion-analyzer-tests"
"$OUT/occlusion-analyzer-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/RoleMappingTests/main.swift \
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/role-mapping-tests"
# Several runs, each with a freshly seeded Dictionary hash: an order-dependent
# reverse map passes some runs and fails others (PILOT-365).
for _ in 1 2 3 4 5; do
  "$OUT/role-mapping-tests" > "$OUT/role-mapping.log" || { cat "$OUT/role-mapping.log"; exit 1; }
done
cat "$OUT/role-mapping.log"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/KeyboardDismissPlannerTests/main.swift \
  TapsmithAgent/KeyboardDismissPlanner.swift \
  TapsmithAgent/OcclusionAnalyzer.swift \
  TapsmithAgent/CellFrames.swift \
  TapsmithAgent/NonAppElements.swift \
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/keyboard-dismiss-planner-tests"
"$OUT/keyboard-dismiss-planner-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/TouchPlanClockTests/main.swift \
  TapsmithAgent/TouchPlanClock.swift \
  -o "$OUT/touch-plan-clock-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/TouchSettleTests/main.swift \
  TapsmithAgent/TouchSettle.swift \
  TapsmithAgent/TouchPlanClock.swift \
  -o "$OUT/touch-settle-tests"
"$OUT/touch-settle-tests"
"$OUT/touch-plan-clock-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/ScrollStepWatchTests/main.swift \
  TapsmithAgent/ScrollStepWatch.swift \
  -o "$OUT/scroll-step-watch-tests"
"$OUT/scroll-step-watch-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/IdleSettleTests/main.swift \
  TapsmithAgent/IdleSettle.swift \
  TapsmithAgent/TouchSettle.swift \
  TapsmithAgent/TouchPlanClock.swift \
  -o "$OUT/idle-settle-tests"
"$OUT/idle-settle-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/LaunchAccessibilityCheckTests/main.swift \
  TapsmithAgent/LaunchAccessibilityCheck.swift \
  -o "$OUT/launch-accessibility-check-tests"
"$OUT/launch-accessibility-check-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/LaunchGateTests/main.swift \
  TapsmithAgent/LaunchGate.swift \
  -o "$OUT/launch-gate-tests"
"$OUT/launch-gate-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/TextMatchTests/main.swift \
  TapsmithAgent/TextMatch.swift \
  -o "$OUT/text-match-tests"
"$OUT/text-match-tests" "../packages/tapsmith/src/__tests__/fixtures/regex-conformance.json"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/LabelMatchTests/main.swift \
  TapsmithAgent/LabelMatch.swift \
  TapsmithAgent/TextMatch.swift \
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/label-match-tests"
"$OUT/label-match-tests" "../packages/tapsmith/src/__tests__/fixtures/label-conformance.json"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/RoleNameTests/main.swift \
  TapsmithAgent/RoleName.swift \
  TapsmithAgent/TextMatch.swift \
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/role-name-tests"
"$OUT/role-name-tests" "../packages/tapsmith/src/__tests__/fixtures/role-conformance.json"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/TextContentTests/main.swift \
  TapsmithAgent/TextContent.swift \
  TapsmithAgent/TextMatch.swift \
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/text-content-tests"
"$OUT/text-content-tests" "../packages/tapsmith/src/__tests__/fixtures/text-content-conformance.json"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/NonAppElementsTests/main.swift \
  TapsmithAgent/NonAppElements.swift \
  -o "$OUT/non-app-elements-tests"
"$OUT/non-app-elements-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/TypingFocusTests/main.swift \
  TapsmithAgent/TypingFocus.swift \
  -o "$OUT/typing-focus-tests"
"$OUT/typing-focus-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/TypingCheckTests/main.swift \
  TapsmithAgent/TypingCheck.swift \
  -o "$OUT/typing-check-tests"
"$OUT/typing-check-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/CellFramesTests/main.swift \
  TapsmithAgent/CellFrames.swift \
  -o "$OUT/cell-frames-tests"
"$OUT/cell-frames-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/CellAccessoriesTests/main.swift \
  TapsmithAgent/CellAccessories.swift \
  TapsmithAgent/DescendantText.swift \
  TapsmithAgent/NonAppElements.swift \
  TapsmithAgent/TextContent.swift \
  TapsmithAgent/TextMatch.swift \
  -o "$OUT/cell-accessories-tests"
"$OUT/cell-accessories-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/RowAnchorTests/main.swift \
  TapsmithAgent/RowAnchor.swift \
  -o "$OUT/row-anchor-tests"
"$OUT/row-anchor-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/RowBindingTests/main.swift \
  TapsmithAgent/RowBinding.swift \
  -o "$OUT/row-binding-tests"
"$OUT/row-binding-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/LiveQueryPinTests/main.swift \
  TapsmithAgent/LiveQueryPin.swift \
  -o "$OUT/live-query-pin-tests"
"$OUT/live-query-pin-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/DoubleTapRouteTests/main.swift \
  TapsmithAgent/DoubleTapRoute.swift \
  -o "$OUT/double-tap-route-tests"
"$OUT/double-tap-route-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/PinchPlanTests/main.swift \
  TapsmithAgent/PinchPlan.swift \
  -o "$OUT/pinch-plan-tests"
"$OUT/pinch-plan-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/SwipeGeometryTests/main.swift \
  TapsmithAgent/SwipeGeometry.swift \
  -o "$OUT/swipe-geometry-tests"
"$OUT/swipe-geometry-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/TapTimingTests/main.swift \
  TapsmithAgent/TapTiming.swift \
  -o "$OUT/tap-timing-tests"
"$OUT/tap-timing-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/HidTouchTests/main.swift \
  TapsmithAgent/HidTouch.swift \
  TapsmithAgent/TapTiming.swift \
  -o "$OUT/hid-touch-tests"
"$OUT/hid-touch-tests"

# Pins XCTest's private region screenshot (the touch settle's sampler).
xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/RegionScreenshotTests/main.swift \
  TapsmithAgent/RegionScreenshot.swift \
  -o "$OUT/region-screenshot-tests"
"$OUT/region-screenshot-tests"

# Pins XCTest's private animations-idle request (every element touch's wait).
xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/AnimationsIdleTests/main.swift \
  TapsmithAgent/AnimationsIdle.swift \
  TapsmithAgent/TouchPlanClock.swift \
  -o "$OUT/animations-idle-tests"
"$OUT/animations-idle-tests"

# Pins XCTest's private open-URL request (every warm deep link's delivery).
xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/DaemonOpenURLTests/main.swift \
  TapsmithAgent/DaemonOpenURL.swift \
  -o "$OUT/daemon-open-url-tests"
"$OUT/daemon-open-url-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/DeepLinkVerifyTests/main.swift \
  TapsmithAgent/DeepLinkVerify.swift \
  -o "$OUT/deep-link-verify-tests"
"$OUT/deep-link-verify-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/RotationSettleTests/main.swift \
  TapsmithAgent/RotationSettle.swift \
  -o "$OUT/rotation-settle-tests"
"$OUT/rotation-settle-tests"

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/NavigationTransitionTests/main.swift \
  TapsmithAgent/NavigationTransition.swift \
  -o "$OUT/navigation-transition-tests"
"$OUT/navigation-transition-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/SnapshotRetryTests/main.swift \
  TapsmithAgent/SnapshotRetry.swift \
  -o "$OUT/snapshot-retry-tests"
"$OUT/snapshot-retry-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/AppReadinessTests/main.swift \
  TapsmithAgent/AppReadiness.swift \
  -o "$OUT/app-readiness-tests"
"$OUT/app-readiness-tests"

# XCTestIssueRelay needs the Objective-C exception catcher it raises into.
xcrun clang -c -fobjc-arc -isysroot "$SDK" \
  TapsmithAgent/ObjCExceptionCatcher.m \
  -o "$OUT/objc-exception-catcher.o"
xcrun swiftc -sdk "$SDK" \
  -import-objc-header TapsmithAgent/ObjCExceptionCatcher.h \
  Tests/XCTestIssueRelayTests/main.swift \
  TapsmithAgent/XCTestIssueRelay.swift \
  "$OUT/objc-exception-catcher.o" \
  -o "$OUT/xctest-issue-relay-tests"
"$OUT/xctest-issue-relay-tests"
