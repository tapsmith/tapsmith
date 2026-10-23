import SwiftUI

// ─── Login ───

struct LoginView: View {
    @State private var email = ""
    @State private var password = ""
    @State private var message = ""

    var body: some View {
        Form {
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            SecureField("Password", text: $password)
            Button("Sign In") {
                message = password == "secret" ? "Welcome, \(email)" : "Invalid credentials"
            }
            .disabled(email.isEmpty || password.isEmpty)
            if !message.isEmpty {
                Text(message)
            }
        }
        .navigationTitle("Login Form")
    }
}

// ─── Toggles ───

struct TogglesView: View {
    @State private var darkMode = false
    @State private var notifications = true
    @State private var size = "Medium"
    @State private var quantity = 1
    @State private var volume = 50.0

    var body: some View {
        Form {
            Section("Switches") {
                Toggle("Dark Mode", isOn: $darkMode)
                Toggle("Notifications", isOn: $notifications)
            }
            Section("Size") {
                Picker("Size", selection: $size) {
                    ForEach(["Small", "Medium", "Large"], id: \.self) { Text($0) }
                }
                .pickerStyle(.segmented)
                Text("Selected size: \(size)")
            }
            Section("Quantity") {
                Stepper("Quantity: \(quantity)", value: $quantity, in: 0...10)
            }
            Section("Volume") {
                Slider(value: $volume, in: 0...100) { Text("Volume") }
                Text("Volume: \(Int(volume))")
            }
        }
        .navigationTitle("Toggles")
    }
}

// ─── List ───

struct ItemListView: View {
    @State private var items = (1...100).map { "Item \($0)" }

    var body: some View {
        List {
            ForEach(items, id: \.self) { item in
                NavigationLink(item) {
                    Text("Detail for \(item)").navigationTitle(item)
                }
            }
            .onDelete { items.remove(atOffsets: $0) }
        }
        .navigationTitle("List")
    }
}

// ─── Dialogs ───

struct DialogsView: View {
    @State private var showAlert = false
    @State private var showConfirm = false
    @State private var showSheet = false
    @State private var result = "None"

    var body: some View {
        VStack(spacing: 20) {
            Button("Show Alert") { showAlert = true }
            Button("Show Confirmation") { showConfirm = true }
            Button("Show Sheet") { showSheet = true }
            Text("Result: \(result)")
        }
        .navigationTitle("Dialogs")
        .alert("Delete file?", isPresented: $showAlert) {
            Button("Delete", role: .destructive) { result = "Deleted" }
            Button("Cancel", role: .cancel) { result = "Cancelled" }
        } message: {
            Text("This cannot be undone.")
        }
        .confirmationDialog("Share photo", isPresented: $showConfirm, titleVisibility: .visible) {
            Button("Copy Link") { result = "Copied" }
            Button("Cancel", role: .cancel) { result = "Dismissed" }
        }
        .sheet(isPresented: $showSheet) {
            NavigationStack {
                Text("Sheet content")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { result = "Sheet closed"; showSheet = false }
                        }
                    }
                    .navigationTitle("Sheet")
            }
        }
    }
}

// ─── Scroll ───

struct ScrollScreenView: View {
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(1...60, id: \.self) { i in
                    Text("Row \(i)").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                Text("End of content").accessibilityIdentifier("scroll-end")
            }
            .padding()
        }
        .navigationTitle("Scroll")
    }
}

// ─── Keyboard ───

struct KeyboardView: View {
    @State private var name = ""
    @State private var submitted = ""
    @State private var notes = ""
    @State private var untappable = ""

    var body: some View {
        Form {
            TextField("Your name", text: $name)
                .submitLabel(.done)
                .onSubmit { submitted = name }
            Text(submitted.isEmpty ? "Nothing submitted" : "Submitted: \(submitted)")
            TextEditor(text: $notes)
                .frame(height: 100)
                .accessibilityIdentifier("notes")
            Button("Save Notes") { submitted = "notes (\(notes.count) chars)" }
            // An editable field that touches never reach: a tap to focus it
            // focuses nothing (PILOT-829's failure, made certain).
            TextField("Not tappable", text: $untappable)
                .allowsHitTesting(false)
        }
        .navigationTitle("Keyboard")
    }
}

// ─── Tabs ───

struct TabsView: View {
    var body: some View {
        TabView {
            Text("Feed tab content")
                .tabItem { Label("Feed", systemImage: "house") }
            Text("Search tab content")
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            Text("Profile tab content")
                .tabItem { Label("Profile", systemImage: "person") }
        }
        .navigationTitle("Tabs")
    }
}

// ─── Gestures ───

struct GesturesView: View {
    @State private var status = "Waiting"
    @State private var offset = CGSize.zero

    var body: some View {
        VStack(spacing: 24) {
            Text("Status: \(status)")
            Text("Long press me")
                .padding()
                .background(.blue.opacity(0.2))
                .onLongPressGesture(minimumDuration: 0.8) { status = "Long pressed" }
                .accessibilityAddTraits(.isButton)
            Text("Double tap me")
                .padding()
                .background(.green.opacity(0.2))
                .onTapGesture(count: 2) { status = "Double tapped" }
                .accessibilityAddTraits(.isButton)
            RoundedRectangle(cornerRadius: 12)
                .fill(.orange.opacity(0.3))
                .frame(height: 160)
                .overlay(Text("Swipe area"))
                .gesture(DragGesture(minimumDistance: 30).onEnded { value in
                    status = value.translation.width < 0 ? "Swiped left" : "Swiped right"
                })
                .accessibilityIdentifier("swipe-area")
        }
        .padding()
        .navigationTitle("Gestures")
    }
}

// ─── Slow load ───

struct SlowLoadView: View {
    @State private var loaded = false

    var body: some View {
        Group {
            if loaded {
                Text("Loaded content")
            } else {
                ProgressView("Loading…")
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(3))
            loaded = true
        }
        .navigationTitle("Slow Load")
    }
}

// ─── Accessibility ───

struct AccessibilityView: View {
    @State private var count = 0

    var body: some View {
        VStack(spacing: 16) {
            Text("Section Heading").font(.title2).accessibilityAddTraits(.isHeader)
            Image(systemName: "star.fill")
                .accessibilityLabel("Favourite star")
            Button {
                count += 1
            } label: {
                Image(systemName: "plus.circle")
            }
            .accessibilityLabel("Increment")
            .accessibilityIdentifier("increment-button")
            Text("Count: \(count)")
            Button("Disabled Action") {}.disabled(true)
            Link("Tapsmith website", destination: URL(string: "https://example.com")!)
            Text("Hidden from accessibility").accessibilityHidden(true)
            Text("Hint target")
                .accessibilityHint("Shows extra details")
        }
        .padding()
        .navigationTitle("Accessibility")
    }
}
