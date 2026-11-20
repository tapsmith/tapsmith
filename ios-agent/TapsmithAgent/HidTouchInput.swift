import Foundation

/// Whether the daemon's HID helper can reach this simulator's touchscreen.
///
/// The helper sends touches through the simulator's legacy (Indigo) input,
/// which a touchscreen service with no transport receives. Xcode 27's
/// DeviceHub drives a simulator through CoreDevice instead: opened on a
/// simulator whose legacy touchscreen has not been touched yet in that boot,
/// it has the legacy touchscreen switched off and a "CoreDevice" one put in
/// its place. Every touch the helper sends after that is accepted by the
/// simulator and dropped, while the agent's own (XCTest) touches still land.
/// Reading the input services the simulator lists tells the two apart.
enum HidTouchInput {
    /// What the simulator's input services say about its touchscreens.
    struct Assessment: Equatable {
        /// A built-in touchscreen the helper's touches reach is listed.
        let legacyTouchscreen: Bool
        /// A built-in touchscreen driven through CoreDevice is listed.
        let coreDeviceTouchscreen: Bool

        var dictionary: [String: Any] {
            [
                "known": true,
                "legacyTouchscreen": legacyTouchscreen,
                "coreDeviceTouchscreen": coreDeviceTouchscreen,
            ]
        }
    }

    /// HID usage page and usage of a touchscreen (Digitizer / Touch Screen).
    static let digitizerUsagePage = 13
    static let touchScreenUsage = 4

    /// Assess the properties of each input service (`PrimaryUsagePage`,
    /// `PrimaryUsage`, `Built-In`, `Transport`). Only built-in touchscreens
    /// count: a simulator also lists a touchscreen that is not built in (for
    /// a second display), which the helper's touches do not go to.
    static func assess(services: [[String: Any]]) -> Assessment {
        var legacy = false
        var coreDevice = false
        for service in services {
            guard (service["PrimaryUsagePage"] as? NSNumber)?.intValue == digitizerUsagePage,
                  (service["PrimaryUsage"] as? NSNumber)?.intValue == touchScreenUsage,
                  (service["Built-In"] as? NSNumber)?.boolValue == true
            else { continue }
            let transport = service["Transport"] as? String
            if transport == nil || transport?.isEmpty == true {
                legacy = true
            } else if transport == "CoreDevice" {
                coreDevice = true
            }
        }
        return Assessment(legacyTouchscreen: legacy, coreDeviceTouchscreen: coreDevice)
    }

    /// The properties of every input service this process can see, or nil
    /// when they cannot be read (the IOHID event system's client functions
    /// are looked up at run time, so a missing one is an unknown, not a
    /// crash).
    static func readServices() -> [[String: Any]]? {
        typealias CreateClient = @convention(c) (CFAllocator?) -> Unmanaged<AnyObject>?
        typealias CopyServices = @convention(c) (AnyObject) -> Unmanaged<CFArray>?
        typealias CopyProperty = @convention(c) (AnyObject, CFString) -> Unmanaged<AnyObject>?
        guard let iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW) else {
            return nil
        }
        defer { dlclose(iokit) }
        guard let createSym = dlsym(iokit, "IOHIDEventSystemClientCreateSimpleClient"),
              let servicesSym = dlsym(iokit, "IOHIDEventSystemClientCopyServices"),
              let propertySym = dlsym(iokit, "IOHIDServiceClientCopyProperty")
        else { return nil }
        let create = unsafeBitCast(createSym, to: CreateClient.self)
        let copyServices = unsafeBitCast(servicesSym, to: CopyServices.self)
        let copyProperty = unsafeBitCast(propertySym, to: CopyProperty.self)
        guard let client = create(kCFAllocatorDefault)?.takeRetainedValue(),
              let services = copyServices(client)?.takeRetainedValue() as? [AnyObject]
        else { return nil }
        let keys = ["PrimaryUsagePage", "PrimaryUsage", "Built-In", "Transport"]
        return services.map { service in
            var properties: [String: Any] = [:]
            for key in keys {
                if let value = copyProperty(service, key as CFString)?.takeRetainedValue() {
                    properties[key] = value
                }
            }
            return properties
        }
    }

    /// The agent's answer to `hidTouchInput`.
    static func answer() -> [String: Any] {
        guard let services = readServices() else { return ["known": false] }
        return assess(services: services).dictionary
    }
}
