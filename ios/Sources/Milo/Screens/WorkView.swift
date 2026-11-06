import SwiftUI

/**
 Work: the folders a session may work in, and the sessions that ran in one.

 A project is the only thing that makes a session work somewhere other than the install's
 own folder, so this is where a piece of work is set up and opened — and the chat it opens
 into is the ordinary one, with the ordinary composer. Drawn beside the routines and the
 task lists: the projects on the front page, and one project's own page a level in.
 */
struct WorkView: View {
    /// Whether one project's own page is open *on top of the index*, told to the shell: the
    /// drawer's swipe belongs to the index, and over a page pushed from it the swipe keeps out
    /// of the way — the way back from one is the platform's own, the edge swipe it answers and
    /// the control the stack draws beside the project's name.
    @Binding var pushed: Bool
    /// The project the shell named — from the drawer's Work list, the welcome's chooser, or a
    /// bar. It is the whole of Work while it is set: there is no index under it, because the
    /// index was never opened, and the way out is the sessions it was come from.
    @Binding var opening: String?
    /// Set when the drawer's New project asked for it: the folder picker is raised as the
    /// index opens, rather than naming a screen and leaving the act two taps away.
    @Binding var newProject: Bool
    /// Opening the sessions from here. The drawer belongs to the chat, and this screen
    /// reaches it through the same control and the same swipe.
    let onSessions: () -> Void
    /// Going back to the chat — where a session opened or started here lives. The flag says
    /// whether the cursor belongs in the composer, which it does for the one just started.
    let onChat: (Bool) -> Void
    /// The index's Chat | Work switch: returns to Chat.
    let onChatWorld: () -> Void
    @Environment(AppModel.self) private var model
    /// The index's own stack: a project card pushes its page over the projects, and the
    /// platform's back returns to them.
    @State private var path: [String] = []

    var body: some View {
        Group {
            if let opening {
                // Opened from outside the index, so it *is* Work — a stack of its own with
                // nothing beneath, where the bar carries the way into the sessions instead of
                // a back that would go to a list nobody opened.
                NavigationStack {
                    ProjectDetail(
                        projectId: opening,
                        root: true,
                        onRemoved: { self.opening = nil },
                        onChat: onChat,
                        onSessions: onSessions,
                        onSwitch: { self.opening = $0 }
                    )
                    .id(opening)
                }
            } else {
                NavigationStack(path: $path) {
                    WorkIndex(
                        newProject: $newProject,
                        onSelect: { path.append($0) },
                        onSessions: onSessions,
                        onChat: onChat,
                        onChatWorld: onChatWorld
                    )
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationDestination(for: String.self) { projectId in
                        ProjectDetail(
                            projectId: projectId,
                            root: false,
                            onRemoved: { path.removeAll { $0 == projectId } },
                            onChat: onChat,
                            onSessions: onSessions,
                            onSwitch: { path = [$0] }
                        )
                    }
                }
                // A page pushed over the index keeps the platform's way back — the leading
                // control and the edge swipe — so the sessions stay out of that drag.
                .onChange(of: path) { _, next in
                    if opening == nil { pushed = !next.isEmpty }
                }
            }
        }
        // A project that is the whole of Work has nothing under it to go back to, so the
        // card's own swipe is free to open the sessions: that is where it was come from.
        .onChange(of: opening) { _, next in
            if next != nil { path = [] }
            pushed = next == nil && !path.isEmpty
        }
        // A chat turn may have started a session in a project through Milo; re-read the list
        // it changed rather than what this screen remembered.
        .onChange(of: model.answerEnded) { _, _ in
            Task { await model.refreshProjects() }
        }
        .onAppear { pushed = opening == nil && !path.isEmpty }
        // Adding a project belongs to the index: a page, and the project it was showing, are
        // left behind so the picker comes up where the act happens.
        .onChange(of: newProject) { _, asked in
            if asked {
                opening = nil
                path = []
            }
        }
    }
}

// MARK: - The index

private struct WorkIndex: View {
    /// The drawer's New project, answered here — where adding a folder lives.
    @Binding var newProject: Bool
    let onSelect: (String) -> Void
    let onSessions: () -> Void
    /// Going back to the chat — where a session opened from a row here lives. The flag says
    /// whether the cursor belongs in the composer, which is not the case for a resumed one.
    let onChat: (Bool) -> Void
    /// The index's Chat | Work switch: returns to Chat.
    let onChatWorld: () -> Void

    @Environment(AppModel.self) private var model
    @State private var picking = false
    @State private var renaming: Project?
    @State private var renameDraft = ""
    @State private var removing: Project?
    /// The session being renamed from one of the rows below: the alert is presented once, by
    /// this screen, and the row only says which one.
    @State private var renamingSession: String?
    /// The project whose mark is being chosen from the row's own menu.
    @State private var choosingIcon: Project?
    /// The projects folded shut, by id. Expanded is the default, so only that is kept.
    @AppStorage("work-collapsed") private var collapsedRaw = ""

    /// How many of a project's sessions the index draws before the rest are one tap away.

    private var collapsed: Set<String> {
        Set(collapsedRaw.split(separator: ",").map(String.init))
    }

    private func toggle(_ id: String) {
        var ids = collapsed
        if ids.contains(id) {
            ids.remove(id)
        } else {
            ids.insert(id)
        }
        collapsedRaw = ids.sorted().joined(separator: ",")
    }

    /// The sessions that work in a project — the drawer's own list, filtered, so the screen
    /// and the drawer cannot disagree about which session belongs where.
    private func sessions(of id: String) -> [SessionSummary] {
        model.sessions.filter { $0.project == id }
    }

    /// The newest few, plus any session still running or still unread: work in flight
    /// and work waiting to be read are never hidden behind a count, however long either
    /// has been going. The drawer's Work list cuts the same list the same way.
    private func shownSessions(of id: String) -> [SessionSummary] {
        sessions(of: id).filter(\.workInline)
    }

    /// Opening a session from the index: the chat takes it, the way a project's page does.
    private func open(_ id: String) {
        Task {
            if await model.resume(id) { onChat(false) }
        }
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
                        VStack(spacing: MiloTheme.Space.four) {
                            ForEach(model.projects) { project in
                                projectCard(for: project)
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
            topBar
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: MiloTheme.Space.two) {
                // The refusal sits beside the control that asked, so a tap that did not
                // take is answered where the finger is rather than above the fold.
                if let error = model.projectsError {
                    MiloErrorPill(text: error)
                        .padding(.horizontal, MiloTheme.margin)
                }
                createBar
            }
        }
        .refreshable {
            await model.refreshProjects()
        }
        .task { await model.refreshProjects() }
        // The drawer's New project is the same act as this screen's own control: the picker
        // is raised here, once per ask.
        .onAppear { answerNewProject() }
        .onChange(of: newProject) { _, _ in answerNewProject() }
        .sessionRename($renamingSession)
        .sheet(isPresented: $picking) {
            FolderPicker { path in
                Task { await model.createProject(folder: path) }
            }
        }
        .sheet(item: $choosingIcon) { project in
            DetailSheet {
                ProjectIconSheet(selected: project.icon) { icon in
                    choosingIcon = nil
                    Task { await model.setProjectIcon(id: project.id, icon: icon) }
                }
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

    /// The drawer's New project, answered where adding a folder lives: the picker is raised
    /// and the ask is cleared as it is, so coming back to the index never asks again.
    private func answerNewProject() {
        guard newProject else { return }
        newProject = false
        picking = true
    }

    /// Adding a project, which is choosing a folder: the picker is raised rather than a path
    /// typed, because the folder that matters is on the machine Milo runs on and this phone
    /// cannot reach it — see `FolderPicker`.
    private var createBar: some View {
        // `busy` carries the saving state into the control itself: a button disabled by a
        // flag no one can see is a tap that vanishes.
        MiloWideButton(
            title: model.projectsSaving ? "Saving…" : "New project",
            systemImage: "folder",
            primary: true,
            busy: model.projectsSaving
        ) { picking = true }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .padding(.top, MiloTheme.Space.one)
    }

    /// The topbar for the Work index, matching the ChatView topbar with its centered Chat | Work switch.
    private var topBar: some View {
        VStack(spacing: MiloTheme.Space.one) {
            HStack(spacing: 0) {
                SessionsButton(action: onSessions)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ModeSwitch(
                    work: true,
                    onChat: onChatWorld,
                    onWork: {}
                )
                .frame(width: 180)
                Color.clear.frame(height: 0).frame(maxWidth: .infinity)
            }
            ConnectionPill()
        }
        .padding(.horizontal, MiloTheme.margin)
        .padding(.bottom, MiloTheme.Space.two)
        .animation(.smooth(duration: 0.22), value: model.connectionLine)
    }

    @ViewBuilder
    private func projectCard(for project: Project) -> some View {
        let mine = sessions(of: project.id)
        let shown = shownSessions(of: project.id)
        let expanded = !mine.isEmpty && !collapsed.contains(project.id)
        VStack(spacing: 0) {
            ProjectRow(
                project: project,
                sessions: mine.count,
                running: mine.contains { $0.running == true },
                unread: mine.contains { $0.unread == true },
                expanded: expanded,
                expandable: !mine.isEmpty,
                onToggle: { toggle(project.id) },
                onOpen: { onSelect(project.id) },
                onIcon: { choosingIcon = project },
                onRename: {
                    renameDraft = project.name
                    renaming = project
                },
                onRemove: { removing = project }
            )
            Fold(open: expanded) {
                VStack(spacing: 0) {
                    ForEach(shown) { session in
                        SessionRow(
                            session: session,
                            renaming: $renamingSession,
                            style: .work,
                            onOpen: { open(session.id) }
                        )
                    }
                    if mine.count > shown.count {
                        Button { onSelect(project.id) } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                Text("All \(mine.count) sessions")
                                Spacer(minLength: MiloTheme.Space.two)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                            .font(MiloTheme.Text.small.weight(.medium))
                            .foregroundStyle(MiloTheme.muted)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .padding(.vertical, MiloTheme.Space.two)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("All \(mine.count) sessions")
                    }
                }
                .padding(.bottom, MiloTheme.Space.two)
            }
        }
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }
}

/// One project as the index draws it: what it is called, where it is, and how much work is there.
private struct ProjectRow: View {
    let project: Project
    let sessions: Int
    let running: Bool
    /// Whether any of the project's sessions moved and has not been read — said on the
    /// card because a project's rows may be folded shut.
    let unread: Bool
    let expanded: Bool
    /// Whether there are sessions to fold: a project with none carries no chevron, since a
    /// control that opens onto nothing is a promise it cannot keep.
    let expandable: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void
    let onIcon: () -> Void
    let onRename: () -> Void
    let onRemove: () -> Void

    /// A tap opens it, a hold lifts its menu — and, as in the drawer, the row is not a `Button`:
    /// a `ButtonStyle` takes the press for its own animation, and the platform's long press
    /// then never reaches the row, so nothing is ever raised. The chevron is a control of its
    /// own at the card's edge, so folding the sessions never opens the page.
    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.three) {
                Image(systemName: ProjectMark.symbol(project.icon))
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(MiloTheme.muted2)
                    .frame(width: 28, alignment: .center)
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
                    // One mark, the same choice a session's own row makes.
                    SessionMark(running: running, unread: unread, size: 6)
                    Text("\(sessions)")
                        .font(MiloTheme.Text.base.weight(.semibold).monospacedDigit())
                        .foregroundStyle(sessions > 0 ? MiloTheme.accent : MiloTheme.muted)
                    Text(sessions == 1 ? "session" : "sessions")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            // A row that opens a project reads as a control, the way the button it used to be
            // did: a tap is not the only way to answer one.
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("\(project.name), \(sessions) \(sessions == 1 ? "session" : "sessions")")

            // The only chevron the card carries: it folds the sessions at the card's own edge,
            // so it cannot be mistaken for a second way into the project's page.
            if expandable {
                Button(action: onToggle) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .animation(.snappy(duration: 0.26), value: expanded)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse sessions" : "Expand sessions")
            }
        }
        .padding(.leading, MiloTheme.Space.four)
        .padding(.trailing, MiloTheme.Space.two)
        .padding(.vertical, MiloTheme.Space.two)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            menuItem("Icon", ProjectMark.symbol(project.icon), action: onIcon)
            menuItem("Rename", "pencil", action: onRename)
            Button(role: .destructive, action: onRemove) {
                Label("Remove", systemImage: "trash")
            }
            .tint(Color(.systemRed))
        }
    }
}

/// A body that folds to nothing rather than appearing and vanishing: the content's own
/// measured height becomes the frame while open, and the frame animates between that and
/// zero. The rows leave the hierarchy once the fold is over, so a closed project reads no
/// session it is not showing. The measurement is taken only once the fold has settled —
/// a geometry read taken mid-animation is the animated height, not the content's.
private struct Fold<Content: View>: View {
    let open: Bool
    let content: Content
    @State private var mounted: Bool
    @State private var settled: Bool
    @State private var height: CGFloat = 0
    /// The last height read while the fold was moving: applied once it settles, since a
    /// frame measured mid-animation is the animated height, not the content's own.
    @State private var sample: CGFloat = 0
    @State private var measured = false

    private static var duration: Double { 0.26 }

    init(open: Bool, @ViewBuilder content: () -> Content) {
        self.open = open
        self.content = content()
        _mounted = State(initialValue: open)
        _settled = State(initialValue: open)
    }

    var body: some View {
        Group {
            if mounted {
                content
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(key: FoldHeight.self, value: proxy.size.height)
                        }
                    )
            }
        }
        .frame(height: open ? (measured ? height : nil) : 0, alignment: .top)
        .clipped()
        .opacity(open ? 1 : 0)
        .onPreferenceChange(FoldHeight.self) { next in
            guard open, next > 0 else { return }
            if settled {
                height = next
                measured = true
            } else {
                sample = max(sample, next)
            }
        }
        .onChange(of: settled) { _, now in
            if now, sample > 0 {
                height = sample
                measured = true
                sample = 0
            }
        }
        .animation(.snappy(duration: Self.duration), value: open)
        .animation(.snappy(duration: Self.duration), value: height)
        .onChange(of: open) { _, next in
            if next {
                mounted = true
                Task {
                    try? await Task.sleep(for: .milliseconds(Int(Self.duration * 1000)))
                    if open { settled = true }
                }
                return
            }
            settled = false
            sample = 0
            Task {
                try? await Task.sleep(for: .milliseconds(Int(Self.duration * 1000)))
                if !open { mounted = false }
            }
        }
    }
}

private struct FoldHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
