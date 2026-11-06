import SwiftUI

struct ProjectFiles: View {
    let projectId: String

    @Environment(AppModel.self) private var model
    @State private var tree: WorkTree?
    @State private var error: String?
    /// The file being read, risen from the bottom of the screen — the drawer a changed
    /// file's hunks rise in, rather than a reader that pushes the tree it came from down
    /// the page.
    @State private var reading: WorkNode?
    /// The folder a new one is being made in, by its project-relative path — the empty
    /// string for the project's own root. Nil while the name is not being asked for.
    @State private var naming: String?
    @State private var folderDraft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Text("Files")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
                if let tree {
                    Text("\(tree.files) \(tree.files == 1 ? "file" : "files")")
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }
                MiloIconButton(systemName: "folder.badge.plus", size: 15, span: 34, disabled: tree == nil) {
                    folderDraft = ""
                    naming = ""
                }
                .accessibilityLabel("New folder")
            }

            if let error {
                MiloErrorPill(text: error)
            }

            if let tree {
                if tree.nodes.isEmpty {
                    Text("This folder is empty.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        ForEach(tree.nodes) { node in
                            WorkNodeRow(
                                node: node,
                                onOpen: { reading = $0 },
                                onNewFolder: { parent in
                                    folderDraft = ""
                                    naming = parent.rel
                                }
                            )
                        }
                    }
                    .padding(MiloTheme.Space.three)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }

                // One line for the whole tree, said once: what was cut, and what could not be read.
                if tree.truncated {
                    Text("Only the first \(tree.files) files are shown — the folder holds more than fits here.")
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                }
                if !tree.warnings.isEmpty {
                    Text(tree.warnings.joined(separator: " · "))
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                }
            } else if error == nil {
                HStack(spacing: MiloTheme.Space.two) {
                    ProgressView().controlSize(.small)
                    Text("Reading this folder…")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
        }
        .task { await read() }
        .onChange(of: model.workMoved) { _, _ in Task { await read() } }
        // The file itself, risen from the bottom: a file is read on its own, as a changed
        // file's hunks are, and a long one would otherwise stretch the page it was opened
        // from.
        .sheet(item: $reading) { node in
            WorkFileDetail(projectId: projectId, node: node)
        }
        .alert(
            "New folder",
            isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })
        ) {
            TextField("Folder name", text: $folderDraft)
            Button("Create") { create() }
            Button("Cancel", role: .cancel) { naming = nil }
        } message: {
            Text(naming == "" ? "In this project's folder." : "In \(naming ?? "").")
        }
    }

    private func create() {
        guard let parent = naming else { return }
        let name = folderDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        naming = nil
        guard !name.isEmpty else { return }
        Task {
            do {
                tree = try await model.projectFolder(projectId, parent: parent, name: name)
                error = nil
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func read() async {
        do {
            tree = try await model.projectTree(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// One entry of the tree: a folder that opens onto what is inside it, or a file to read.
/// Folders start folded, so a big repository is drawn as its top level until asked.
private struct WorkNodeRow: View {
    let node: WorkNode
    let onOpen: (WorkNode) -> Void
    /// A new folder asked for inside this one — offered on a folder's hold, so a name is
    /// made where it belongs rather than at the root and moved.
    let onNewFolder: (WorkNode) -> Void

    var body: some View {
        if node.isFolder {
            DisclosureGroup {
                ForEach(node.children) { child in
                    WorkNodeRow(node: child, onOpen: onOpen, onNewFolder: onNewFolder)
                }
            } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "folder")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(MiloTheme.secondary)
                    Text(node.name)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: MiloTheme.Space.two)
                    Text("\(node.children.count)")
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }
                .padding(.vertical, MiloTheme.Space.two)
            }
            .tint(MiloTheme.muted)
            .contextMenu {
                menuItem("New folder", "folder.badge.plus") { onNewFolder(node) }
            }
        } else {
            Button {
                onOpen(node)
            } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 13))
                        .foregroundStyle(MiloTheme.muted)
                    Text(node.name)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: MiloTheme.Space.two)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(node.size ?? 0), countStyle: .file))
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }
                .padding(.vertical, MiloTheme.Space.two)
                .padding(.horizontal, MiloTheme.Space.two)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
        }
    }
}

/**
 One file, read from the daemon a page at a time, risen from the bottom of the screen.

 The page is the core's own cut — the same one the agent's reader takes — so the lines here
 are the lines it was handed, and a long file continues at the offset the page named rather
 than at a guess. It rises in the drawer a changed file's hunks rise in, so a file opened
 from the tree is read on its own instead of stretching the page it was opened from.
 */
private struct WorkFileDetail: View {
    let projectId: String
    let node: WorkNode

    @Environment(AppModel.self) private var model
    @State private var pages: [WorkFilePage] = []
    @State private var error: String?
    @State private var busy = false

    private var first: WorkFilePage? { pages.first }
    private var last: WorkFilePage? { pages.last }
    /// How many lines the pages hold, which is where the range drawn ends.
    private var shown: Int {
        pages.reduce(0) { count, page in
            count + (page.text.isEmpty ? 0 : page.text.split(separator: "\n", omittingEmptySubsequences: false).count)
        }
    }

    var body: some View {
        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                HStack(spacing: MiloTheme.Space.two) {
                    // The same rule the diff's own line keeps: the file's name is the last
                    // thing this gives up, so a long path is cut at its head — and the name is
                    // drawn at the step the drawer's own first line is read at.
                    Text(node.rel)
                        .font(MiloTheme.Text.base.weight(.semibold).monospaced())
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: MiloTheme.Space.two)
                    if let first, first.total > 0 {
                        Text("\(first.total) lines")
                            .font(MiloTheme.Text.small.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                    }
                }

                if let error {
                    Text(error)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                } else if let first {
                    if first.total == 0 {
                        Text("This file is empty.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    } else {
                        // The same block the chat draws code with: monospaced, scrolling
                        // sideways, and marked so the sessions drawer's drag stands down
                        // inside it. The file's own name is what colours it — the same hint
                        // the browser reads.
                        CodeBlock(language: node.rel, code: pages.map(\.text).joined(separator: "\n"))

                        HStack(spacing: MiloTheme.Space.two) {
                            Text("Showing lines \(first.from)–\(first.from + shown - 1) of \(first.total)")
                                .font(MiloTheme.Text.meta)
                                .foregroundStyle(MiloTheme.muted)
                            Spacer(minLength: MiloTheme.Space.two)
                            if let last, let next = last.next {
                                MiloWideButton(
                                    title: busy ? "Reading…" : "Load more",
                                    systemImage: "arrow.down",
                                    busy: busy
                                ) { Task { await read(offset: next) } }
                                .frame(maxWidth: 160)
                            }
                        }
                    }
                } else {
                    HStack(spacing: MiloTheme.Space.two) {
                        ProgressView().controlSize(.small)
                        Text("Reading the file…")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
            }
        }
        .task { await read() }
    }

    private func read(offset: Int? = nil) async {
        busy = true
        defer { busy = false }
        do {
            let page = try await model.projectFile(projectId, path: node.rel, offset: offset)
            pages = offset == nil ? [page] : pages + [page]
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Choosing a folder

/**
 Choosing a folder of the machine Milo runs on: one level at a time, with the way up and the
 folder being looked at, and the one button that settles it.

 This walks the **daemon's** filesystem and never the phone's. The platform's own folder
 picker would offer this device's folders — a path that means nothing where the work happens —
 so it is not used here at all, and the sheet says which machine these folders are.
 */
