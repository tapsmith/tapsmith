import { test as base, type Device } from "tapsmith"
import {
  NativeAccessibilityScreen,
  NativeDialogsScreen,
  NativeGesturesScreen,
  NativeHomeScreen,
  NativeKeyboardScreen,
  NativeListScreen,
  NativeLoginScreen,
  NativeScrollScreen,
  NativeSlowLoadScreen,
  NativeTabsScreen,
  NativeTogglesScreen,
  UIKitControlsScreen,
  UIKitDialogsScreen,
  UIKitGesturesScreen,
  UIKitKeyboardScreen,
  UIKitTableScreen,
} from "./screens/native-screens.js"

type NativeFixtures = {
  home: NativeHomeScreen
  login: NativeLoginScreen
  toggles: NativeTogglesScreen
  list: NativeListScreen
  dialogs: NativeDialogsScreen
  scroll: NativeScrollScreen
  keyboard: NativeKeyboardScreen
  tabs: NativeTabsScreen
  gestures: NativeGesturesScreen
  slowLoad: NativeSlowLoadScreen
  a11y: NativeAccessibilityScreen
  uikitControls: UIKitControlsScreen
  uikitTable: UIKitTableScreen
  uikitDialogs: UIKitDialogsScreen
  uikitKeyboard: UIKitKeyboardScreen
  uikitGestures: UIKitGesturesScreen
}

export const test = base.extend<NativeFixtures>({
  home: async ({ device }, use) => { await use(new NativeHomeScreen(device)) },
  login: async ({ device }, use) => { await use(new NativeLoginScreen(device)) },
  toggles: async ({ device }, use) => { await use(new NativeTogglesScreen(device)) },
  list: async ({ device }, use) => { await use(new NativeListScreen(device)) },
  dialogs: async ({ device }, use) => { await use(new NativeDialogsScreen(device)) },
  scroll: async ({ device }, use) => { await use(new NativeScrollScreen(device)) },
  keyboard: async ({ device }, use) => { await use(new NativeKeyboardScreen(device)) },
  tabs: async ({ device }, use) => { await use(new NativeTabsScreen(device)) },
  gestures: async ({ device }, use) => { await use(new NativeGesturesScreen(device)) },
  slowLoad: async ({ device }, use) => { await use(new NativeSlowLoadScreen(device)) },
  a11y: async ({ device }, use) => { await use(new NativeAccessibilityScreen(device)) },
  uikitControls: async ({ device }, use) => { await use(new UIKitControlsScreen(device)) },
  uikitTable: async ({ device }, use) => { await use(new UIKitTableScreen(device)) },
  uikitDialogs: async ({ device }, use) => { await use(new UIKitDialogsScreen(device)) },
  uikitKeyboard: async ({ device }, use) => { await use(new UIKitKeyboardScreen(device)) },
  uikitGestures: async ({ device }, use) => { await use(new UIKitGesturesScreen(device)) },
})

export { describe, expect } from "tapsmith"

/** Replace the navigation stack with `screen` (see native-ios-test-app/Sources/App.swift). */
export async function openScreen(device: Device, screen: string) {
  await device.openDeepLink(`tapsmithnative://${screen}`)
}
