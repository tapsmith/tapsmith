import CoreGraphics
import Foundation

/// The pure parts of verifying a warm deep link: how often the in-app ack is
/// read, and whether a screenshot shows a display that has stopped rendering.
///
/// Uses no UIKit or XCTest types, so the host unit tests compile it.
enum DeepLinkVerify {
    /// The wait between two reads of the hooks marker while waiting for an
    /// ack, `elapsed` seconds into the wait. The URL reaches the app within
    /// tens of milliseconds of the request, so most acks land in the first
    /// few hundred milliseconds: read often then, and at the old 200 ms
    /// cadence once a slow app has had a second.
    static func pollInterval(elapsed: TimeInterval) -> TimeInterval {
        elapsed < fastPollWindow ? fastPollInterval : slowPollInterval
    }

    static let fastPollInterval: TimeInterval = 0.05
    static let fastPollWindow: TimeInterval = 1.0
    static let slowPollInterval: TimeInterval = 0.2

    /// The share of the screen's height at each end that the black check
    /// ignores: the status bar's clock and battery, and the home indicator,
    /// keep rendering over an app window that has stopped compositing.
    static let excludedEndFraction = 0.12

    /// The part of the screen the black check reads, in points in the
    /// device's native portrait space (the space `RegionScreenshot` reads):
    /// the full width, less `excludedEndFraction` of the height at each end.
    /// `screen` may be the interface's size on a turned screen; the native
    /// portrait size is its short side by its long side.
    static func contentBand(screen: CGSize) -> CGRect {
        let width = min(screen.width, screen.height)
        let height = max(screen.width, screen.height)
        guard width > 0, height > 0 else { return .zero }
        let excluded = height * CGFloat(excludedEndFraction)
        return CGRect(x: 0, y: excluded, width: width, height: height - 2 * excluded)
    }

    /// Whether `image` shows (near-)pure black, ignoring `fraction` of its
    /// height at each end (`excludedEndFraction` for a whole-screen
    /// screenshot, 0 for a `contentBand` capture, which has already left
    /// the ends out).
    ///
    /// Downscales the image and takes the largest channel value across the
    /// samples. Any visible content, including sparse light text on a
    /// dark-mode screen, produces bright samples; a false "black" merely
    /// costs a cold relaunch, never a wrong verdict. An image too small to
    /// judge is never called black.
    static func appearsBlack(_ image: CGImage, excludingEnds fraction: Double) -> Bool {
        guard image.width > 8, image.height > 8 else { return false }
        let sampleWidth = 64
        let sampleHeight = 128
        let bytesPerPixel = 4
        var pixels = [UInt8](repeating: 0, count: sampleWidth * sampleHeight * bytesPerPixel)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: sampleWidth,
                height: sampleHeight,
                bitsPerComponent: 8,
                bytesPerRow: sampleWidth * bytesPerPixel,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: sampleWidth, height: sampleHeight))
            return true
        }
        guard drawn else { return false }

        // Exclude both vertical ends rather than reasoning about CGContext
        // row order — the status bar is at one end, the home indicator at
        // the other.
        let excludedRows = Int(Double(sampleHeight) * fraction)
        var maxChannel: UInt8 = 0
        for row in excludedRows..<(sampleHeight - excludedRows) {
            for col in 0..<sampleWidth {
                let offset = (row * sampleWidth + col) * bytesPerPixel
                maxChannel = max(maxChannel, pixels[offset], pixels[offset + 1], pixels[offset + 2])
            }
        }
        return maxChannel < 10
    }
}
