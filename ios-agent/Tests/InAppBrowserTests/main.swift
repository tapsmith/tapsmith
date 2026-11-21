// Unit tests for InAppBrowser (PILOT-1384), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are shaped like
// the ones recorded from an Expo app on iPhone 17 Pro simulators while an
// SFSafariViewController (expo-web-browser) was up.

import XCTest
import Foundation

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

func node(
    _ type: XCUIElement.ElementType,
    label: String = "",
    identifier: String = "",
    value: String = "",
    _ children: [[String: Any]] = []
) -> [String: Any] {
    ["elementType": type.rawValue, "label": label, "identifier": identifier, "value": value, "children": children]
}

/// A chain of `depth` empty plain views.
func emptyChain(_ depth: Int) -> [String: Any] {
    depth == 0 ? node(.other) : node(.other, [emptyChain(depth - 1)])
}

func app(_ windowChildren: [[String: Any]]) -> [String: Any] {
    node(.application, label: "mobileapp", [node(.window, windowChildren)])
}

// ─── Blank trees ───

// iOS 26.4: the app's tree while the browser is up — empty views only, the
// app's own screen left out too.
let ios26 = app([node(.other, [node(.other), emptyChain(11)])])
check("iOS 26's tree with the browser up is blank", InAppBrowser.isBlank(ios26), true)
check("the application's own label does not count", InAppBrowser.isBlank(app([])), true)
check("a window with no children is blank", InAppBrowser.isBlank(node(.application, label: "x", [node(.window)])), true)

// ─── Trees with something in them ───

let screen = app([node(.other, [node(.staticText, label: "Explore"), node(.link, label: "Expo documentation")])])
check("an app's own screen is not blank", InAppBrowser.isBlank(screen), false)
// iOS 18 reads the browser into the app's tree itself: nothing to look for.
let ios18 = app([node(.other, [node(.other, identifier: "BrowserView?IsPageLoaded=true&WebViewProcessID=1",
                                    [node(.button, label: "Done", identifier: "Close")])])])
check("iOS 18's tree, which holds the browser, is not blank", InAppBrowser.isBlank(ios18), false)
check("an identifier alone is content", InAppBrowser.isBlank(app([node(.other, identifier: "root")])), false)
check("a value alone is content", InAppBrowser.isBlank(app([node(.other, value: "50%")])), false)
check("an unlabelled control is content", InAppBrowser.isBlank(app([node(.button)])), false)
check("an unlabelled image is content", InAppBrowser.isBlank(app([node(.image)])), false)
check("content deep in a chain counts", InAppBrowser.isBlank(app([node(.other, [node(.other, [node(.staticText, label: "Hi")])])])), false)
check("a second window's content counts",
      InAppBrowser.isBlank(node(.application, label: "x", [node(.window), node(.window, [node(.keyboard)])])), false)

// ─── When to look ───

let now = Date(timeIntervalSince1970: 1_000)
func look(blank: Bool = true, foreground: Bool = true, deadlineIn: TimeInterval?) -> Bool {
    InAppBrowser.shouldLook(
        blank: blank, serviceInForeground: foreground, now: now,
        deadline: deadlineIn.map { now.addingTimeInterval($0) }, lookCost: 2.5
    )
}
check("blank, browser service up, no deadline: look", look(deadlineIn: nil), true)
check("blank, browser service up, time to spare: look", look(deadlineIn: 10), true)
check("exactly enough time: look", look(deadlineIn: 2.5), true)
check("not enough time left for the query: do not look", look(deadlineIn: 2.4), false)
check("deadline passed: do not look", look(deadlineIn: -1), false)
check("not blank: do not look", look(blank: false, deadlineIn: nil), false)
check("browser service not in the foreground: do not look", look(foreground: false, deadlineIn: nil), false)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all InAppBrowser tests passed")
