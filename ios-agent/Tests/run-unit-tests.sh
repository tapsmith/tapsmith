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

xcrun swiftc -sdk "$SDK" \
  Tests/TouchPlanClockTests/main.swift \
  TapsmithAgent/TouchPlanClock.swift \
  -o "$OUT/touch-plan-clock-tests"
"$OUT/touch-plan-clock-tests"
