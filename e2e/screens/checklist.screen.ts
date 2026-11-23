import { Device } from "tapsmith"

export class ChecklistScreen {
  constructor(private device: Device) {}

  get status() { return this.device.getByTestId("checklist-status") }

  // A checkbox named "Toggle <task>" beside the task's text
  checkbox(task: string) { return this.device.getByLabel(`Toggle ${task}`) }
  taskText(task: string) { return this.device.getByText(task) }

  // A Pressable with accessibilityRole="switch", its label shown beside it
  get remindSwitch() { return this.device.getByLabel("Remind me") }
  get remindText() { return this.device.getByText("Remind me") }
}
