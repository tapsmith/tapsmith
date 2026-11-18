import CoreGraphics

/// Where an element-to-element drag (`dragAndDrop`) starts and ends. Pure, so
/// the rules are host-testable.
enum DragPlan {
    /// The drag's start and end in the app's interface space: a point inside
    /// each frame, biased toward the other frame and kept off the frame's
    /// edges, so the path stays clear of system-edge gestures.
    static func points(from sourceFrame: CGRect, to targetFrame: CGRect) -> (start: CGPoint, end: CGPoint) {
        (anchor(in: sourceFrame, toward: targetFrame), anchor(in: targetFrame, toward: sourceFrame))
    }

    /// `points` where the agent's synthesized touch places them. Its event
    /// record carries the runner's own interface orientation, not the app's,
    /// so it reads points in the device's native portrait space, as the HID
    /// helper does (the UI-mode mirror turns its points the same way). The
    /// frames come from a snapshot in the app's interface space, which on a
    /// turned screen is not that space: each point is mapped as
    /// `HidTouch.nativePoint` maps a tap's. `screen` is the app's window as
    /// that snapshot saw it. When the mapping cannot be told, the points stand.
    static func nativePoints(
        from sourceFrame: CGRect,
        to targetFrame: CGRect,
        screen: CGSize,
        device: HidTouch.DeviceTurn
    ) -> (start: CGPoint, end: CGPoint) {
        let planned = points(from: sourceFrame, to: targetFrame)
        guard let start = HidTouch.nativePoint(planned.start, screen: screen, device: device),
              let end = HidTouch.nativePoint(planned.end, screen: screen, device: device)
        else { return planned }
        return (start, end)
    }

    private static func anchor(in frame: CGRect, toward otherFrame: CGRect) -> CGPoint {
        let horizontalBias = otherFrame.midX >= frame.midX ? 0.75 : 0.25
        let verticalBias = otherFrame.midY >= frame.midY ? 0.75 : 0.25
        let edgeInset = min(max(min(frame.width, frame.height) * 0.18, 10), 24)

        let preferredX = frame.minX + frame.width * horizontalBias
        let preferredY = frame.minY + frame.height * verticalBias

        return CGPoint(
            x: min(max(preferredX, frame.minX + edgeInset), frame.maxX - edgeInset),
            y: min(max(preferredY, frame.minY + edgeInset), frame.maxY - edgeInset)
        )
    }
}
