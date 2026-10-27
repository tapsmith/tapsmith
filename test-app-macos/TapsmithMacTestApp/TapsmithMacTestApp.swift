import SwiftUI

@main
struct TapsmithMacTestApp: App {
    var body: some Scene {
        WindowGroup("Tapsmith Mac Test App") {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var count = 0
    @State private var name = ""
    @State private var agreed = false
    // Persisted (UserDefaults): survives a relaunch, gone after a data clear.
    @AppStorage("savedCount") private var savedCount = 0

    var body: some View {
        VStack(spacing: 12) {
            Text("Count: \(count)")
                .accessibilityIdentifier("countLabel")
            Button("Increment") { count += 1 }
                .accessibilityIdentifier("incrementButton")
            TextField("Your name", text: $name)
                .frame(width: 220)
                .accessibilityIdentifier("nameField")
            Text("Hello, \(name.isEmpty ? "nobody" : name)")
                .accessibilityIdentifier("greeting")
            Toggle("I agree", isOn: $agreed)
                .accessibilityIdentifier("agreeToggle")
            Text(agreed ? "Agreed" : "Not agreed")
                .accessibilityIdentifier("agreeState")
            Text("Saved: \(savedCount)")
                .accessibilityIdentifier("savedCountLabel")
            Button("Save count") { savedCount = count }
                .accessibilityIdentifier("saveButton")
        }
        .padding(30)
    }
}
