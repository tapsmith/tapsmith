#!/bin/bash
#
# Builds the macOS test app. Output:
#   build/Build/Products/Debug/TapsmithMacTestApp.app
#
# The generated TapsmithMacTestApp.xcodeproj is committed (like the agent
# projects), so xcodegen is only needed when project.yml changes.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d TapsmithMacTestApp.xcodeproj ]; then
    command -v xcodegen >/dev/null || { echo "xcodegen is required: brew install xcodegen" >&2; exit 1; }
    xcodegen generate
fi

xcodebuild build \
    -project TapsmithMacTestApp.xcodeproj \
    -scheme TapsmithMacTestApp \
    -destination platform=macOS \
    -derivedDataPath build
