#!/bin/bash
#
# Creates the TapsmithAgent Xcode project for building the XCUITest bundle.
#
# The project structure:
#   TapsmithAgent.xcodeproj/
#     - TapsmithAgentUITests target (XCUITest bundle)
#     - Links to XCTest framework
#     - All Swift source files in TapsmithAgent/
#
# Usage:
#   cd ios-agent && ./create-xcode-project.sh
#   xcodebuild build-for-testing -project TapsmithAgent.xcodeproj -scheme TapsmithAgentUITests \
#     -destination 'platform=iOS Simulator,name=iPhone 16'

set -euo pipefail
cd "$(dirname "$0")"

PROJECT_DIR="TapsmithAgent.xcodeproj"

# If the project already exists, skip
if [ -d "$PROJECT_DIR" ]; then
    echo "Xcode project already exists at $PROJECT_DIR"
    exit 0
fi

echo "Generating TapsmithAgent.xcodeproj..."

# Use xcodegen if available, otherwise provide instructions
if command -v xcodegen &>/dev/null; then
    cat > project.yml << 'XCODEGEN'
name: TapsmithAgent
options:
  bundleIdPrefix: dev.tapsmith
  deploymentTarget:
    iOS: "15.0"
  xcodeVersion: "15.0"
targets:
  TapsmithAgentUITests:
    type: bundle.ui-testing
    platform: iOS
    sources:
      - path: TapsmithAgent
        type: group
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: dev.tapsmith.agent
        INFOPLIST_FILE: ""
        GENERATE_INFOPLIST_FILE: YES
        # Reaches the runner app via install-runner-icon.sh (simulator builds).
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        TEST_TARGET_NAME: ""
        TEST_HOST: ""
        SUPPORTS_MACCATALYST: NO
        CODE_SIGN_IDENTITY: ""
        CODE_SIGNING_REQUIRED: NO
        CODE_SIGNING_ALLOWED: NO
        SWIFT_VERSION: "5.9"
        SWIFT_OBJC_BRIDGING_HEADER: TapsmithAgent/TapsmithAgent-Bridging-Header.h
XCODEGEN
    xcodegen generate
    rm project.yml
    echo "Done! Project created at $PROJECT_DIR"
else
    echo ""
    echo "xcodegen is not installed. Install it with:"
    echo "  brew install xcodegen"
    echo ""
    echo "Or manually create the Xcode project:"
    echo "  1. Open Xcode → File → New → Project → iOS → UI Testing Bundle"
    echo "  2. Name it 'TapsmithAgent', bundle ID 'dev.tapsmith.agent'"
    echo "  3. Add all files from TapsmithAgent/ directory"
    echo "  4. Set deployment target to iOS 15.0"
    echo ""
    exit 1
fi
