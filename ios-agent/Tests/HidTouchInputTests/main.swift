// Unit tests for HidTouchInput: whether the daemon's HID helper can reach a
// simulator's touchscreen, from the input services the simulator lists.

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

func touchscreen(builtIn: Bool, transport: String? = nil) -> [String: Any] {
    var service: [String: Any] = [
        "PrimaryUsagePage": NSNumber(value: 13),
        "PrimaryUsage": NSNumber(value: 4),
        "Built-In": NSNumber(value: builtIn),
    ]
    if let transport { service["Transport"] = transport }
    return service
}

// Services every simulator lists beside its touchscreens: a gamepad, the
// vendor pages, and the CoreDevice buttons and keyboard once DeviceHub is on.
let gamepad: [String: Any] = ["PrimaryUsagePage": NSNumber(value: 1), "PrimaryUsage": NSNumber(value: 5)]
let vendor: [String: Any] = [
    "PrimaryUsagePage": NSNumber(value: 65280), "PrimaryUsage": NSNumber(value: 114),
    "Built-In": NSNumber(value: true),
]
let coreDeviceButtons: [String: Any] = [
    "PrimaryUsagePage": NSNumber(value: 11), "PrimaryUsage": NSNumber(value: 1),
    "Built-In": NSNumber(value: true), "Transport": "CoreDevice",
]

// A simulator only ever booted (iOS 18.5 and 26.5 list one built-in
// touchscreen, iOS 27.2 a second one that is not built in): the helper's
// touches land.
let booted = HidTouchInput.assess(services: [gamepad, vendor, touchscreen(builtIn: true)])
expect("a booted simulator's touchscreen is reachable", booted.legacyTouchscreen)
expect("a booted simulator has no CoreDevice touchscreen", !booted.coreDeviceTouchscreen)
let booted27 = HidTouchInput.assess(services: [
    gamepad, touchscreen(builtIn: true), touchscreen(builtIn: false),
])
expect("an iOS 27 simulator's built-in touchscreen is reachable", booted27.legacyTouchscreen)

// Opened in DeviceHub before its first touch: the legacy touchscreen is gone,
// a CoreDevice one is in its place, and the helper's touches are dropped.
let deviceHubFirst = HidTouchInput.assess(services: [
    gamepad, vendor, coreDeviceButtons, touchscreen(builtIn: true, transport: "CoreDevice"),
])
expect("DeviceHub's touchscreen alone is not reachable", !deviceHubFirst.legacyTouchscreen)
expect("DeviceHub's touchscreen is seen", deviceHubFirst.coreDeviceTouchscreen)
// iOS 27.2 keeps its touchscreen that is not built in: that one does not count.
let deviceHubFirst27 = HidTouchInput.assess(services: [
    gamepad, touchscreen(builtIn: false), touchscreen(builtIn: true, transport: "CoreDevice"),
])
expect("a touchscreen that is not built in does not count", !deviceHubFirst27.legacyTouchscreen)

// Touched through the helper before DeviceHub opened: both are listed, and
// the helper's touches still land.
let touchedFirst = HidTouchInput.assess(services: [
    touchscreen(builtIn: true), touchscreen(builtIn: true, transport: "CoreDevice"),
])
expect("a touchscreen kept beside DeviceHub's is reachable", touchedFirst.legacyTouchscreen)
expect("and DeviceHub's is seen too", touchedFirst.coreDeviceTouchscreen)

// A transport the agent does not know is neither.
let other = HidTouchInput.assess(services: [touchscreen(builtIn: true, transport: "USB")])
expect("an unknown transport is not the legacy touchscreen", !other.legacyTouchscreen)
expect("nor CoreDevice's", !other.coreDeviceTouchscreen)
// An empty transport is no transport.
expect("an empty transport is the legacy touchscreen",
       HidTouchInput.assess(services: [touchscreen(builtIn: true, transport: "")]).legacyTouchscreen)
// Nothing listed (or nothing readable as numbers) is not reachable either.
expect("no services, no touchscreen", !HidTouchInput.assess(services: []).legacyTouchscreen)
expect("a touchscreen without Built-In does not count",
       !HidTouchInput.assess(services: [[
           "PrimaryUsagePage": NSNumber(value: 13), "PrimaryUsage": NSNumber(value: 4),
       ]]).legacyTouchscreen)

// The answer the daemon reads.
let answer = deviceHubFirst.dictionary
expect("the answer is known", answer["known"] as? Bool == true)
expect("the answer says the legacy touchscreen is gone", answer["legacyTouchscreen"] as? Bool == false)
expect("the answer says DeviceHub's is there", answer["coreDeviceTouchscreen"] as? Bool == true)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all HidTouchInput tests passed")
