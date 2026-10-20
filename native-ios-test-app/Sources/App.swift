import SwiftUI

/// A plain SwiftUI app for checking Tapsmith against native iOS controls
/// (the main test app is React Native). Every screen is reachable from the
/// home list and by deep link: `tapsmithnative://<screen>` replaces the
/// navigation stack with that screen, `tapsmithnative://` returns home.
@main
struct TapsmithNativeTestApp: App {
    @State private var path: [Screen] = []

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $path) {
                HomeView()
                    .navigationDestination(for: Screen.self) { $0.view }
            }
            .onOpenURL { url in
                let name = url.host() ?? ""
                path = Screen(rawValue: name).map { [$0] } ?? []
            }
        }
    }
}

enum Screen: String, CaseIterable, Hashable {
    case login, toggles, list, dialogs, scroll, keyboard, tabs, gestures, slowload, accessibility
    case uikitcontrols, uikittable, uikitdialogs, uikitkeyboard, uikitgestures

    var title: String {
        switch self {
        case .login: "Login Form"
        case .toggles: "Toggles"
        case .list: "List"
        case .dialogs: "Dialogs"
        case .scroll: "Scroll"
        case .keyboard: "Keyboard"
        case .tabs: "Tabs"
        case .gestures: "Gestures"
        case .slowload: "Slow Load"
        case .accessibility: "Accessibility"
        case .uikitcontrols: "UIKit Controls"
        case .uikittable: "UIKit Table"
        case .uikitdialogs: "UIKit Dialogs"
        case .uikitkeyboard: "UIKit Keyboard"
        case .uikitgestures: "UIKit Gestures"
        }
    }

    @ViewBuilder var view: some View {
        switch self {
        case .login: LoginView()
        case .toggles: TogglesView()
        case .list: ItemListView()
        case .dialogs: DialogsView()
        case .scroll: ScrollScreenView()
        case .keyboard: KeyboardView()
        case .tabs: TabsView()
        case .gestures: GesturesView()
        case .slowload: SlowLoadView()
        case .accessibility: AccessibilityView()
        case .uikitcontrols: UIKitScreen { UIKitControlsViewController() }.navigationTitle(title)
        case .uikittable: UIKitScreen { UIKitTableViewController() }.navigationTitle(title)
        case .uikitdialogs: UIKitScreen { UIKitDialogsViewController() }.navigationTitle(title)
        case .uikitkeyboard: UIKitScreen { UIKitKeyboardViewController() }.navigationTitle(title)
        case .uikitgestures: UIKitScreen { UIKitGesturesViewController() }.navigationTitle(title)
        }
    }
}

struct HomeView: View {
    var body: some View {
        List(Screen.allCases, id: \.self) { screen in
            NavigationLink(screen.title, value: screen)
        }
        .navigationTitle("Native Screens")
    }
}
