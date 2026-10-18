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
    /// drawer's swipe belongs to the index, and over a page it keeps out of the way — the way
    /// back from one is the platform's own, the edge swipe it answers and the control the stack
    /// draws beside the project's name.
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
                    onRemoved: { path.removeAll { $0 == projectId } },
                    onChat: onChat
                )
            }
        }
        // No drag of this screen's own over the stack: the way back from a page is the platform's
        // own — the edge swipe the stack already answers, and the control it draws beside the
        // project's name — rather than a second gesture that only mimics them from the middle of
        // the screen.
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

    /// A tap opens it, a hold lifts its menu — and, as in the drawer, the row is not a `Button`:
    /// a `ButtonStyle` takes the press for its own animation, and the platform's long press
    /// then never reaches the row, so nothing is ever raised.
    var body: some View {
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
        .onTapGesture(perform: onOpen)
        // A row that opens a project reads as a control, the way the button it used to be did:
        // a tap is not the only way to answer one.
        .accessibilityAddTraits(.isButton)
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
    let onRemoved: () -> Void
    /// The way back to the chat, told whether the cursor belongs in the composer.
    let onChat: (Bool) -> Void

    @Environment(AppModel.self) private var model
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var confirmRemove = false
    /// The session being renamed from its own row here, by id. This page keeps a name for
    /// the project too, so the two are told apart by what they are.
    @State private var renamingSession: String?
    /// What is being said to this project, before there is a session to say it in.
    @State private var draft = ""
    /// The files that will ride with those words: picked here, sent with the message that
    /// starts the session, and so read exactly as the chat reads one.
    @State private var drafts: [AttachmentDraft] = []
    /// Which chooser the `+` asked for, while its panel closes.
    @State private var attach: AttachKind?
    @State private var menu: ComposerMenu?
    /// How tall the composer came out, so the panel stands over the field it belongs to
    /// rather than covering what is being written — the chat's own arrangement.
    @State private var composerHeight: CGFloat = 0
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
                        Text("Sessions")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)

                        if sessions.isEmpty {
                            Text("No sessions yet. Say something below to start one.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        } else {
                            VStack(spacing: MiloTheme.Space.two) {
                                ForEach(sessions) { session in
                                    SessionRow(session: session, renaming: $renamingSession, onOpen: { open(session.id) })
                                }
                            }
                        }
                    }

                    // A folder that is gone has no diff and no tree to read, and the bar
                    // already says why.
                    if project.error == nil {
                        ProjectChanges(projectId: projectId)
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
        // The bar the stack already draws, carrying what it does not draw itself: the project
        // named with its folder, and the project's own actions. The way back is the stack's own —
        // the control it puts at the leading place, and the swipe from the screen's edge that goes
        // with it — as a routine's own page keeps it. The connection line is not here: it belongs
        // to the bars of the roots, as it does over a routine's own page.
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
                    drafts: $drafts,
                    editing: .constant(nil),
                    focused: $composing,
                    menu: $menu,
                    send: { intent in start(saying: intent) },
                    // The same composer a work session carries, told which of the two it is
                    // and which folder the words will start a session in.
                    work: true,
                    role: .start,
                    project: project?.name,
                    onModel: {
                        composing = false
                        picker = true
                    }
                )
                // How tall the composer came out, so the `+`'s panel stands over the field
                // rather than through it — the chat's own arrangement.
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { _, height in
                    composerHeight = height
                }
            }
        }
        // The panel the `+` raised, and the layer that puts it away: a tap anywhere but the
        // panel closes it, and the panel stands over the field it belongs to. The same
        // arrangement the chat draws its own panel with.
        .overlay {
            if menu != nil {
                ZStack(alignment: .bottomLeading) {
                    Color.clear
                        .contentShape(Rectangle())
                        .ignoresSafeArea()
                        .onTapGesture { menu = nil }
                    MenuPanel(rows: panelRows)
                        .id(ComposerMenu.actions)
                        .transition(MenuBloom(anchor: .bottomLeading))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .padding(.horizontal, MiloTheme.margin)
                        .padding(.bottom, composerHeight + MiloTheme.Space.two)
                }
            }
        }
        .animation(
            menu != nil ? .spring(duration: 0.35, bounce: 0.18) : .spring(duration: 0.22, bounce: 0),
            value: menu
        )
        // Where the files come from: the platform's own chooser for each, over this page —
        // the same pair the chat raises.
        .attachmentPickers(drafts: $drafts, asked: $attach) { message in
            model.showNote(message)
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
        .sessionRename($renamingSession)
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

    /// What the `+`'s panel holds here: the files, and how hard the model thinks. The model
    /// itself has its own line under the field — one choice, reached one way.
    private var panelRows: [MenuRow] {
        composerActionRows(
            model: model,
            modelRow: nil,
            ask: { ask in
                menu = nil
                attach = ask
            }
        )
    }

    private func open(_ id: String) {
        Task {
            if await model.resume(id) { onChat(false) }
        }
    }

    /// Saying something to a project: the words start the session they were meant for, so the
    /// send is the start — one move rather than opening a session and then saying why. The
    /// files picked here ride with those words, so the first thing said to a project can
    /// carry a screenshot or a document — read exactly as the chat reads one.
    private func start(saying intent: ClientFrame.Intent) {
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = drafts
        guard !words.isEmpty || !files.isEmpty else { return }
        draft = ""
        drafts = []
        // The field is given up before the session moves: the chat that opens draws the message
        // this one sent, and two fields holding the same words is one too many.
        composing = false
        Task {
            guard await model.startWorkSession(project: projectId) else { return }
            model.send(words, intent: intent, drafts: files)
            onChat(false)
        }
    }
}

/// One session of a project: what it is about, when it last moved, and whether it is running.
/// A tap opens it, a hold lifts it into its card — and, as in the drawer, this is not a
/// `Button`: a `ButtonStyle` takes the press for its own animation and the platform's long
/// press never reaches the row.
private struct SessionRow: View {
    let session: SessionSummary
    /// The session being renamed, named by the row's own press: the alert is presented once,
    /// up on the page, and this only says which one.
    @Binding var renaming: String?
    let onOpen: () -> Void

    var body: some View {
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
        .padding(MiloTheme.Space.four)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .onTapGesture(perform: onOpen)
        // A row that opens a session reads as a control, the way the button it used to be
        // did: a tap is not the only way to answer one.
        .accessibilityAddTraits(.isButton)
        .sessionMenu(session, renaming: $renaming)
    }
}

// MARK: - What the project's folder has changed

/**
 The changes in a project's folder, read from its own repository.

 A folder that is not one is answered with that, in a sentence: nothing in Milo records
 what a session wrote, so an empty list here would read as "nothing changed" — which is
 not the same thing as "there is nothing to compare this to". The hunks come from the
 core already parsed, so this draws the shape instead of reading git's own text.
 */
private struct ProjectChanges: View {
    let projectId: String

    @Environment(AppModel.self) private var model
    @State private var diff: WorkDiff?
    @State private var error: String?
    /// Recording the folder as it is now, while it is being recorded.
    @State private var tracking = false
    /// The changed file whose hunks are open, risen from the bottom of the screen.
    @State private var reading: WorkDiffFile?

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Text("Changes")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
                if let diff, diff.isGit, !diff.files.isEmpty {
                    Text("\(diff.files.count) \(diff.files.count == 1 ? "file" : "files")")
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }
            }

            if let error {
                MiloErrorPill(text: error)
            }

            if let diff {
                if !diff.isGit || !diff.committed {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        // What this is, then what pressing the control below would do: the
                        // words read first, and the one thing to press sits under them. A
                        // repository with nothing committed has no state to compare against —
                        // every file in it would read as new — so that is said instead of the
                        // whole folder.
                        Text(diff.isGit
                            ? "Nothing is recorded in this repository yet, so every file in it counts as new."
                            : "\(diff.reason ?? "") Milo reads a folder’s changes through git, so there is nothing here to compare this one to.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                        Text("Git keeps the history locally, in a .git folder inside the project. Nothing is sent anywhere.")
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.muted)
                        // Their folder, their repository: pressing this is the person's own act,
                        // and it is the only thing that makes this section say anything at all.
                        // A capsule the size of what it says — the composer's own glass, not the
                        // wide control a screen's bottom bar is made of.
                        Button {
                            Task { await track() }
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                if tracking {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "arrow.triangle.branch")
                                        .font(.system(size: 13, weight: .medium))
                                }
                                Text(tracking ? "Recording…" : diff.isGit ? "Record the first state" : "Start a repository")
                                    .font(MiloTheme.Text.small)
                            }
                            .foregroundStyle(MiloTheme.foreground2)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .padding(.vertical, MiloTheme.Space.two + 1)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(tracking)
                        .glassEffect(.regular.interactive(), in: Capsule())
                        .accessibilityLabel(diff.isGit
                            ? "Record what is in this folder now as its first state"
                            : "Start a git repository in this folder")
                        .padding(.top, MiloTheme.Space.one)
                    }
                } else if diff.files.isEmpty {
                    Text("No changes")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        ForEach(diff.files) { file in
                            DiffFileRow(file: file, onOpen: { reading = file })
                        }
                    }
                }

                if diff.isGit, diff.truncated {
                    Text("Only the first \(diff.files.count) changed files are shown — there are more than fit here.")
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                }
            } else if error == nil {
                HStack(spacing: MiloTheme.Space.two) {
                    ProgressView().controlSize(.small)
                    Text("Reading the changes…")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
        }
        .task { await read() }
        // The file's own hunks, risen from the bottom: a diff is read on its own, and a long
        // one would otherwise stretch the project's page it changed in.
        .sheet(item: $reading) { file in DiffDetail(file: file) }
    }

    private func read() async {
        do {
            diff = try await model.projectDiff(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Recording the folder as its first state, and drawing the changes it made readable —
    /// empty, because there is now something to compare against — rather than asking the
    /// daemon for them again.
    private func track() async {
        tracking = true
        defer { tracking = false }
        do {
            diff = try await model.startTracking(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/**
 One changed file as the list draws it: what it is called, where it came from, and how much
 moved. A tap rises its hunks from the bottom of the screen rather than opening them under
 the row — a diff is read on its own, and a long one spread under the row would stretch the
 page it changed in.
 */
private struct DiffFileRow: View {
    let file: WorkDiffFile
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            DiffSummary(file: file, place: .row)
                .padding(.vertical, MiloTheme.Space.two)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }
}

/// A changed file's own line: what it is called, where it came from, and how much moved.
/// Drawn in the list and again at the top of its own drawer, from one place, so the two
/// cannot come to say different things about the same file — each at the step its own place
/// reads a line at.
private struct DiffSummary: View {
    /// Where the line stands: one row among the list's, or the name of what a drawer holds.
    enum Place {
        case row
        case title
    }

    let file: WorkDiffFile
    let place: Place

    /// The file's name: a row carries it at the step the list's rows are drawn at, and the
    /// drawer, which has nothing above it, a step above that — enough to read as the name of
    /// what the drawer holds, without shouting over the code inside it.
    private var name: Font {
        place == .title ? MiloTheme.Text.base.weight(.semibold).monospaced() : MiloTheme.Text.small.monospaced()
    }

    /// Where it came from and how much moved, a step under the name wherever it is drawn.
    private var detail: Font {
        place == .title ? MiloTheme.Text.small : MiloTheme.Text.meta
    }

    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Text(file.path)
                .font(name)
                .foregroundStyle(MiloTheme.foreground)
                .lineLimit(1)
                // A path too long to fit gives way at its head, never at the file's own name:
                // the last segment is the one that says which file this is, and half a
                // directory still says where it sits.
                .truncationMode(.head)
            if let from = file.from {
                Text("was \(from)")
                    .font(detail)
                    .foregroundStyle(MiloTheme.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: MiloTheme.Space.two)
            // The counts are only drawn when something moved: a rename or a
            // permission change has no lines of its own, and `+0 −0` says nothing.
            if file.additions > 0 || file.deletions > 0 {
                HStack(spacing: MiloTheme.Space.one) {
                    if file.additions > 0 {
                        Text("+\(file.additions)").foregroundStyle(MiloTheme.success)
                    }
                    if file.deletions > 0 {
                        Text("−\(file.deletions)").foregroundStyle(MiloTheme.danger)
                    }
                }
                .font(detail.monospacedDigit())
            }
        }
    }
}

/**
 One changed file's hunks, risen from the bottom of the screen.

 The marking is the diff's own: an added line green, a removed one red, both numbers in the
 gutter so a line can be found in the file it is from. What git called the change is not
 drawn beside the name: the path names the file, a rename says where it came from, and the
 counts say how much moved.
 */
private struct DiffDetail: View {
    let file: WorkDiffFile

    var body: some View {
        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                DiffSummary(file: file, place: .title)

                // The same box a code block is drawn in: monospaced, scrolling sideways
                // rather than wrapping — a wrapped line of a diff stops being that line. Not
                // marked as a scroll box: nothing drags behind a sheet.
                if !file.hunks.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(file.hunks) { hunk in
                                Text("@@ \(hunk.header) @@")
                                    .font(MiloTheme.Text.meta.monospaced())
                                    .foregroundStyle(MiloTheme.muted)
                                    .padding(.top, MiloTheme.Space.three)
                                    .padding(.bottom, MiloTheme.Space.one)
                                ForEach(hunk.lines) { line in
                                    DiffLineRow(line: line, language: file.path)
                                }
                            }
                        }
                        .padding(MiloTheme.Space.three)
                    }
                    .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                }

                // Why there is nothing above to draw, where there is something to say: a
                // binary file, only its mode changed, or a file git does not track yet.
                if let note = file.note {
                    Text(note)
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
        }
    }
}

/// One line of a hunk: its two line numbers, the diff's own marker, and the text — coloured
/// out of the roles the shared lexer reads, which is the one thing a diff's line and a reply's
/// block say alike.
private struct DiffLineRow: View {
    let line: WorkDiffLine
    /// What the line is read as: the changed file's own name, since a diff carries no tag.
    let language: String?

    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Text(line.old.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
            Text(line.new.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
            Text(line.mark)
                .foregroundStyle(line.isAdd ? MiloTheme.success : line.isRemove ? MiloTheme.danger : MiloTheme.muted)
            // An empty line is one space, so the row is the height its gutter numbers are and
            // the two of them still line up down the hunk.
            Text(line.text.isEmpty ? AttributedString(" ") : coloured(line.text, language: language))
            Spacer(minLength: 0)
        }
        .font(MiloTheme.Text.small.monospaced())
        .padding(.horizontal, MiloTheme.Space.two)
        .background(background)
    }

    /// A wash, not a fill: which way the line went is read at a glance, and the code on top of
    /// it is still what is being read — so the colour is strong enough to name the line and no
    /// stronger. The browser mixes the same two into the same tone.
    private var background: Color {
        if line.isAdd { return MiloTheme.success.opacity(0.20) }
        if line.isRemove { return MiloTheme.danger.opacity(0.17) }
        return .clear
    }
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
                // The same rule the diff's own line keeps: the file's name is the last thing
                // this gives up, so a long path is cut at its head.
                Text(node.rel)
                    .font(MiloTheme.Text.meta.monospaced())
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                    .truncationMode(.head)
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
                    // sideways, and marked so the drawer's drag stands down inside it. The
                    // file's own name is what colours it — the same hint the browser reads.
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
