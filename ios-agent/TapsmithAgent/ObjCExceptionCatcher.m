#import "ObjCExceptionCatcher.h"

/// How many catchExceptionInBlock: calls are running on this thread.
static _Thread_local NSInteger catchDepth = 0;

@implementation ObjCExceptionCatcher

+ (nullable NSError *)catchExceptionInBlock:(void(NS_NOESCAPE ^)(void))block {
    catchDepth += 1;
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return [NSError errorWithDomain:@"dev.tapsmith.agent"
                                   code:-1
                               userInfo:@{
            NSLocalizedDescriptionKey: exception.reason ?: exception.name
        }];
    } @finally {
        catchDepth -= 1;
    }
}

+ (BOOL)isCatchingOnCurrentThread {
    return catchDepth > 0;
}

@end
