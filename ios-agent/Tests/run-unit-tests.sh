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
  TapsmithAgent/RoleMapping.swift \
  TapsmithAgent/Models/AgentError.swift \
  -o "$OUT/keyboard-dismiss-planner-tests"
"$OUT/keyboard-dismiss-planner-tests"

xcrun swiftc -sdk "$SDK" \
  Tests/TouchPlanClockTests/main.swift \
  TapsmithAgent/TouchPlanClock.swift \
  -o "$OUT/touch-plan-clock-tests"
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
