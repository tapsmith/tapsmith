import { ROW_HEIGHT, TabBarScrollList } from "../../components/tab-bar-scroll-list"

/** The list starts scrolled so the row sits just above its top edge, under the status line. */
export default function AboveTab() {
  return (
    <TabBarScrollList
      targetLabel="Row above the list"
      targetTop={(h) => h}
      initialOffset={(h) => h + ROW_HEIGHT + 4}
    />
  )
}
