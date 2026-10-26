#!/usr/bin/env bash
# Build the SwiftUI fixture app for the simulator into ./build (the path
# e2e/tapsmith.config.native-ios.mjs points at). Needs xcodegen
# (`brew install xcodegen`); the .xcodeproj is generated, not checked in.
set -euo pipefail
cd "$(dirname "$0")"
xcodegen generate --quiet
xcodebuild build \
  -project TapsmithNativeTestApp.xcodeproj \
  -scheme TapsmithNativeTestApp \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build \
  -quiet
echo "Built: $(pwd)/build/Build/Products/Release-iphonesimulator/TapsmithNativeTestApp.app"
