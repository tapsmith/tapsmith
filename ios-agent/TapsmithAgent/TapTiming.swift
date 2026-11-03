import XCTest

/// How long the agent's taps hold their touch. Pure, so the rule is
/// host-testable; `EventSynthesizer.tap(at:hold:)` takes the hold it picks.
///
/// Two holds, chosen by what the touch lands on:
///
/// - **Within one display frame (10 ms)**, the default. React Native gives a
///   touch to the scroll view around it when a scroll event arrives while the
///   touch is down, even from a nested scroll view that moves by itself (a
///   carousel paging itself beside the button), and the press is cancelled:
///   the tap reports success and nothing happens. Beside a self-paging
///   carousel, 20 ms holds lost 11 of 80 taps and 10 ms holds none
///   (Speedrun's agent: 100 ms lost 3 in 40, 20 ms 1 in 30, 10 ms none in 576).
/// - **Across a frame (20 ms)** for UIKit controls that read a touch on a
///   display frame: a UISwitch never toggles from a 12 ms touch and always
///   does from 17 ms. So switches, toggles, checkboxes, every element type not
///   known to be safe at one frame (sliders, steppers, segmented controls,
///   pickers…), anything inside such a control (a segment, a stepper's
///   increment button) or inside an alert or action sheet, and a touch whose
///   target is unknown (a tap at a coordinate) are held 20 ms.
enum TapTiming {
    /// A touch on anything not listed below: lifted inside one 60 Hz frame,
    /// so no scroll event can arrive between its start and its end.
    static let oneFrameHold: TimeInterval = 0.010

    /// A touch on a control that needs it to span a display frame, or on an
    /// unknown target.
    static let frameSpanningHold: TimeInterval = 0.020

    /// The shortest hold a UISwitch reliably toggles from: one 60 Hz frame.
    static let minimumControlHold: TimeInterval = 0.017

    /// Element types a one-frame touch is known to work on (React Native's
    /// touchables are buttons or plain views; UIKit buttons, cells, links and
    /// text inputs act on the touch's end). Anything else gets
    /// `frameSpanningHold`.
    static let oneFrameTypes: Set<XCUIElement.ElementType> = [
        .application, .window, .other, .group,
        .button, .staticText, .image, .icon, .link, .cell,
        .textField, .secureTextField, .searchField, .textView,
        .table, .collectionView, .scrollView, .webView,
        .navigationBar, .tabBar, .toolbar, .statusBar,
        .keyboard, .key,
        .activityIndicator, .progressIndicator,
    ]

    /// Containers whose parts are touched as UIKit controls: a segmented
    /// control's segments and a stepper's buttons are buttons of their own,
    /// and so are an alert's and an action sheet's.
    static let frameReadingContainers: Set<XCUIElement.ElementType> = [
        .alert, .sheet,
        .segmentedControl, .stepper, .picker, .pickerWheel, .datePicker,
        .switch, .toggle, .checkBox, .slider,
        .menu, .menuBar, .popUpButton, .comboBox, .pageIndicator,
    ]

    /// The hold for a tap on an element of `elementType` (nil: unknown, as
    /// for a tap at a coordinate) inside elements of `ancestors`' types.
    static func hold(
        for elementType: XCUIElement.ElementType?,
        within ancestors: [XCUIElement.ElementType] = []
    ) -> TimeInterval {
        guard let elementType, oneFrameTypes.contains(elementType),
              !ancestors.contains(where: frameReadingContainers.contains)
        else { return frameSpanningHold }
        return oneFrameHold
    }
}
