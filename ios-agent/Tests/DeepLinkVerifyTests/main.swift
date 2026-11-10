// Unit tests for DeepLinkVerify: the warm deep link's ack poll schedule and
// the black-display check that runs after every warm link.

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

// MARK: - Poll schedule

// The URL reaches the app within tens of milliseconds of the request, so the
// ack is read often at first; a slow app gets the old 200 ms cadence.
expect("polls every 50 ms at first", DeepLinkVerify.pollInterval(elapsed: 0) == 0.05)
expect("still fast just under a second", DeepLinkVerify.pollInterval(elapsed: 0.99) == 0.05)
expect("200 ms from one second on", DeepLinkVerify.pollInterval(elapsed: 1.0) == 0.2)
expect("200 ms long after", DeepLinkVerify.pollInterval(elapsed: 7) == 0.2)

// MARK: - Content band

let portrait = DeepLinkVerify.contentBand(screen: CGSize(width: 400, height: 800))
expect("the band leaves out the top and bottom 12% of a portrait screen",
       portrait == CGRect(x: 0, y: 96, width: 400, height: 608))
let landscape = DeepLinkVerify.contentBand(screen: CGSize(width: 800, height: 400))
expect("a landscape screen size gives the same native-portrait band", landscape == portrait)
expect("an empty screen gives no band", DeepLinkVerify.contentBand(screen: .zero).isEmpty)

// MARK: - Black verdict

/// A `width` x `height` RGBA image, all `background`, with `patches` filled
/// with `value` (rects in pixels, origin top-left).
func image(_ width: Int, _ height: Int, background: UInt8 = 0, patches: [CGRect] = [], value: UInt8 = 255) -> CGImage {
    let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    let bg = CGFloat(background) / 255
    ctx.setFillColor(red: bg, green: bg, blue: bg, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let v = CGFloat(value) / 255
    ctx.setFillColor(red: v, green: v, blue: v, alpha: 1)
    for patch in patches {
        // CGContext's origin is bottom-left.
        ctx.fill(CGRect(x: patch.minX, y: CGFloat(height) - patch.maxY, width: patch.width, height: patch.height))
    }
    return ctx.makeImage()!
}

// Whole-screen captures (1179 x 2556, an iPhone at 3x) exclude both ends.
expect("an all-black screen is black",
       DeepLinkVerify.appearsBlack(image(1179, 2556), excludingEnds: 0.12))
expect("near-black (9) is black",
       DeepLinkVerify.appearsBlack(image(1179, 2556, background: 9), excludingEnds: 0.12))
expect("dark grey (10) is not black",
       !DeepLinkVerify.appearsBlack(image(1179, 2556, background: 10), excludingEnds: 0.12))
expect("a status bar over a black app is still black",
       DeepLinkVerify.appearsBlack(image(1179, 2556, patches: [CGRect(x: 0, y: 0, width: 1179, height: 150)]), excludingEnds: 0.12))
expect("a home indicator over a black app is still black",
       DeepLinkVerify.appearsBlack(image(1179, 2556, patches: [CGRect(x: 400, y: 2500, width: 380, height: 20)]), excludingEnds: 0.12))
expect("one line of light text on a dark screen is not black",
       !DeepLinkVerify.appearsBlack(image(1179, 2556, patches: [CGRect(x: 60, y: 1200, width: 600, height: 51)]), excludingEnds: 0.12))

// Band captures (the content band only) look at every row.
let band = (width: 1179, height: 1945)
expect("an all-black band is black",
       DeepLinkVerify.appearsBlack(image(band.width, band.height), excludingEnds: 0))
expect("light text at the very top of the band is not black",
       !DeepLinkVerify.appearsBlack(image(band.width, band.height, patches: [CGRect(x: 60, y: 0, width: 600, height: 51)]), excludingEnds: 0))
expect("light text at the very bottom of the band is not black",
       !DeepLinkVerify.appearsBlack(image(band.width, band.height, patches: [CGRect(x: 60, y: 1894, width: 600, height: 51)]), excludingEnds: 0))
expect("a tiny image is never called black",
       !DeepLinkVerify.appearsBlack(image(4, 4), excludingEnds: 0))

// The band is captured as a quality-0.3 JPEG: its noise must not turn a
// black band into content, nor wash out a line of light text.
func jpegRoundTrip(_ image: CGImage) -> CGImage {
    let data = NSMutableData()
    let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.3] as CFDictionary)
    CGImageDestinationFinalize(dest)
    let source = CGImageSourceCreateWithData(data, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}
expect("a JPEG of an all-black band is black",
       DeepLinkVerify.appearsBlack(jpegRoundTrip(image(band.width, band.height)), excludingEnds: 0))
expect("a JPEG of a black band with a line of light text is not black",
       !DeepLinkVerify.appearsBlack(jpegRoundTrip(image(band.width, band.height, patches: [CGRect(x: 60, y: 900, width: 600, height: 51)])), excludingEnds: 0))
expect("a JPEG of a black band with dim grey text (40) is not black",
       !DeepLinkVerify.appearsBlack(jpegRoundTrip(image(band.width, band.height, patches: [CGRect(x: 60, y: 900, width: 600, height: 51)], value: 40)), excludingEnds: 0))

if failures > 0 {
    print("\(failures) DeepLinkVerify test(s) failed")
    exit(1)
}
print("All DeepLinkVerify tests passed")
