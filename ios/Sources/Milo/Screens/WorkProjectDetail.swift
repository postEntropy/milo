import SwiftUI

struct ProjectDetail: View {
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
    @State private var sendingDraft = false
    /// The files that will ride with those words: picked here, sent with the message that
    /// starts the session, and so read exactly as the chat reads one.
    @State private var drafts: [AttachmentDraft] = []
    @State private var menu: ComposerMenu?
    @State private var picker = false
    /// Whether the folder's own rules are open in the drawer: asked for from the project's
    /// menu, rather than standing on the page as a section of its own.
    @State private var showingRules = false
    /// Whether the marks are open in the drawer, chosen from the same menu.
    @State private var choosingIcon = false
    /// Whether the session started from this page's first words should be planning.
    /// The session does not exist yet, so the choice is held here until it does.
    @State private var planStart = false
    @State private var selectedBackend = "milo"
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
                        SessionRow(session: session, renaming: $renamingSession, style: .work, onOpen: { open(session.id) })
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
        VStack(spacing: 0) {
            backendPicker
            starter
        }
    }

    private var starter: some View {
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
            sessionBackend: selectedBackend,
            role: .start,
            project: project?.name,
            startPlan: $planStart,
            onModel: openModelPicker
        )
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
        .task(id: projectId) {
            draft = UserDefaults.standard.string(forKey: "milo-work-draft:\(projectId)") ?? ""
            selectedBackend = "milo"
            await model.refreshSessionBackends()
        }
        .onChange(of: draft) { _, text in
            if text.isEmpty { UserDefaults.standard.removeObject(forKey: "milo-work-draft:\(projectId)") }
            else { UserDefaults.standard.set(text, forKey: "milo-work-draft:\(projectId)") }
        }
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
        // Where the files come from: the attachment sheet and the system choosers it opens,
        // shared with the chat through `ComposerAttach`.
        .attachmentPickers(drafts: $drafts, menu: $menu) { message in
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
                    draft = prompt
                    composing = true
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

    /// Which agent runs the Session this page starts. A choice made once, before the Session
    /// exists, so it is drawn above the composer rather than inside it. A backend that cannot
    /// run now is refused with its reason, since the platform's segmented control cannot draw
    /// one segment inert.
    private var backendChoice: Binding<String> {
        Binding(
            get: { selectedBackend },
            set: { id in
                guard id == "command-code" else { selectedBackend = id; return }
                if let choice = model.sessionBackends.first(where: { $0.id == id }) {
                    if !choice.available {
                        model.showNote(choice.reason ?? "Command Code is unavailable.")
                    } else if !drafts.isEmpty {
                        model.showNote("Remove the attachments to use Command Code.")
                    } else {
                        planStart = false
                        selectedBackend = id
                    }
                } else if model.sessionBackendsLoaded {
                    model.showNote(model.sessionBackendsError ?? "Command Code is unavailable.")
                } else {
                    model.showNote("Checking which backends are available…")
                }
            }
        )
    }

    private var backendPicker: some View {
        Picker("Backend", selection: backendChoice) {
            Text("Milo").tag("milo")
            Text("Command Code").tag("command-code")
        }
        .pickerStyle(.segmented)
        .padding(MiloTheme.Space.one)
        .glassEffect(.regular, in: Capsule())
        .padding(.horizontal, MiloTheme.margin)
        .padding(.top, MiloTheme.Space.two)
        .accessibilityHint("Choose the agent for this new Session")
        .sensoryFeedback(.selection, trigger: selectedBackend)
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
        guard !sendingDraft else { return }
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = drafts
        guard !words.isEmpty || !files.isEmpty else { return }
        launchStart(
            with: words,
            drafts: files,
            intent: intent,
            backend: selectedBackend,
            confirmed: selectedBackend == "command-code"
        )
    }

    private func launchStart(
        with words: String,
        drafts files: [AttachmentDraft],
        intent: ClientFrame.Intent,
        backend: String,
        confirmed: Bool,
    ) {
        sendingDraft = true
        begin(with: words, drafts: files, intent: intent, plan: backend == "milo" && planStart, backend: backend, confirmed: confirmed)
    }

    private func begin(
        with words: String,
        drafts files: [AttachmentDraft],
        intent: ClientFrame.Intent,
        plan: Bool = false,
        backend: String,
        confirmed: Bool,
    ) {
        Task {
            defer { sendingDraft = false }
            guard await model.startWorkSession(project: projectId, plan: plan, backend: backend, confirmed: confirmed) else {
                composing = true
                return
            }
            guard model.queueDraft(words, intent: intent, drafts: files) else { return }
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == words { draft = "" }
            if drafts.map(\.id) == files.map(\.id) { drafts = [] }
            planStart = false
            composing = false
            onChat(false)
        }
    }
}

// MARK: - The mark a project wears

/**
 The marks a project can wear, as a grid in a drawer. The catalog is the daemon's — the same
 ids the browser offers — and only the drawing is this platform's: an SF Symbol per choice.
 A mark is a glance, chosen once in a while, so it is not a section of the project's page.
 */
struct ProjectIconSheet: View {
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
