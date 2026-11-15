import SwiftUI

/// A folder is optional Session context; choosing one needs no project setup step.
struct SessionFolderSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var browsing = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).foregroundStyle(MiloTheme.danger) }
                }
                if let current = model.sessionProject {
                    Section("Current folder") {
                        LabeledContent(current.name, value: current.path)
                        Button("Clear folder") { choose(nil) }
                    }
                }
                Section {
                    Button { browsing = true } label: { Label("Choose folder…", systemImage: "folder.badge.plus") }
                }
                if !model.projects.isEmpty {
                    Section("Recent folders") {
                        ForEach(model.projects) { project in
                            Button { choose(project.path) } label: {
                                VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                                    Text(project.name).foregroundStyle(MiloTheme.foreground)
                                    Text(project.error ?? project.path)
                                        .font(MiloTheme.Text.small)
                                        .foregroundStyle(MiloTheme.muted)
                                        .lineLimit(2)
                                }
                            }
                            .disabled(project.error != nil)
                        }
                    }
                }
                if saving { ProgressView("Changing folder…") }
            }
            .disabled(saving)
            .navigationTitle("Folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(saving) } }
            .sheet(isPresented: $browsing) {
                FolderPicker { path in browsing = false; choose(path) }
            }
            .task { await model.refreshProjects() }
        }
        .interactiveDismissDisabled(saving)
    }

    private func choose(_ path: String?) {
        guard !saving else { return }
        saving = true
        error = nil
        Task {
            if await model.setSessionFolder(path) { dismiss() }
            else { error = model.note?.text ?? "Could not change the Session folder." }
            saving = false
        }
    }
}
