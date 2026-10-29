// Unit tests for DoubleTapRoute (PILOT-795): which synthesized double-tap
// route the agent takes for a given simulator runtime and Xcode toolchain.

import Foundation

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

// The XCTest bundle's DTXcode: "2710" is Xcode 27.1, "2640" Xcode 26.4.
expect("parses Xcode 27.1", DoubleTapRoute.xcodeVersion(fromDTXcode: "2710") == 2710)
expect("parses Xcode 26.4", DoubleTapRoute.xcodeVersion(fromDTXcode: "2640") == 2640)
expect("trims whitespace", DoubleTapRoute.xcodeVersion(fromDTXcode: " 2700\n") == 2700)
expect("missing key is unknown", DoubleTapRoute.xcodeVersion(fromDTXcode: nil) == nil)
expect("empty value is unknown", DoubleTapRoute.xcodeVersion(fromDTXcode: "") == nil)
expect("non-numeric value is unknown", DoubleTapRoute.xcodeVersion(fromDTXcode: "27.1") == nil)

// Pre-26 runtimes replay a two-path record correctly, whatever the toolchain.
expect("iOS 18 + Xcode 26 → single record",
       DoubleTapRoute.choose(runtimeMajor: 18, xcodeVersion: 2640) == .singleRecord)
expect("iOS 18 + Xcode 27 → single record",
       DoubleTapRoute.choose(runtimeMajor: 18, xcodeVersion: 2710) == .singleRecord)
expect("iOS 18 + unknown Xcode → single record",
       DoubleTapRoute.choose(runtimeMajor: 18, xcodeVersion: nil) == .singleRecord)

// iOS 26 with Xcode 27's XCTest: the sequential route's second tap never
// lands (0/8), the single record does (8/8 on 26.4 and 26.5).
expect("iOS 26 + Xcode 27.0 → single record",
       DoubleTapRoute.choose(runtimeMajor: 26, xcodeVersion: 2700) == .singleRecord)
expect("iOS 26 + Xcode 27.1 → single record",
       DoubleTapRoute.choose(runtimeMajor: 26, xcodeVersion: 2710) == .singleRecord)
expect("iOS 27 + Xcode 27 → single record",
       DoubleTapRoute.choose(runtimeMajor: 27, xcodeVersion: 2710) == .singleRecord)

// iOS 26 with an older (or unreadable) toolchain keeps the route that was
// verified there: sequential taps with a 250 ms floor and a 2 pt offset.
expect("iOS 26 + Xcode 26.4 → sequential",
       DoubleTapRoute.choose(runtimeMajor: 26, xcodeVersion: 2640) == .sequential)
expect("iOS 26 + Xcode 26.9 → sequential",
       DoubleTapRoute.choose(runtimeMajor: 26, xcodeVersion: 2699) == .sequential)
expect("iOS 26 + unknown Xcode → sequential",
       DoubleTapRoute.choose(runtimeMajor: 26, xcodeVersion: nil) == .sequential)

if failures > 0 {
    print("\(failures) DoubleTapRoute test(s) failed")
    exit(1)
}
print("DoubleTapRoute: all tests passed")
