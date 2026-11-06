import SwiftUI

struct FolderPicker: View {
    let onChoose: (String) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var listing: FolderListing?
    @State private var error: String?
    @State private var busy = false
    /// Whether a folder name is being asked for — a project's folder may not exist yet,
    /// and a picker with no way to make one is a picker that can only say no.
    @State private var naming = false
    @State private var folderDraft = ""

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section {
                        Text(error)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.danger)
                        // A folder that could not be read left the way forward disabled;
                        // this is the way to ask again instead of a dead end.
                        Button("Try again") { Task { await open(listing?.path) } }
                            .disabled(busy)
                    }
                }

                Section {
                    if busy, listing == nil {
                        HStack(spacing: MiloTheme.Space.two) {
                            ProgressView().controlSize(.small)
                            Text("Reading folders…").foregroundStyle(MiloTheme.muted)
                        }
                    }

                    if let parent = listing?.parent {
                        Button {
                            Task { await open(parent) }
                        } label: {
                            Label("Up", systemImage: "arrow.up")
                                .foregroundStyle(MiloTheme.foreground)
                        }
                        .disabled(busy)
                    }

                    ForEach(listing?.folders ?? []) { folder in
                        Button {
                            Task { await open(folder.path) }
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                Image(systemName: "folder")
                                    .foregroundStyle(MiloTheme.accent)
                                Text(folder.name)
                                    .foregroundStyle(MiloTheme.foreground)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: MiloTheme.Space.two)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(MiloTheme.muted)
                            }
                        }
                        .disabled(busy)
                    }

                    if listing?.truncated == true {
                        Text("Only the first folders are shown — there are more than fit here.")
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.muted)
                    }
                } header: {
                    // A folder's own path is read the way a file's is: the last segment — the
                    // folder being looked at — is the part that cannot be given up.
                    Text(listing?.path ?? " ")
                        .font(MiloTheme.Text.meta.monospaced())
                        .textCase(nil)
                        .lineLimit(1)
                        .truncationMode(.head)
                } footer: {
                    Text("These are the folders of the machine Milo runs on, not this phone's.")
                }
            }
            .navigationTitle("Choose a folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        folderDraft = ""
                        naming = true
                    } label: {
                        Image(systemName: "folder.badge.plus")
                    }
                    .accessibilityLabel("New folder")
                    .disabled(listing == nil || busy)
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Use this folder") {
                        guard let path = listing?.path else { return }
                        onChoose(path)
                        dismiss()
                    }
                    .disabled(listing == nil || busy)
                }
            }
            .task { await open(nil) }
            .alert("New folder", isPresented: $naming) {
                TextField("Folder name", text: $folderDraft)
                Button("Create") { create() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Inside \(listing?.path ?? "this folder").")
            }
        }
    }

    private func create() {
        guard let parent = listing?.path else { return }
        let name = folderDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { await make(parent: parent, name: name) }
    }

    private func make(parent: String, name: String) async {
        busy = true
        defer { busy = false }
        do {
            listing = try await model.createFolder(parent, name: name)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func open(_ path: String?) async {
        busy = true
        defer { busy = false }
        do {
            listing = try await model.browseFolders(path)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
