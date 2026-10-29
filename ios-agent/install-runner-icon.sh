#!/bin/bash
#
# Gives the simulator XCUITest runner (TapsmithAgentUITests-Runner.app) the
# Tapsmith icon.
#
# Xcode builds the runner from its own XCTRunner template and writes the
# runner's Info.plist after every build phase of the test target, so the
# AppIcon in TapsmithAgent/Assets.xcassets only reaches the .xctest bundle.
# This copies the compiled icon and its CFBundleIcons keys from the .xctest
# into the runner. Run it after `xcodebuild build-for-testing`.
#
# Simulator builds only: the runner is unsigned there. A signed device runner
# would need re-signing after this, so device builds keep Xcode's blank icon.
#
# Usage:
#   ios-agent/install-runner-icon.sh <Build/Products/Debug-iphonesimulator>

set -euo pipefail

PRODUCTS="${1:?usage: install-runner-icon.sh <Build/Products/Debug-iphonesimulator>}"
RUNNER="$PRODUCTS/TapsmithAgentUITests-Runner.app"
XCTEST="$RUNNER/PlugIns/TapsmithAgentUITests.xctest"

for f in "$RUNNER/Info.plist" "$XCTEST/Info.plist" "$XCTEST/Assets.car"; do
    if [ ! -f "$f" ]; then
        echo "install-runner-icon: $f not found" >&2
        exit 1
    fi
done

cp "$XCTEST/Assets.car" "$RUNNER/"
cp "$XCTEST"/AppIcon*.png "$RUNNER/"
for key in CFBundleIcons 'CFBundleIcons~ipad'; do
    if value="$(plutil -extract "$key" xml1 -o - "$XCTEST/Info.plist" 2>/dev/null)"; then
        plutil -replace "$key" -xml "$value" "$RUNNER/Info.plist"
    fi
done
