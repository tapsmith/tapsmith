import { test as base, type Device } from "tapsmith"
import {
  NativeAccessibilityScreen,
  NativeBackKeyScreen,
  NativeDialogsScreen,
  NativeGesturesScreen,
  NativeHomeScreen,
  NativeKeyboardScreen,
  NativeListScreen,
  NativeLoginScreen,
  NativeScrollScreen,
  NativeSidebarTabsScreen,
  NativeSlowLoadScreen,
  NativeTabsScreen,
  NativeTogglesScreen,
  NativeToolbarScreen,
  UIKitControlsScreen,
  UIKitDialogsScreen,
  UIKitEditScreen,
  UIKitGesturesScreen,
  UIKitKeyboardScreen,
  UIKitSettingsScreen,
  UIKitTableScreen,
} from "./screens/native-screens.js"

type NativeFixtures = {
  home: NativeHomeScreen
  login: NativeLoginScreen
  toggles: NativeTogglesScreen
  toolbar: NativeToolbarScreen
  list: NativeListScreen
  dialogs: NativeDialogsScreen
  scroll: NativeScrollScreen
  keyboard: NativeKeyboardScreen
  tabs: NativeTabsScreen
  sidebarTabs: NativeSidebarTabsScreen
  gestures: NativeGesturesScreen
  slowLoad: NativeSlowLoadScreen
  a11y: NativeAccessibilityScreen
  backKey: NativeBackKeyScreen
  uikitControls: UIKitControlsScreen
  uikitTable: UIKitTableScreen
  uikitDialogs: UIKitDialogsScreen
  uikitKeyboard: UIKitKeyboardScreen
  uikitGestures: UIKitGesturesScreen
  uikitSettings: UIKitSettingsScreen
  uikitEdit: UIKitEditScreen
}

export const test = base.extend<NativeFixtures>({
  home: async ({ device }, use) => { await use(new NativeHomeScreen(device)) },
  login: async ({ device }, use) => { await use(new NativeLoginScreen(device)) },
  toggles: async ({ device }, use) => { await use(new NativeTogglesScreen(device)) },
  toolbar: async ({ device }, use) => { await use(new NativeToolbarScreen(device)) },
  list: async ({ device }, use) => { await use(new NativeListScreen(device)) },
  dialogs: async ({ device }, use) => { await use(new NativeDialogsScreen(device)) },
  scroll: async ({ device }, use) => { await use(new NativeScrollScreen(device)) },
  keyboard: async ({ device }, use) => { await use(new NativeKeyboardScreen(device)) },
  tabs: async ({ device }, use) => { await use(new NativeTabsScreen(device)) },
  sidebarTabs: async ({ device }, use) => { await use(new NativeSidebarTabsScreen(device)) },
  gestures: async ({ device }, use) => { await use(new NativeGesturesScreen(device)) },
  slowLoad: async ({ device }, use) => { await use(new NativeSlowLoadScreen(device)) },
  a11y: async ({ device }, use) => { await use(new NativeAccessibilityScreen(device)) },
  backKey: async ({ device }, use) => { await use(new NativeBackKeyScreen(device)) },
  uikitControls: async ({ device }, use) => { await use(new UIKitControlsScreen(device)) },
  uikitTable: async ({ device }, use) => { await use(new UIKitTableScreen(device)) },
  uikitDialogs: async ({ device }, use) => { await use(new UIKitDialogsScreen(device)) },
  uikitKeyboard: async ({ device }, use) => { await use(new UIKitKeyboardScreen(device)) },
  uikitGestures: async ({ device }, use) => { await use(new UIKitGesturesScreen(device)) },
  uikitSettings: async ({ device }, use) => { await use(new UIKitSettingsScreen(device)) },
  uikitEdit: async ({ device }, use) => { await use(new UIKitEditScreen(device)) },
})

export { describe, expect } from "tapsmith"

/** Replace the navigation stack with `screen` (see native-ios-test-app/Sources/App.swift). */
export async function openScreen(device: Device, screen: string) {
  await device.openDeepLink(`tapsmithnative://${screen}`)
}
