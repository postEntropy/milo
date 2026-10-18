import SwiftUI

/**
 Work: the folders a session may work in, and the sessions that ran in one.

 A project is the only thing that makes a session work somewhere other than the install's
 own folder, so this is where a piece of work is set up and opened — and the chat it opens
 into is the ordinary one, with the ordinary composer. Drawn beside the routines and the
 task lists: the projects on the front page, and one project's own page a level in.
 */
struct WorkView: View {
    /// Whether one project's own page is open on top of the index, told to the shell: the
    /// drawer's swipe belongs to the index, and a page answers the same drag with the way back.
    @Binding var pushed: Bool
    /// The project the shell asked for — set when the drag out of a session in one comes this
    /// way, so the page opens on the project rather than on the list. Cleared as it opens.
    @Binding var opening: String?
    /// Opening the sessions from here. The drawer belongs to the chat, and this screen
    /// reaches it through the same control and the same swipe.
    let onSessions: () -> Void
    /// Going back to the chat — where a session opened or started here lives. The flag says
    /// whether the cursor belongs in the composer, which it does for the one just started.
    let onChat: (Bool) -> Void
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []

    /// Where the platform's own back gesture picks up: a drag that starts this close to the
    /// screen's edge is the system's to answer, so this screen's own one keeps out of it.
    private static let edge: CGFloat = 24

    /// The project the shell named, opened on top of the index — as if it had been chosen
    /// there. Only while the index is what is showing: a page already open is the person's
    /// own place, and a second look would take them off it.
    private func openAsked() {
        guard let wanted = opening, path.isEmpty else { return }
        opening = nil
        guard model.projects.contains(where: { $0.id == wanted }) else { return }
        path = [wanted]
    }

    var body: some View {
        NavigationStack(path: $path) {
            WorkIndex(
                onSelect: { path.append($0) },
                onSessions: onSessions
            )
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { projectId in
                ProjectDetail(
                    projectId: projectId,
                    onBack: { if !path.isEmpty { path.removeLast() } },
                    onRemoved: { path.removeAll { $0 == projectId } },
                    onChat: onChat
                )
            }
        }
        // A drag across a project's own page is the way back to the index — the same drag that
        // opens the sessions from the index itself, answering where the person is standing.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24, coordinateSpace: .global)
                .onEnded { drag in
                    let across = drag.translation.width
                    guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                    guard !path.isEmpty, across > 60, drag.startLocation.x > Self.edge else { return }
                    path.removeLast()
                }
        )
        .onChange(of: path) { _, next in pushed = !next.isEmpty }
        // A chat turn may have started a session in a project through Milo; re-read the list
        // it changed rather than what this screen remembered.
        .onChange(of: model.answerEnded) { _, _ in
            Task { await model.refreshProjects() }
        }
        .onAppear {
            pushed = !path.isEmpty
            openAsked()
        }
        .onChange(of: opening) { _, _ in openAsked() }
    }
}

// MARK: - The index

private struct WorkIndex: View {
    let onSelect: (String) -> Void
    let onSessions: () -> Void

    @Environment(AppModel.self) private var model
    @State private var picking = false
    @State private var renaming: Project?
    @State private var renameDraft = ""
    @State private var removing: Project?

    /// The sessions that work in a project — the drawer's own list, filtered, so the screen
    /// and the drawer cannot disagree about which session belongs where.
    private func sessions(of id: String) -> [SessionSummary] {
        model.sessions.filter { $0.project == id }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "folder")
                            .font(.system(size: 13, weight: .semibold))
                        Text("WORKSPACE")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .tracking(1.1)
                    }
                    .foregroundStyle(MiloTheme.accent)

                    Text("Work")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(MiloTheme.foreground)
                    Text("The folders a session can work in, and the sessions that ran there.")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)

                    HStack(spacing: MiloTheme.Space.two) {
                        Label(
                            "\(model.projects.count) \(model.projects.count == 1 ? "project" : "projects")",
                            systemImage: "folder"
                        )
                        Text("·").foregroundStyle(MiloTheme.muted)
                        Text("\(workingCount) \(workingCount == 1 ? "session working" : "sessions working")")
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .font(MiloTheme.Text.small.weight(.medium))
                    .padding(.top, MiloTheme.Space.one)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MiloTheme.Space.five)
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))

                if let error = model.projectsError {
                    MiloErrorPill(text: error)
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    Text("Your projects")
                        .font(MiloTheme.Text.title)
                        .foregroundStyle(MiloTheme.foreground)

                    if model.projects.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            Image(systemName: model.projectsLoading ? "hourglass" : "folder")
                                .font(.system(size: 22, weight: .medium))
                                .foregroundStyle(MiloTheme.accent)
                            Text(model.projectsLoading ? "Reading your projects…" : "No projects yet")
                                .font(MiloTheme.Text.body.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("A project is a folder a session works in. Point one at a repository and every session started in it reads, writes and runs commands there — not in Milo's own directory.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.five)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else {
                        VStack(spacing: MiloTheme.Space.two) {
                            ForEach(model.projects) { project in
                                ProjectRow(
                                    project: project,
                                    sessions: sessions(of: project.id).count,
                                    running: sessions(of: project.id).contains { $0.running == true },
                                    onOpen: { onSelect(project.id) },
                                    onRename: {
                                        renameDraft = project.name
                                        renaming = project
                                    },
                                    onRemove: { removing = project }
                                )
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.four)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(MiloTheme.background)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: MiloTheme.Space.one) {
                HStack(spacing: 0) {
                    SessionsButton(action: onSessions)
                    Spacer(minLength: 0)
                }
                ConnectionPill()
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .animation(.smooth(duration: 0.22), value: model.connectionLine)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            createBar
        }
        .refreshable {
            await model.refreshProjects()
        }
        .task { await model.refreshProjects() }
        .sheet(isPresented: $picking) {
            FolderPicker { path in
                Task { await model.createProject(folder: path) }
            }
        }
        .alert(
            "Rename project",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
        ) {
            TextField("Project name", text: $renameDraft)
            Button("Save") {
                if let project = renaming {
                    let next = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !next.isEmpty, next != project.name {
                        Task { await model.renameProject(id: project.id, name: next) }
                    }
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog(
            "Remove “\(removing?.name ?? "")” from the list? Its sessions stay.",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let project = removing {
                    Task { await model.removeProject(id: project.id) }
                }
                removing = nil
            }
        }
    }

    private var workingCount: Int {
        model.sessions.filter { $0.project != nil }.count
    }

    /// Adding a project, which is choosing a folder: the picker is raised rather than a path
    /// typed, because the folder that matters is on the machine Milo runs on and this phone
    /// cannot reach it — see `FolderPicker`.
    private var createBar: some View {
        MiloWideButton(title: "New project", systemImage: "folder", primary: true) { picking = true }
            .disabled(model.projectsSaving)
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .padding(.top, MiloTheme.Space.one)
    }
}

/// One project as the index draws it: what it is called, where it is, and how much work is there.
private struct ProjectRow: View {
    let project: Project
    let sessions: Int
    let running: Bool
    let onOpen: () -> Void
    let onRename: () -> Void
    let onRemove: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: MiloTheme.Space.three) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                    Text(project.name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                    // Only a folder that is gone is said: where it is is the store's business,
                    // and a path under every name was a second line saying nothing the person
                    // asked for. A gone one is said rather than left as a project that looks
                    // workable — a session started in it would not work there.
                    if let error = project.error {
                        Text(error)
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.danger)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: MiloTheme.Space.two)
                HStack(spacing: MiloTheme.Space.one) {
                    if running {
                        Circle().fill(MiloTheme.accent).frame(width: 6, height: 6)
                    }
                    Text("\(sessions)")
                        .font(MiloTheme.Text.base.weight(.semibold).monospacedDigit())
                        .foregroundStyle(sessions > 0 ? MiloTheme.accent : MiloTheme.muted)
                    Text(sessions == 1 ? "session" : "sessions")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.muted)
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        }
        .buttonStyle(PressableStyle())
        .contextMenu {
            menuItem("Rename", "pencil", action: onRename)
            Button(role: .destructive, action: onRemove) {
                Label("Remove", systemImage: "trash")
            }
            .tint(Color(.systemRed))
        }
    }
}

// MARK: - One project

private struct ProjectDetail: View {
    let projectId: String
    /// The way back to the index this page sits on.
    let onBack: () -> Void
    let onRemoved: () -> Void
    /// The way back to the chat, told whether the cursor belongs in the composer.
    let onChat: (Bool) -> Void

    @Environment(AppModel.self) private var model
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var confirmRemove = false
    /// What is being said to this project, before there is a session to say it in.
    @State private var draft = ""
    @State private var menu: ComposerMenu?
    @State private var picker = false
    @FocusState private var composing: Bool

    private var project: Project? {
        model.projects.first { $0.id == projectId }
    }

    /// This project's sessions, newest first — the drawer's list, filtered.
    private var sessions: [SessionSummary] {
        model.sessions.filter { $0.project == projectId }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let project {
                    // The name is on the bar, the way a session's is, and the actions are up
                    // there with it: what is left here is what the bar cannot say — a folder that
                    // has gone, which is the one thing worth saying about a project that cannot
                    // be worked in.
                    if let error = project.error {
                        MiloErrorPill(text: error)
                    }

                    if let error = model.projectsError {
                        MiloErrorPill(text: error)
                    }

                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Text(sessions.isEmpty ? "No sessions yet" : "Sessions here")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)

                        if sessions.isEmpty {
                            Text("No sessions have worked here yet. Say something below and one starts here.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        } else {
                            VStack(spacing: MiloTheme.Space.two) {
                                ForEach(sessions) { session in
                                    SessionRow(session: session, onOpen: { open(session.id) })
                                }
                            }
                        }
                    }

                    // A folder that is gone has no diff and no tree to read, and the bar
                    // already says why.
                    if project.error == nil {
                        ProjectFiles(projectId: projectId)
                    }

                    if model.projectsSaving {
                        Text("Saving…")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                } else {
                    Text("This project is not in the list any more.")
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(MiloTheme.background)
        // The bar the stack already draws, given its three places: the way back, the project
        // named with its folder, and the project's own actions. The connection line is not here
        // — it belongs to the bars of the roots, as it does over a routine's own page.
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        // This page's own control takes the leading place, so the platform's own back button —
        // one wearing the previous page's title — is not standing beside it.
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    onBack()
                } label: {
                    // The mark alone: the page names itself in the middle of this same bar, so a
                    // word here would be a second name for where the chevron already goes. And its
                    // tone is the foreground's rather than the accent's, which is the pointer's.
                    Image(systemName: "chevron.left")
                }
                // No style of its own: a place in a toolbar is already drawn in the platform's
                // glass, and asking for the glass as well drew a second capsule inside the first.
                .tint(MiloTheme.foreground)
                .accessibilityLabel("Back to your projects")
            }
            ToolbarItem(placement: .principal) {
                // The project, named where a title goes: with the folder's mark and at the
                // platform's own title weight, and said before anything has been written into it
                // — which folder the work happens in is a fact of the project, not of its words.
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "folder")
                        .font(.system(size: 13, weight: .semibold))
                    Text(project?.name ?? projectId)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .foregroundStyle(project?.error == nil ? MiloTheme.foreground : MiloTheme.danger)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    menuItem("Rename", "pencil") {
                        renameDraft = project?.name ?? ""
                        renaming = true
                    }
                    Button(role: .destructive) { confirmRemove = true } label: {
                        Label("Remove", systemImage: "trash")
                    }
                    .tint(Color(.systemRed))
                } label: {
                    Image(systemName: "ellipsis")
                }
                .tint(MiloTheme.foreground)
                .accessibilityLabel("Project actions")
                .disabled(project == nil)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Saying the first thing is what starts the session: there is no button to press
            // first, and no separate screen to be sent to — the words begin the work. Offered
            // only where the folder can be worked in: a field that swallowed what was said into
            // a project that cannot run would be a control promising what it cannot do, and the
            // page above already says why.
            if project?.error == nil {
                Composer(
                    draft: $draft,
                    quote: .constant(nil),
                    drafts: .constant([]),
                    editing: .constant(nil),
                    focused: $composing,
                    menu: $menu,
                    send: { intent in start(saying: intent) },
                    // The same composer a work session carries, told which of the two it is.
                    work: true,
                    role: .start,
                    onModel: {
                        composing = false
                        picker = true
                    }
                )
            }
        }
        .sheet(isPresented: $picker) { ModelPickerSheet() }
        .alert("Rename project", isPresented: $renaming) {
            TextField("Project name", text: $renameDraft)
            Button("Save") {
                let next = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                if !next.isEmpty {
                    Task { await model.renameProject(id: projectId, name: next) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Remove “\(project?.name ?? "")” from the list? Its sessions stay.",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                Task {
                    if await model.removeProject(id: projectId) != nil { onRemoved() }
                }
            }
        }
    }

    private func open(_ id: String) {
        Task {
            if await model.resume(id) { onChat(false) }
        }
    }

    /// Saying something to a project: the words start the session they were meant for, so the
    /// send is the start — one move rather than opening a session and then saying why.
    private func start(saying intent: ClientFrame.Intent) {
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        draft = ""
        // The field is given up before the session moves: the chat that opens draws the message
        // this one sent, and two fields holding the same words is one too many.
        composing = false
        Task {
            guard await model.startWorkSession(project: projectId) else { return }
            model.send(words, intent: intent)
            onChat(false)
        }
    }
}

/// One session of a project: what it is about, when it last moved, and whether it is running.
private struct SessionRow: View {
    let session: SessionSummary
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: MiloTheme.Space.three) {
                if session.running == true {
                    Circle().fill(MiloTheme.accent).frame(width: 6, height: 6)
                }
                Text(session.label)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                Spacer(minLength: MiloTheme.Space.two)
                Text(RelativeTime.when(session.updatedAt))
                    .font(MiloTheme.Text.meta.monospacedDigit())
                    .foregroundStyle(MiloTheme.muted)
            }
// MARK: - The folder of a project

/**
 The tree of a project's folder, and one file of it read.

 Read-only: the person edits in their own editor and the agent through its own tools, so
 this draws what is there and opens a file as text. The tree is the daemon's own walk —
 the same one the agent's tools use — so what is drawn here and what a search finds
 cannot disagree about what is in the folder.
 */
private struct ProjectFiles: View {
    let projectId: String

    @Environment(AppModel.self) private var model
    @State private var tree: WorkTree?
    @State private var error: String?
    /// The file being read, by the row it was opened from.
    @State private var open: WorkNode?

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
            }

            if let error {
                MiloErrorPill(text: error)
            }

            if let open {
                WorkFileReader(projectId: projectId, node: open, onClose: { self.open = nil })
            }

            if let tree {
                if tree.nodes.isEmpty {
                    Text("This folder has no files in it.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        ForEach(tree.nodes) { node in
                            WorkNodeRow(
                                projectId: projectId,
                                node: node,
                                openRel: open?.rel,
                                onOpen: { self.open = $0 }
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
    let projectId: String
    let node: WorkNode
    /// The file being read, so the row it was opened from stays marked.
    let openRel: String?
    let onOpen: (WorkNode) -> Void

    var body: some View {
        if node.isFolder {
            DisclosureGroup {
                ForEach(node.children) { child in
                    WorkNodeRow(projectId: projectId, node: child, openRel: openRel, onOpen: onOpen)
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
                        .foregroundStyle(openRel == node.rel ? MiloTheme.accent : MiloTheme.foreground)
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
 One file, read from the daemon a page at a time. The page is the core's own cut — the same
 one the agent's reader takes — so the lines here are the lines it was handed, and a long
 file continues at the offset the page named rather than at a guess.
 */
private struct WorkFileReader: View {
    let projectId: String
    let node: WorkNode
    let onClose: () -> Void

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
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Text(node.rel)
                    .font(MiloTheme.Text.meta.monospaced())
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: MiloTheme.Space.two)
                if let first, first.total > 0 {
                    Text("\(first.total) lines")
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }
                MiloIconButton(systemName: "xmark", size: 14, span: 30) { onClose() }
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
                    // sideways, and marked so the drawer's drag stands down inside it.
                    CodeBlock(code: pages.map(\.text).joined(separator: "\n"))

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
        .buttonStyle(PressableStyle())
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
private struct FolderPicker: View {
    let onChoose: (String) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var listing: FolderListing?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section {
                        Text(error)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.danger)
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
                    Text(listing?.path ?? " ")
                        .font(MiloTheme.Text.meta.monospaced())
                        .textCase(nil)
                        .lineLimit(1)
                        .truncationMode(.middle)
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
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use this folder") {
                        guard let path = listing?.path else { return }
                        onChoose(path)
                        dismiss()
                    }
                    .disabled(listing == nil || busy)
                }
            }
            .task { await open(nil) }
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
