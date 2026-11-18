#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Catches Objective-C NSExceptions that bypass Swift's do/catch.
/// XCUITest private APIs can throw NSException which crashes the agent
/// if not caught at the ObjC level.
@interface ObjCExceptionCatcher : NSObject
/// Run `block`; if it throws an NSException, return it as an NSError.
/// Returns nil on success.
+ (nullable NSError *)catchExceptionInBlock:(void(NS_NOESCAPE ^)(void))block;

/// Whether a `catchExceptionInBlock:` is running on the calling thread, so an
/// exception raised here now is caught rather than ending the process
/// (PILOT-978: XCTestIssueRelay raises only then).
+ (BOOL)isCatchingOnCurrentThread;
@end

NS_ASSUME_NONNULL_END
