import { Device } from "tapsmith"

/**
 * The test app's `/native-tabs` route: expo-router NativeTabs, as the stock
 * create-expo-app template uses (a UITabBar on iOS, a Material bottom
 * navigation bar on Android).
 */
export class NativeTabsScreen {
  constructor(private device: Device) {}

  get tabBar() { return this.device.getByRole("tablist") }
  get tabs() { return this.device.getByRole("tab") }
  tab(name: string) { return this.device.getByRole("tab", { name }) }

  get homeContent() { return this.device.getByText("Home content", { exact: true }) }
  get exploreContent() { return this.device.getByText("Explore content", { exact: true }) }
}
