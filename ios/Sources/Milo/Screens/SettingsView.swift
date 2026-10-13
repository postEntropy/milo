import SwiftUI

/**
 The settings the daemon owns. Nothing is kept on the phone: the screen reads the
 daemon's `overview` and writes with the daemon's own actions, so the terminal,
 the browser and this cannot come to disagree about what is configured.

 One exception, marked where it sits: how this screen folds a chain of tool calls. The
 browser draws every link of it and has nothing to fold, so a setting the daemon held
 would be a rule one surface quietly ignored — this is a decision about a phone's
 screen, and it is kept where it is made.
 */
struct SettingsView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var picker = false
    /// Read and written straight through: the chain under a message reads the same key,
    /// so a toggle here is a toggle there the moment it moves.
    @AppStorage("tools-folded") private var foldedTools = false

    var body: some View {
        NavigationStack {
            List {
                Section("Model") {
                    Button { picker = true } label: {
                        // The id in full: a settings screen is where the exact
                        // name is information rather than noise.
                        LabeledContent("Model", value: model.modelName.isEmpty ? "—" : model.modelName)
                    }
                    Picker("Reasoning", selection: effort) {
                        ForEach(model.efforts, id: \.self) { value in
                            Text(SettingsWording.of(value)).tag(value)
                        }
                    }
                }

                Section {
                    Picker("Mode", selection: permission) {
                        ForEach(model.permissionModes, id: \.self) { value in
                            Text(SettingsWording.of(value)).tag(value)
                        }
                    }
                } header: {
                    Text("Permissions")
                } footer: {
                    // Said once, and only where it matters: with this on, nothing
                    // waits for the person.
                    Text(model.permissionMode == "yolo"
                        ? "Nothing asks before it runs."
                        : "A tool that can change something waits for you.")
                }

                Section("Display") {
                    Picker("Tools", selection: tools) {
                        ForEach(model.toolLevels, id: \.self) { value in
                            Text(SettingsWording.of(value)).tag(value)
                        }
                    }
                    Toggle("Reasoning shown", isOn: thinking)
                    Toggle("Tool calls folded", isOn: $foldedTools)
                }

                Section("Daemon") {
                    LabeledContent("Address", value: account.display)
                    LabeledContent("State", value: model.connection.wording)
                }

                if let error = model.settingsError {
                    Section {
                        Text(error)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.danger)
                    }
                }

                Section {
                    Button("Unpair this phone", role: .destructive) {
                        model.unpair()
                        dismiss()
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.loadSettings() }
            .sheet(isPresented: $picker) { ModelPickerSheet() }
        }
    }

    /*
     Each control writes as it is set, and the local value is only taken once the
     daemon has agreed — a control that reads as moved when the write failed would
     be the screen lying.
     */
    private var effort: Binding<String> {
        Binding(
            get: { model.effort },
            set: { value in Task { await model.setEffort(value) } }
        )
    }

    private var permission: Binding<String> {
        Binding(
            get: { model.permissionMode },
            set: { value in Task { await model.setPermissionMode(value) } }
        )
    }

    private var tools: Binding<String> {
        Binding(
            get: { model.toolDisplay },
            set: { value in Task { await model.setToolDisplay(value) } }
        )
    }

    private var thinking: Binding<Bool> {
        Binding(
            get: { model.showThinking },
            set: { value in Task { await model.setShowThinking(value) } }
        )
    }
}

/**
 How a bare token reads as a control. The daemon sends the *values* it accepts —
 the set a client may offer — and the words are this surface's. A token this app
 has never seen still shows, capitalised, rather than being dropped from the
 screen because nobody taught the phone about it.
 */
enum SettingsWording {
    static func of(_ value: String) -> String {
        switch value {
        case "yolo": return "YOLO"
        case "name": return "Name only"
        default: return value.prefix(1).uppercased() + String(value.dropFirst())
        }
    }
}
