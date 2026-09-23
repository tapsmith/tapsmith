import { test as base } from "tapsmith"
import { AccessibilityScreen } from "./screens/accessibility.screen.js"
import { AnimatingScreen } from "./screens/animating.screen.js"
import { ApiCallsScreen } from "./screens/api-calls.screen.js"
import { DialogsScreen } from "./screens/dialogs.screen.js"
import { GesturesScreen } from "./screens/gestures.screen.js"
import { HomeScreen } from "./screens/home.screen.js"
import { ListScreen } from "./screens/list.screen.js"
import { LoginScreen } from "./screens/login.screen.js"
import { OcclusionScreen } from "./screens/occlusion.screen.js"
import { ScrollScreen } from "./screens/scroll.screen.js"
import { SlowLoadScreen } from "./screens/slow-load.screen.js"
import { SpinnerScreen } from "./screens/spinner.screen.js"
import { TogglesScreen } from "./screens/toggles.screen.js"
import { VisibilityScreen } from "./screens/visibility.screen.js"

type ScreenFixtures = {
  accessibilityScreen: AccessibilityScreen
  animatingScreen: AnimatingScreen
  apiCallsScreen: ApiCallsScreen
  dialogsScreen: DialogsScreen
  gesturesScreen: GesturesScreen
  homeScreen: HomeScreen
  listScreen: ListScreen
  loginScreen: LoginScreen
  occlusionScreen: OcclusionScreen
  scrollScreen: ScrollScreen
  slowLoadScreen: SlowLoadScreen
  spinnerScreen: SpinnerScreen
  togglesScreen: TogglesScreen
  visibilityScreen: VisibilityScreen
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
  dialogsScreen: async ({ device }, use) => {
    await use(new DialogsScreen(device))
  },
  gesturesScreen: async ({ device }, use) => {
    await use(new GesturesScreen(device))
  },
  homeScreen: async ({ device }, use) => {
    await use(new HomeScreen(device))
  },
  listScreen: async ({ device }, use) => {
    await use(new ListScreen(device))
  },
  loginScreen: async ({ device }, use) => {
    await use(new LoginScreen(device))
  },
  occlusionScreen: async ({ device }, use) => {
    await use(new OcclusionScreen(device))
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
  visibilityScreen: async ({ device }, use) => {
    await use(new VisibilityScreen(device))
  },
})

export {
  expect,
  describe,
  flushSoftErrors,
} from "tapsmith"

export type { Device, Route } from "tapsmith"
