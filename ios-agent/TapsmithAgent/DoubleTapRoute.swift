import Foundation

/// Which synthesized-event route the agent's double tap takes (PILOT-795).
/// Pure, so the choice is host-testable; `EventSynthesizer.doubleTap`
/// supplies the runtime and toolchain.
enum DoubleTapRoute: Equatable {
    /// ONE event record carrying both taps as two pointer paths with
    /// disjoint time ranges — the gap is fixed inside the event system.
    case singleRecord
    /// Two separate single-tap records, the interval floored at 250 ms and
    /// the second tap offset 2 pt — the iOS 26 route verified with Xcode 26.
    case sequential

    /// The first toolchain whose XCTest delivers a two-path record on iOS 26
    /// runtimes. With Xcode 27.1 on iOS 26.4 and 26.5 simulators the single
    /// record fired a native double-tap recognizer 8/8, while the sequential
    /// route's taps never paired up (0/8).
    static let firstSingleRecordXcodeOnIOS26 = 2700

    /// Parse an Info.plist `DTXcode` value ("2710" for Xcode 27.1). nil when
    /// it is missing or not a plain number.
    static func xcodeVersion(fromDTXcode raw: String?) -> Int? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty,
              trimmed.allSatisfy(\.isASCII),
              let version = Int(trimmed)
        else { return nil }
        return version
    }

    /// Pre-26 runtimes replay a two-path record correctly. iOS 26+ runtimes
    /// mishandled it with the Xcode 26 toolchain (at most the first tap
    /// arrived), so the sequential route stays for any toolchain older than
    /// Xcode 27, or one that cannot be read.
    static func choose(runtimeMajor: Int, xcodeVersion: Int?) -> DoubleTapRoute {
        if runtimeMajor < 26 { return .singleRecord }
        guard let xcode = xcodeVersion else { return .sequential }
        return xcode >= firstSingleRecordXcodeOnIOS26 ? .singleRecord : .sequential
    }
}
