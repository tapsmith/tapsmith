// Unit tests for CoverClearance (PILOT-980): the drag that scrolls a target
// out from under fixed chrome. Points on a 402x874 screen.

import CoreGraphics

var failures = 0

func check(_ name: String, _ got: CoverClearance.Drag?, _ want: CoverClearance.Drag?) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(String(describing: got)), want \(String(describing: want))")
    }
}

func R(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }
func D(_ x: CGFloat, _ y1: CGFloat, _ y2: CGFloat) -> CoverClearance.Drag {
    .init(from: CGPoint(x: x, y: y1), to: CGPoint(x: x, y: y2))
}

let screen = R(0, 0, 402, 874)
let list = R(0, 116, 402, 758) // 116..874, mid 495
func drag(_ target: CGRect, _ cover: CGRect, list: CGRect = list) -> CoverClearance.Drag? {
    CoverClearance.drag(target: target, cover: cover, list: list, screen: screen, margin: 8, slop: 10)
}

// Tab bar 791..874; a row 800..844 under it: move up 844 - (791 - 8) = 61, + slop.
check("a row under a tab bar is dragged up just clear of it",
      drag(R(0, 800, 402, 44), R(0, 791, 402, 83)), D(201, 783, 712))
// Sticky header 116..160; a row 120..164 under it: move down 160 + 8 - 120 = 48, + slop.
check("a row under a sticky header is dragged down just clear of it",
      drag(R(0, 120, 402, 44), R(0, 116, 402, 44)), D(201, 168, 226))
// Free part 116..600 (centre 358); target 300..800 (centre 550): move up 192.
check("a target too tall for the free part is centred in it",
      drag(R(0, 300, 402, 500), R(0, 600, 402, 274)), D(201, 592, 390))
// Footer from 200: free part 116..200, so at most 84 - 16 = 68.
check("a drag is capped at the free part",
      drag(R(0, 600, 402, 44), R(0, 200, 402, 674)), D(201, 192, 124))
check("a cover that leaves no room gives no drag",
      drag(R(0, 300, 402, 44), R(0, 140, 402, 734)), nil)
check("a target already clear of the cover gives no drag",
      drag(R(0, 400, 402, 44), R(0, 791, 402, 83)), nil)
check("a list off screen gives no drag",
      drag(R(0, 900, 402, 44), R(0, 900, 402, 44), list: R(0, 880, 402, 400)), nil)

if failures > 0 {
    print("\(failures) cover-clearance test(s) failed")
    exit(1)
}
print("cover-clearance tests passed")
