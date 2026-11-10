// Unit tests for RegionScreenshot: XCTest's private region screenshot is
// still there, in the shape the agent calls it with. Built against the macOS
// XCTest of the installed Xcode, which ships the same XCUIScreen and
// XCTImageEncoding classes as the iOS one.

import CoreGraphics
import Foundation
import XCTest

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

// The settle samples through this method on every touch; if an Xcode update
// renames it or changes its signature, the agent silently falls back to the
// ~10x slower whole-screen screenshot. This fails first.
switch RegionScreenshot.api {
case .success:
    expect("the private region screenshot resolves on the installed XCTest", true)
case .failure(let why):
    print("     \(why)")
    expect("the private region screenshot resolves on the installed XCTest", false)
}

expect("a missing screen class is reported, not crashed on",
       caseOf(RegionScreenshot.resolve(screenClass: "NoSuchScreenClass"))
           == .missingClass("NoSuchScreenClass"))
expect("a missing encoding class is reported",
       caseOf(RegionScreenshot.resolve(encodingClass: "NoSuchEncodingClass"))
           == .missingClass("NoSuchEncodingClass"))
// A class without the method (NSObject stands in for a renamed XCUIScreen).
expect("a missing method is reported",
       caseOf(RegionScreenshot.resolve(screenClass: "NSObject"))
           == .missingMethod("NSObject -screenshotWithPreferredEncoding:rect:error:"))
// A method with the right name but another signature is refused, never
// called through the cast.
if case .failure(.signatureChanged(let method, let encoding)) = RegionScreenshot.checkedMethod(
    NSObject.self, NSSelectorFromString("description"), "@24@0:8@16"
) {
    expect("a method of another signature is refused", method == "NSObject -description" && encoding == "@16@0:8")
} else {
    expect("a method of another signature is refused", false)
}

// No capture of an empty region (nothing to compare), and no call made.
expect("an empty region is not captured",
       RegionScreenshot.capture(.zero, of: NSObject()) == nil)
expect("a null region is not captured",
       RegionScreenshot.capture(.null, of: NSObject()) == nil)
expect("an empty region's bytes are not captured",
       RegionScreenshot.captureData(.zero, of: NSObject(), with: RegionScreenshot.settleJPEGAPI) == nil)
// The idle wait compares these bytes; without the encoding it waits blind.
if case .success = RegionScreenshot.settleJPEGAPI {
    expect("the idle wait's JPEG region screenshot encoding resolves", true)
} else {
    expect("the idle wait's JPEG region screenshot encoding resolves", false)
}

func caseOf(_ result: Result<RegionScreenshot.API, RegionScreenshot.Unavailable>) -> RegionScreenshot.Unavailable? {
    if case .failure(let why) = result { return why }
    return nil
}

if failures > 0 {
    print("\(failures) RegionScreenshot test(s) failed")
    exit(1)
}
print("All RegionScreenshot tests passed")
