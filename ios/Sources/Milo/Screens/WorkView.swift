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
                        onChat: onChat
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
    private static let sessionsShown = 3

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
        inlineWorkSessions(sessions(of: id), limit: Self.sessionsShown)
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
                                let mine = sessions(of: project.id)
                                let shown = shownSessions(of: project.id)
                                // A project with nothing in it has nothing to fold: its count
                                // says zero and the card stays shut.
                                let expanded = !mine.isEmpty && !collapsed.contains(project.id)
                                // One card, not two: the header opens the project's page, the
                                // chevron at its edge folds the sessions, and the body shares
                                // the header's surface so the two read as one object.
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
                                    // The newest few, drawn as the drawer draws a session. A
                                    // running one is always among them; the rest are a tap away
                                    // on the project's own page, where the folder lives.
                                    Fold(open: expanded) {
                                        VStack(spacing: 0) {
                                            ForEach(shown) { session in
                                                SessionRow(
                                                    session: session,
                                                    renaming: $renamingSession,
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

// MARK: - One project

private struct ProjectDetail: View {
    let projectId: String
    /// Whether this is the whole of Work, rather than a page pushed over the index: the bar
    /// then carries the way into the sessions, and there is no leading back to draw.
    let root: Bool
    let onRemoved: () -> Void
    /// The way back to the chat, told whether the cursor belongs in the composer.
    let onChat: (Bool) -> Void
    /// Opening the sessions from the leading place of a page that is the whole of Work.
    let onSessions: () -> Void
    /// Opening another project's page in this one's place — the title's own selector, so a
    /// folder can be changed without going back to the index first.
    let onSwitch: (String) -> Void

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
    /// Whether the folder's own rules are open in the drawer: asked for from the project's
    /// menu, rather than standing on the page as a section of its own.
    @State private var showingRules = false
    /// Whether the marks are open in the drawer, chosen from the same menu.
    @State private var choosingIcon = false
    /// Whether the session started from this page's first words should be planning.
    /// The session does not exist yet, so the choice is held here until it does.
    @State private var planStart = false
    @FocusState private var composing: Bool

    private var project: Project? {
        model.projects.first { $0.id == projectId }
    }

    /// This project's sessions, newest first — the drawer's list, filtered.
    private var sessions: [SessionSummary] {
        model.sessions.filter { $0.project == projectId }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// What ran here: the rows, or the line that says there is nothing yet and how a
    /// session begins.
    private var sessionsSection: some View {
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
    }

    /// Saying the first thing is what starts the session: there is no button to press
    /// first, and no separate screen to be sent to — the words begin the work. Offered
    /// only where the folder can be worked in: a field that swallowed what was said into
    /// a project that cannot run would be a control promising what it cannot do, and the
    /// page above already says why.
    private var composer: some View {
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
            startPlan: $planStart,
            onModel: openModelPicker
        )
        // How tall the composer came out, so the `+`'s panel stands over the field
        // rather than through it — the chat's own arrangement.
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { _, height in
            composerHeight = height
        }
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

                    sessionsSection

                    // A folder that is gone has nothing to read, and the bar already says why.
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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if project?.error == nil {
                composer
            }
        }
        // The bar the stack already draws, carrying what it does not draw itself: the project
        // named with its folder, and the project's own actions. Pushed over the index, the way
        // back is the stack's own — the control it puts at the leading place, and the swipe from
        // the screen's edge that goes with it. Opened as the whole of Work there is nothing under
        // it to go back to, so the leading place carries the sessions instead: the drawer it was
        // come from, one press or one swipe away, rather than a list nobody opened. The
        // connection line is not here: it belongs to the bars of the roots, as it does over a
        // routine's own page.
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if root {
                ToolbarItem(placement: .topBarLeading) {
                    // The bar draws the glass: a control wearing its own under it is two
                    // capsules for one button.
                    SessionsButton(action: onSessions, inToolbar: true)
                }
            }
            ToolbarItem(placement: .principal) {
                // The project, named where a title goes — and the selector for another: the
                // name opens the folders this install holds, so changing which one a page is
                // of does not send the person back to the index first.
                Menu {
                    ForEach(model.projects) { candidate in
                        Button {
                            if candidate.id != projectId { onSwitch(candidate.id) }
                        } label: {
                            Label(candidate.name, systemImage: ProjectMark.symbol(candidate.icon))
                        }
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: ProjectMark.symbol(project?.icon))
                            .font(.system(size: 13, weight: .semibold))
                        Text(project?.name ?? projectId)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if model.projects.count > 1 {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                    .foregroundStyle(project?.error == nil ? MiloTheme.foreground : MiloTheme.danger)
                }
                .disabled(model.projects.count < 2)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    menuItem("Icon", ProjectMark.symbol(project?.icon)) { choosingIcon = true }
                    menuItem("Rename", "pencil") {
                        renameDraft = project?.name ?? ""
                        renaming = true
                    }
                    // The rules belong to the project rather than to its page: a folder that
                    // is gone has none to read, so the line goes with it.
                    if project?.error == nil {
                        menuItem("Rules", "doc.text") { showingRules = true }
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
        // The folder's rules, risen from the bottom like any other detail: a page that is
        // read once in a while does not take a section of the project's own page.
        .sheet(isPresented: $showingRules) {
            DetailSheet {
                ProjectRulesSection(projectId: projectId) { prompt in
                    // The drawer goes before the session it asks for: the answer is a turn in
                    // the chat, and it would otherwise open under the sheet.
                    showingRules = false
                    begin(with: prompt, drafts: [], intent: .queue)
                }
            }
        }
        .sheet(isPresented: $choosingIcon) {
            DetailSheet {
                ProjectIconSheet(selected: project?.icon) { icon in
                    // The drawer goes before the write: what it answered is drawn on the page
                    // behind it, and a refusal's pill must not be hidden under the sheet.
                    choosingIcon = false
                    Task { await model.setProjectIcon(id: projectId, icon: icon) }
                }
            }
        }
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

    /// What the `+`'s panel holds here: the files, and how hard it thinks — one set of rows
    /// on every composer. The model is not among them: this composer carries it on the bar.
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

    /// Raising the model picker from the pill beside the plan switch: the sheet belongs to
    /// this page, as the `+` panel does, and the keys go away while it is up.
    private func openModelPicker() {
        menu = nil
        composing = false
        picker = true
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
        begin(with: words, drafts: files, intent: intent, plan: planStart)
    }

    /// Opens the session and says these words into it. The composer's own path, given the words
    /// rather than reading the field — the control that asks for the folder's rules says words the
    /// person did not type, and they begin the work the same way.
    private func begin(
        with words: String,
        drafts files: [AttachmentDraft],
        intent: ClientFrame.Intent,
        plan: Bool = false,
    ) {
        Task {
            guard await model.startWorkSession(project: projectId, plan: plan) else { return }
            // The session now owns the mode; a page opened again starts on Build.
            planStart = false
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
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                // How much was said, and when — the drawer's own second line, so a project's
                // list and the drawer say the same thing about the same session.
                Text(session.meta)
                    .font(MiloTheme.Text.meta.monospacedDigit())
                    .foregroundStyle(MiloTheme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: MiloTheme.Space.two)
            // A session running now, or one that moved and has not been read: the same
            // one mark the drawer puts at a row's edge.
            SessionMark(running: session.running, unread: session.unread)
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.vertical, MiloTheme.Space.two)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        // A row that opens a session reads as a control, the way the button it used to be
        // did: a tap is not the only way to answer one.
        .accessibilityAddTraits(.isButton)
        .sessionMenu(session, renaming: $renaming)
    }
}

// MARK: - The mark a project wears

/**
 The marks a project can wear, as a grid in a drawer. The catalog is the daemon's — the same
 ids the browser offers — and only the drawing is this platform's: an SF Symbol per choice.
 A mark is a glance, chosen once in a while, so it is not a section of the project's page.
 */
private struct ProjectIconSheet: View {
    /// What the write answers.
    let onPick: (String) -> Void

    @State private var chosen: String

    init(selected: String?, onPick: @escaping (String) -> Void) {
        // An id this build does not know draws as the neutral mark, and the grid says so.
        let known = selected.flatMap { id in
            ProjectMark.choices.contains { $0.id == id } ? id : nil
        }
        _chosen = State(initialValue: known ?? ProjectMark.neutral)
        self.onPick = onPick
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Project icon")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)
            Text("The mark this project wears in the Work list, in the welcome and over its sessions.")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 76), spacing: MiloTheme.Space.three)],
                spacing: MiloTheme.Space.three
            ) {
                ForEach(ProjectMark.choices) { choice in
                    Button {
                        chosen = choice.id
                        onPick(choice.id)
                    } label: {
                        VStack(spacing: MiloTheme.Space.two) {
                            Image(systemName: choice.symbol)
                                .font(.system(size: 22, weight: .regular))
                                .frame(height: 26)
                            Text(choice.label)
                                .font(MiloTheme.Text.meta)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, MiloTheme.Space.three)
                        .foregroundStyle(choice.id == chosen ? MiloTheme.accent : MiloTheme.foreground2)
                        .background(
                            choice.id == chosen ? MiloTheme.surfaceRaised : MiloTheme.surface,
                            in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                        )
                        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityLabel(choice.label)
                    .accessibilityAddTraits(choice.id == chosen ? .isSelected : [])
                }
            }
            .sensoryFeedback(.selection, trigger: chosen)
        }
    }
}

// MARK: - The folder's own rules

/**
 Whether a project's folder carries rules of its own, and the control that has the agent write
 them. A read: the file's own text is not drawn here, only whether it is there — and the words
 that write it come from the daemon, so this page and the browser ask for one text, not two.
 */
private struct ProjectRulesSection: View {
    let projectId: String
    /// Has the agent write the file, with the words the daemon gave.
    let onWrite: (String) -> Void

    @Environment(AppModel.self) private var model
    @State private var rules: ProjectRules?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Rules")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            if let error {
                MiloErrorPill(text: error)
            } else if let rules {
                if rules.carriesRules {
                    Text("This folder’s rules are in \(rules.file ?? "AGENTS.md"). A session started here follows them.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else if rules.isUnreadable {
                    Text("This folder has an \(rules.file ?? "AGENTS.md") that could not be read: \(rules.error ?? "")")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    // What the rules are, said once, and the one control that makes them: a
                    // session told to read the folder and write the file, which the person then
                    // watches — not a file written behind their back. A capsule the size of what
                    // it says, the same glass the rest of the screen presses.
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Text("This folder has no AGENTS.md — the file that tells a session started here how the project is worked in: its commands, its layout, its conventions.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                        Button {
                            onWrite(rules.prompt)
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                Image(systemName: "square.and.pencil")
                                    .font(.system(size: 13, weight: .medium))
                                Text("Write the rules")
                                    .font(MiloTheme.Text.small)
                            }
                            .foregroundStyle(MiloTheme.foreground2)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .padding(.vertical, MiloTheme.Space.two + 1)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .glassEffect(.regular.interactive(), in: Capsule())
                        .accessibilityLabel("Ask Milo to read this folder and write its AGENTS.md")
                    }
                }
            }
        }
        .task { await read() }
        // The daemon said a piece of work moved — the same signal the running dot follows —
        // so the folder is read again rather than left as it was before the turn.
        .onChange(of: model.workMoved) { _, _ in Task { await read() } }
    }

    private func read() async {
        do {
            rules = try await model.projectRules(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
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
        .onChange(of: model.workMoved) { _, _ in Task { await read() } }
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
                                ForEach(runs(of: hunk.lines)) { run in
                                    // One wash behind the whole run, not one per line: the
                                    // lines touch inside it, so a changed block reads as a
                                    // single block instead of a column of small ones.
                                    VStack(alignment: .leading, spacing: 0) {
                                        ForEach(run.lines) { line in
                                            DiffLineRow(line: line, language: file.path)
                                        }
                                    }
                                    .background(run.wash)
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

    /// The hunk's lines cut into runs of one kind, in the order they were written: the
    /// background belongs to the run, so two added lines in a row share one rectangle.
    private func runs(of lines: [WorkDiffLine]) -> [DiffLineRun] {
        var runs: [DiffLineRun] = []
        for line in lines {
            if runs.last?.kind == line.kind {
                runs[runs.count - 1].lines.append(line)
            } else {
                runs.append(DiffLineRun(kind: line.kind, lines: [line]))
            }
        }
        return runs
    }
}

/// One run of consecutive lines that went the same way, drawn under a single wash.
private struct DiffLineRun: Identifiable {
    let kind: String
    var lines: [WorkDiffLine]

    var id: String { "\(kind)-\(lines.first?.id ?? "")" }

    /// A wash, not a fill: which way the line went is read at a glance, and the code on top of
    /// it is still what is being read — so the colour is strong enough to name the line and no
    /// stronger. The browser mixes the same two into the same tone.
    var wash: Color {
        if kind == "add" { return MiloTheme.success.opacity(0.20) }
        if kind == "remove" { return MiloTheme.danger.opacity(0.17) }
        return .clear
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
                .frame(width: 44, alignment: .trailing)
            Text(line.new.map(String.init) ?? "")
                .frame(width: 44, alignment: .trailing)
            Text(line.mark)
                .foregroundStyle(line.isAdd ? MiloTheme.success : line.isRemove ? MiloTheme.danger : MiloTheme.muted)
            // An empty line is one space, so the row is the height its gutter numbers are and
            // the two of them still line up down the hunk.
            Text(line.text.isEmpty ? AttributedString(" ") : coloured(line.text, language: language))
            Spacer(minLength: 0)
        }
        // The size a file is read at in its own drawer: a changed line is code too, and the
        // two drawers read alike now that both rise from the same place.
        .font(MiloTheme.Text.mono)
        .padding(.horizontal, MiloTheme.Space.two)
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
private struct FolderPicker: View {
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
