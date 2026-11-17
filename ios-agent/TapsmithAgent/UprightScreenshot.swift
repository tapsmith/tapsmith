import CoreGraphics
import Foundation
import ImageIO

/// Screenshots as the screen shows them.
///
/// On a turned device `XCUIScreen.main.screenshot()` stores its pixels in the
/// device's native portrait layout and carries the turn only as the image's
/// orientation, which `pngRepresentation` writes as a PNG `eXIf` tag. Some
/// readers honour that tag (Chromium and Safari draw the image upright) and
/// some don't, and the PNG's own size stays portrait either way — so the
/// UI-mode mirror scaled its touches by the wrong sides, and trace screenshots
/// disagreed with the landscape element bounds recorded next to them
/// (PILOT-1235). Everything the agent sends is redrawn upright here, the way
/// Android's screenshots already are.
///
/// Uses no UIKit or XCTest types, so the host unit tests compile it; the
/// caller converts `UIImage.Orientation` to `CGImagePropertyOrientation`.
enum UprightScreenshot {
    /// `image` (stored as `orientation` says) redrawn upright; nil when it is
    /// upright already, when its orientation is a mirrored one (no device turn
    /// makes those), or when it could not be redrawn.
    static func upright(_ image: CGImage, orientation: CGImagePropertyOrientation) -> CGImage? {
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let size: CGSize
        let transform: CGAffineTransform
        // Core Graphics' y axis points up, so a quarter turn clockwise on
        // screen is a negative rotation here. Each transform turns the image
        // and moves it back into the context's first quadrant.
        switch orientation {
        case .up:
            return nil
        case .right:
            // Shown turned a quarter clockwise.
            size = CGSize(width: height, height: width)
            transform = CGAffineTransform(translationX: 0, y: width).rotated(by: -.pi / 2)
        case .left:
            // Shown turned a quarter anticlockwise.
            size = CGSize(width: height, height: width)
            transform = CGAffineTransform(translationX: height, y: 0).rotated(by: .pi / 2)
        case .down:
            size = CGSize(width: width, height: height)
            transform = CGAffineTransform(translationX: width, y: height).rotated(by: .pi)
        case .upMirrored, .downMirrored, .leftMirrored, .rightMirrored:
            // No device turn produces these: sent as XCTest encoded them.
            return nil
        @unknown default:
            return nil
        }
        // In the image's own colour space where an 8-bit context takes it;
        // an extended-range one (a float wide-gamut capture) it refuses, and
        // device RGB then keeps the redraw rather than sending it sideways.
        let makeContext = { (space: CGColorSpace) in
            CGContext(
                data: nil,
                width: Int(size.width),
                height: Int(size.height),
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        }
        guard let context = image.colorSpace.flatMap(makeContext) ?? makeContext(CGColorSpaceCreateDeviceRGB())
        else { return nil }
        context.interpolationQuality = .none
        context.concatenate(transform)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// The device's turn as `orientation` records it, as the daemon's
    /// screenshot response names it; nil for a mirrored orientation, which
    /// no device turn produces.
    static func turn(of orientation: CGImagePropertyOrientation) -> String? {
        switch orientation {
        case .up: return "portrait"
        case .left: return "landscapeLeft"
        case .right: return "landscapeRight"
        case .down: return "portraitUpsideDown"
        default: return nil
        }
    }

    /// `image` as PNG data, with no orientation of its own.
    static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
