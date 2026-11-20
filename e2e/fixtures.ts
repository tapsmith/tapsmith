import { test as base } from "tapsmith"
import { AccessibilityScreen } from "./screens/accessibility.screen.js"
import { AnimatingScreen } from "./screens/animating.screen.js"
import { CoversScreen } from "./screens/covers.screen.js"
import { ApiCallsScreen } from "./screens/api-calls.screen.js"
import { CarouselScreen } from "./screens/carousel.screen.js"
import { StackScreen } from "./screens/stack.screen.js"
import { DialogsScreen } from "./screens/dialogs.screen.js"
import { DragScreen } from "./screens/drag.screen.js"
import { GesturesScreen } from "./screens/gestures.screen.js"
import { HomeScreen } from "./screens/home.screen.js"
import { KeyboardScreen } from "./screens/keyboard.screen.js"
import { NativeSettingsScreen } from "./screens/native-settings.screen.js"
import { ListScreen } from "./screens/list.screen.js"
import { LoginScreen } from "./screens/login.screen.js"
import { NativeTabsScreen } from "./screens/native-tabs.screen.js"
import { OcclusionScreen } from "./screens/occlusion.screen.js"
import { PermissionsScreen } from "./screens/permissions.screen.js"
import { PreferencesScreen } from "./screens/preferences.screen.js"
import { ProfileScreen } from "./screens/profile.screen.js"
import { RolesScreen } from "./screens/roles.screen.js"
import { ScrollScreen } from "./screens/scroll.screen.js"
import { SlowLoadScreen } from "./screens/slow-load.screen.js"
import { SpinnerScreen } from "./screens/spinner.screen.js"
import { TogglesScreen } from "./screens/toggles.screen.js"
import { TurnedScreen } from "./screens/turned.screen.js"
import { TypingScreen } from "./screens/typing.screen.js"
import { VisibilityScreen } from "./screens/visibility.screen.js"
import { WebViewScreen } from "./screens/webview.screen.js"

type ScreenFixtures = {
  accessibilityScreen: AccessibilityScreen
  animatingScreen: AnimatingScreen
  apiCallsScreen: ApiCallsScreen
  coversScreen: CoversScreen
  carouselScreen: CarouselScreen
  stackScreen: StackScreen
  dialogsScreen: DialogsScreen
  dragScreen: DragScreen
  gesturesScreen: GesturesScreen
  homeScreen: HomeScreen
  keyboardScreen: KeyboardScreen
  listScreen: ListScreen
  loginScreen: LoginScreen
  nativeSettingsScreen: NativeSettingsScreen
  nativeTabsScreen: NativeTabsScreen
  occlusionScreen: OcclusionScreen
  permissionsScreen: PermissionsScreen
  preferencesScreen: PreferencesScreen
  profileScreen: ProfileScreen
  rolesScreen: RolesScreen
  scrollScreen: ScrollScreen
  slowLoadScreen: SlowLoadScreen
  spinnerScreen: SpinnerScreen
  togglesScreen: TogglesScreen
  turnedScreen: TurnedScreen
  typingScreen: TypingScreen
  visibilityScreen: VisibilityScreen
  webviewScreen: WebViewScreen
}

export const test = base.extend<ScreenFixtures>({
  accessibilityScreen: async ({ device }, use) => {
    await use(new AccessibilityScreen(device))
  },
  animatingScreen: async ({ device }, use) => {
    await use(new AnimatingScreen(device))
  },
  apiCallsScreen: async ({ device }, use) => {
    await use(new ApiCallsScreen(device))
  },
  coversScreen: async ({ device }, use) => {
    await use(new CoversScreen(device))
  },
  carouselScreen: async ({ device }, use) => {
    await use(new CarouselScreen(device))
  },
  stackScreen: async ({ device }, use) => {
    await use(new StackScreen(device))
  },
  dialogsScreen: async ({ device }, use) => {
    await use(new DialogsScreen(device))
  },
  dragScreen: async ({ device }, use) => {
    await use(new DragScreen(device))
  },
  gesturesScreen: async ({ device }, use) => {
    await use(new GesturesScreen(device))
  },
  homeScreen: async ({ device }, use) => {
    await use(new HomeScreen(device))
  },
  keyboardScreen: async ({ device }, use) => {
    await use(new KeyboardScreen(device))
  },
  nativeSettingsScreen: async ({ device }, use) => {
    await use(new NativeSettingsScreen(device))
  },
  listScreen: async ({ device }, use) => {
    await use(new ListScreen(device))
  },
  loginScreen: async ({ device }, use) => {
    await use(new LoginScreen(device))
  },
  nativeTabsScreen: async ({ device }, use) => {
    await use(new NativeTabsScreen(device))
  },
  occlusionScreen: async ({ device }, use) => {
    await use(new OcclusionScreen(device))
  },
  permissionsScreen: async ({ device }, use) => {
    await use(new PermissionsScreen(device))
  },
  preferencesScreen: async ({ device }, use) => {
    await use(new PreferencesScreen(device))
  },
  profileScreen: async ({ device }, use) => {
    await use(new ProfileScreen(device))
  },
  rolesScreen: async ({ device }, use) => {
    await use(new RolesScreen(device))
  },
  scrollScreen: async ({ device }, use) => {
    await use(new ScrollScreen(device))
  },
  slowLoadScreen: async ({ device }, use) => {
    await use(new SlowLoadScreen(device))
  },
  spinnerScreen: async ({ device }, use) => {
    await use(new SpinnerScreen(device))
  },
  togglesScreen: async ({ device }, use) => {
    await use(new TogglesScreen(device))
  },
  turnedScreen: async ({ device }, use) => {
    await use(new TurnedScreen(device))
  },
  typingScreen: async ({ device }, use) => {
    await use(new TypingScreen(device))
  },
  visibilityScreen: async ({ device }, use) => {
    await use(new VisibilityScreen(device))
  },
  webviewScreen: async ({ device }, use) => {
    await use(new WebViewScreen(device))
  },
})

export {
  expect,
  describe,
  flushSoftErrors,
} from "tapsmith"

export type { Device, Route } from "tapsmith"
