import { Device } from "tapsmith"

export class ListScreen {
  constructor(private device: Device) {}

  get itemCount() { return this.device.getByTestId("item-count") }
  get selectedCount() { return this.device.getByTestId("selected-count") }
  // The "Item N" rows only: a substring "Item" also matches "30 items" and
  // the "Search items..." field, as getByText ignores case (PILOT-522).
  get allItems() { return this.device.getByText(/^Item \d+$/) }
  get firstItem() { return this.device.getByDescription("Item 1") }

  item(n: number) { return this.device.getByDescription(`Item ${n}`) }
  itemByText(label: string) { return this.device.getByText(label, { exact: true }) }
}
