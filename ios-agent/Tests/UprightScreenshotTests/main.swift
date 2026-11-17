// Unit tests for UprightScreenshot: a screenshot of a turned device is stored
// in the native portrait layout, with the turn carried only as the image's
// orientation (PILOT-1235). The agent redraws it upright before sending it.

import CoreGraphics
import Foundation
import ImageIO

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

/// A `width` x `height` RGBA image whose pixel at column `x`, row `y` (row 0
/// at the top) has red = x, green = y.
func gradient(width: Int, height: Int) -> CGImage {
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    for y in 0..<height {
        for x in 0..<width {
            let i = (y * width + x) * 4
            bytes[i] = UInt8(x)
            bytes[i + 1] = UInt8(y)
            bytes[i + 2] = 0
        }
    }
    let provider = CGDataProvider(data: Data(bytes) as CFData)!
    return CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
    )!
}

/// The (red, green) of `image`'s pixel at column `x`, row `y` (row 0 at the top).
func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (Int, Int) {
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let context = CGContext(
        data: &bytes, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let i = (y * image.width + x) * 4
    return (Int(bytes[i]), Int(bytes[i + 1]))
}

// Stored native portrait: 3 wide, 5 tall. Native pixel (c, r) is (red c, green r).
let native = gradient(width: 3, height: 5)

// EXIF orientation 6 (`.right`, the device turned landscapeRight): the stored
// 0th row is the visual right side and the 0th column the visual top, so
// native (c, r) shows at (height - 1 - r, c).
if let up = UprightScreenshot.upright(native, orientation: .right) {
    expect(".right: the upright image is as wide as the native one is tall", up.width == 5 && up.height == 3)
    expect(".right: native (0,0) shows at the top right", pixel(up, 4, 0) == (0, 0))
    expect(".right: native (2,4) shows at the bottom left", pixel(up, 0, 2) == (2, 4))
    expect(".right: native (1,3) shows at (1,1)", pixel(up, 1, 1) == (1, 3))
} else {
    expect(".right: redrawn", false)
}

// EXIF orientation 8 (`.left`, landscapeLeft): the stored 0th row is the
// visual left side and the 0th column the visual bottom, so native (c, r)
// shows at (r, width - 1 - c).
if let up = UprightScreenshot.upright(native, orientation: .left) {
    expect(".left: the upright image is as wide as the native one is tall", up.width == 5 && up.height == 3)
    expect(".left: native (0,0) shows at the bottom left", pixel(up, 0, 2) == (0, 0))
    expect(".left: native (2,4) shows at the top right", pixel(up, 4, 0) == (2, 4))
    expect(".left: native (1,3) shows at (3,1)", pixel(up, 3, 1) == (1, 3))
} else {
    expect(".left: redrawn", false)
}

// EXIF orientation 3 (`.down`): turned half way round.
if let up = UprightScreenshot.upright(native, orientation: .down) {
    expect(".down: the same size", up.width == 3 && up.height == 5)
    expect(".down: native (0,0) shows at the bottom right", pixel(up, 2, 4) == (0, 0))
    expect(".down: native (2,1) shows at (0,3)", pixel(up, 0, 3) == (2, 1))
} else {
    expect(".down: redrawn", false)
}

// An upright screenshot is sent as XCTest encoded it: no redraw.
expect(".up: nothing to redraw", UprightScreenshot.upright(native, orientation: .up) == nil)
expect("a mirrored orientation is left as it is", UprightScreenshot.upright(native, orientation: .leftMirrored) == nil)

// The turn the UI-mode mirror maps its touches with: the image's
// orientation, which is the device's as the screenshot shows it.
expect(".up is portrait", UprightScreenshot.turn(of: .up) == "portrait")
expect(".left is landscapeLeft", UprightScreenshot.turn(of: .left) == "landscapeLeft")
expect(".right is landscapeRight", UprightScreenshot.turn(of: .right) == "landscapeRight")
expect(".down is portraitUpsideDown", UprightScreenshot.turn(of: .down) == "portraitUpsideDown")
expect("a mirrored orientation has no turn the mirror can map", UprightScreenshot.turn(of: .leftMirrored) == nil)

// The redrawn image is sent as a PNG with no orientation of its own left to
// turn it a second time.
if let up = UprightScreenshot.upright(native, orientation: .left), let png = UprightScreenshot.png(up) {
    let source = CGImageSourceCreateWithData(png as CFData, nil)!
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    expect("the PNG holds the upright size",
           props[kCGImagePropertyPixelWidth] as? Int == 5 && props[kCGImagePropertyPixelHeight] as? Int == 3)
    let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
    expect("the PNG carries no turn", orientation == 1)
    let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    expect("the PNG decodes to the upright pixels", pixel(decoded, 4, 0) == (2, 4))
} else {
    expect("the upright image encodes as PNG", false)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all passed")
