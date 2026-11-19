import CoreGraphics

/// Where the agent's own synthesized touch (`EventSynthesizer`) lands a
/// point the agent planned in the app's interface space. Pure, so the rules
/// are host-testable.
///
/// The agent plans from snapshot frames and `XCUIElement.frame`, which are in
/// the app's interface space: on a turned screen, wider than tall. The touch
/// reads its points in the device's native portrait space (its event record
/// says the interface is upright), as the daemon's HID helper does. So each
/// point is mapped as `HidTouch.nativePoint` maps a HID tap's. When the way
/// the screen is turned cannot be told, a point stands, as it did before
/// this mapping: right only on an upright screen.
///
/// Points that callers give in native portrait space already (`tapXY`,
/// `longPressXY`, `dragXY`, UI-mode mirror touches) do not go through it.
struct TouchSpace: Equatable {
    /// The app's window as the plan's snapshot saw it.
    var screen: CGSize
    /// Which way the device is turned now (`XCUIDevice.orientation`).
    var device: HidTouch.DeviceTurn

    /// `point`, in the app's interface space, where the touch must press it.
    func point(_ point: CGPoint) -> CGPoint {
        HidTouch.nativePoint(point, screen: screen, device: device) ?? point
    }

    /// `plan`, made in the app's interface space, with each finger mapped.
    func pinch(_ plan: PinchPlan) -> PinchPlan {
        PinchPlan(
            firstStart: point(plan.firstStart),
            firstEnd: point(plan.firstEnd),
            secondStart: point(plan.secondStart),
            secondEnd: point(plan.secondEnd)
        )
    }

    /// The native portrait region to watch for a touch's target to stop
    /// changing (`TouchSettle`), for `rect` in the app's interface space.
    /// When the turn cannot be told, every place the target could be: both
    /// landscape mappings for a wide window (a device lying flat), the rect
    /// as it stands and turned half way round for a tall one on an
    /// upside-down device. A larger region can make a tap wait for movement
    /// beside its target (up to the settle's bound), never miss movement of
    /// the target itself.
    func settleRect(_ rect: CGRect) -> CGRect {
        if let native = HidTouch.nativeRect(rect, screen: screen, device: device) { return native }
        let candidates: [CGRect]
        if screen.width > screen.height {
            candidates = [HidTouch.DeviceTurn.landscapeLeft, .landscapeRight].compactMap {
                HidTouch.nativeRect(rect, screen: screen, device: $0)
            }
        } else {
            let halfTurned = CGRect(
                x: screen.width - rect.maxX,
                y: screen.height - rect.maxY,
                width: rect.width,
                height: rect.height
            )
            candidates = [rect, halfTurned]
        }
        return candidates.dropFirst().reduce(candidates.first ?? rect) { $0.union($1) }
    }
}
