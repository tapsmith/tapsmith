import { TabBarScrollList } from "../../components/tab-bar-scroll-list"

/** The row starts just below the list's bottom edge: behind the tab bar, on screen. */
export default function BelowTab() {
  return <TabBarScrollList targetLabel="Row below the list" targetTop={(h) => h + 4} />
}
