import CoreGraphics
import Foundation
import ImageIO
import ObjectiveC

/// A screenshot of one region of the screen, through XCTest's private
/// `-[XCUIScreen screenshotWithPreferredEncoding:rect:error:]` with a PNG
/// `XCTImageEncoding`. A target-sized region costs 8–13 ms on a simulator,
/// against 110–130 ms for `XCUIScreen.main.screenshot()` of the whole screen.
///
/// The method is private, so it is looked up at run time and checked against
/// the Objective-C signature this file calls it with. When anything is
/// missing or has a different shape, `api` says why and `capture` returns
/// nil; callers then take the whole-screen screenshot and crop it. The host
/// test (`Tests/RegionScreenshotTests`) checks the installed XCTest still has
/// the method in this shape.
///
/// `rect` is in points, in the device's native portrait space: on an upright
/// screen the same space as accessibility frames, on a rotated one not
/// (`HidTouch.nativeRect` maps an interface rect; unmapped, a landscape
/// capture came back all black). PNG keeps the pixels exact, so two captures
/// of an unchanged region compare equal.
///
/// `captureJPEGData` takes the same capture as JPEG bytes, undecoded: a
/// whole-screen region costs ~15–20 ms that way, against ~95 ms as PNG (the
/// encoding is the cost). JPEG is lossy but deterministic, so two captures of
/// an unchanged screen are the same bytes; the idle wait compares them so
/// (`IdleSettle`).
///
/// Uses no UIKit or XCTest types, so the host unit tests compile it.
enum RegionScreenshot {
    /// Why the private method can't be used.
    enum Unavailable: Error, Equatable, CustomStringConvertible {
        case missingClass(String)
        case missingMethod(String)
        case signatureChanged(method: String, encoding: String)
        case encodingNotCreated

        var description: String {
            switch self {
            case .missingClass(let name): return "class \(name) not found"
            case .missingMethod(let name): return "method \(name) not found"
            case .signatureChanged(let method, let encoding): return "\(method) has signature \(encoding)"
            case .encodingNotCreated: return "the PNG XCTImageEncoding could not be created"
            }
        }
    }

    /// The looked-up method and the PNG encoding it is called with.
    struct API {
        fileprivate let shot: ShotFunction
        fileprivate let selector: Selector
        fileprivate let encoding: AnyObject
        /// The JPEG encoding for `captureJPEGData`; nil when it could not be
        /// made (the PNG captures do not depend on it).
        fileprivate let jpegEncoding: AnyObject?
    }

    /// Quality of `captureJPEGData`'s encoding. Low enough to stay cheap,
    /// high enough that a small change (a spinner's turn) changes the bytes.
    static let jpegQuality = 0.5

    static let screenClassName = "XCUIScreen"
    static let encodingClassName = "XCTImageEncoding"
    static let imageClassName = "XCTImage"
    static let shotSelectorName = "screenshotWithPreferredEncoding:rect:error:"
    static let encodingInitSelectorName = "initWithUniformTypeIdentifier:compressionQuality:"
    static let imageDataSelectorName = "data"

    /// `- (XCTImage *)screenshotWithPreferredEncoding:(XCTImageEncoding *)encoding rect:(CGRect)rect error:(NSError **)error`
    static let shotTypeEncoding = "@64@0:8@16{CGRect={CGPoint=dd}{CGSize=dd}}24^@56"
    /// `- (instancetype)initWithUniformTypeIdentifier:(NSString *)uti compressionQuality:(double)quality`
    static let encodingInitTypeEncoding = "@32@0:8@16d24"
    /// `- (NSData *)data`
    static let imageDataTypeEncoding = "@16@0:8"

    fileprivate typealias ShotFunction = @convention(c) (
        AnyObject, Selector, AnyObject, CGRect, AutoreleasingUnsafeMutablePointer<NSError?>?
    ) -> AnyObject?
    private typealias EncodingInitFunction = @convention(c) (AnyObject, Selector, NSString, Double) -> AnyObject?

    /// The method, looked up once.
    static let api: Result<API, Unavailable> = resolve()

    /// Look the method up and make the PNG encoding. The class names are
    /// parameters so the host test can check the failure answers.
    static func resolve(
        screenClass screenName: String = screenClassName,
        encodingClass encodingName: String = encodingClassName,
        imageClass imageName: String = imageClassName
    ) -> Result<API, Unavailable> {
        guard let screenClass = NSClassFromString(screenName) else { return .failure(.missingClass(screenName)) }
        guard let encodingClass = NSClassFromString(encodingName) else { return .failure(.missingClass(encodingName)) }
        guard let imageClass = NSClassFromString(imageName) else { return .failure(.missingClass(imageName)) }

        let shotSelector = NSSelectorFromString(shotSelectorName)
        let initSelector = NSSelectorFromString(encodingInitSelectorName)
        let dataSelector = NSSelectorFromString(imageDataSelectorName)
        let shot: Method
        let initializer: Method
        switch checkedMethod(screenClass, shotSelector, shotTypeEncoding) {
        case .success(let found): shot = found
        case .failure(let why): return .failure(why)
        }
        switch checkedMethod(encodingClass, initSelector, encodingInitTypeEncoding) {
        case .success(let found): initializer = found
        case .failure(let why): return .failure(why)
        }
        if case .failure(let why) = checkedMethod(imageClass, dataSelector, imageDataTypeEncoding) {
            return .failure(why)
        }

        // alloc, then the initializer. The encoding lives as long as the
        // process (it is made once).
        guard let allocated = (encodingClass as AnyObject).perform(NSSelectorFromString("alloc"))?
            .takeUnretainedValue() else { return .failure(.encodingNotCreated) }
        let initialize = unsafeBitCast(method_getImplementation(initializer), to: EncodingInitFunction.self)
        guard let encoding = initialize(allocated, initSelector, "public.png" as NSString, 1.0) else {
            return .failure(.encodingNotCreated)
        }
        let jpegEncoding = (encodingClass as AnyObject).perform(NSSelectorFromString("alloc"))
            .flatMap { initialize($0.takeUnretainedValue(), initSelector, "public.jpeg" as NSString, jpegQuality) }
        return .success(API(
            shot: unsafeBitCast(method_getImplementation(shot), to: ShotFunction.self),
            selector: shotSelector,
            encoding: encoding,
            jpegEncoding: jpegEncoding
        ))
    }

    /// The instance method `selector` of `cls`, when its Objective-C type
    /// encoding is `expected` — the shape this file calls it with.
    static func checkedMethod(_ cls: AnyClass, _ selector: Selector, _ expected: String) -> Result<Method, Unavailable> {
        let name = NSStringFromSelector(selector)
        guard let found = class_getInstanceMethod(cls, selector) else {
            return .failure(.missingMethod("\(NSStringFromClass(cls)) -\(name)"))
        }
        let actual = method_getTypeEncoding(found).map { String(cString: $0) } ?? ""
        guard actual == expected else {
            return .failure(.signatureChanged(method: "\(NSStringFromClass(cls)) -\(name)", encoding: actual))
        }
        return .success(found)
    }

    /// The screen inside `rect` (points), at the screen's pixel scale; nil
    /// when the method can't be used, the rect is empty, or the capture
    /// fails (the caller falls back to the whole screen).
    static func capture(_ rect: CGRect, of screen: AnyObject) -> CGImage? {
        guard case .success(let api) = api,
              let data = shot(api, api.encoding, rect, of: screen),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    /// The screen inside `rect` (points) as JPEG bytes, not decoded; nil
    /// when the method or the JPEG encoding can't be used, the rect is
    /// empty, or the capture fails.
    static func captureJPEGData(_ rect: CGRect, of screen: AnyObject) -> Data? {
        guard case .success(let api) = api, let jpeg = api.jpegEncoding else { return nil }
        return shot(api, jpeg, rect, of: screen)
    }

    /// Whether `captureJPEGData` can be used.
    static var jpegEncodingAvailable: Bool {
        if case .success(let api) = api { return api.jpegEncoding != nil }
        return false
    }

    /// The encoded bytes of one capture of `rect` with `encoding`.
    private static func shot(_ api: API, _ encoding: AnyObject, _ rect: CGRect, of screen: AnyObject) -> Data? {
        guard !rect.isNull, !rect.isEmpty else { return nil }
        var error: NSError?
        guard let image = api.shot(screen, api.selector, encoding, rect, &error) as? NSObject,
              image.responds(to: NSSelectorFromString(imageDataSelectorName)) else { return nil }
        return image.value(forKey: imageDataSelectorName) as? Data
    }
}
