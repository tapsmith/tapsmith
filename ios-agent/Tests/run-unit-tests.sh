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
  Tests/LaunchAccessibilityCheckTests/main.swift \
  TapsmithAgent/LaunchAccessibilityCheck.swift \
  -o "$OUT/launch-accessibility-check-tests"
"$OUT/launch-accessibility-check-tests"

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

xcrun swiftc -sdk "$SDK" -F "$FRAMEWORKS" \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" -framework XCTest \
  Tests/CellFramesTests/main.swift \
  TapsmithAgent/CellFrames.swift \
  -o "$OUT/cell-frames-tests"
"$OUT/cell-frames-tests"

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
