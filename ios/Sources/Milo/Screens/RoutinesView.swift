import SwiftUI

/**
 The routines surface: the list, one routine's own page — what it does, whether it is on,
 and the runs it has produced — or the one field that makes a new one, because turning a
 sentence into a schedule is the model's job, not the person's. The browser's own shape,
 drawn from the phone's tokens.

 It lives beside the chat rather than in Settings: a routine is a thing you use, not a
 setting you configure.
 */
struct RoutinesView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Route] = []

    /// Where the sheet can be pushed to: one routine's page, or the field that makes one.
    private enum Route: Hashable {
        /// A run to open on arrival, when a timeline row named one.
        case detail(routine: String, run: String?)
        case new
    }

    var body: some View {
        NavigationStack(path: $path) {
            RoutineList(
                onSelect: { path.append(.detail(routine: $0, run: nil)) },
                onOpen: { routine, run in path.append(.detail(routine: routine, run: run)) },
                onCompose: { path.append(.new) }
            )
            .navigationTitle("Routines")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .detail(let routine, let run):
                    RoutineDetail(routineId: routine, initialRun: run)
                case .new:
                    NewRoutine(account: account, onBack: { path.removeLast() })
                }
            }
        }
        // The permission the reminders need, asked once, the first time the screen opens.
        .task { await model.askToRemind() }
        // A tapped reminder names a routine: open it whether the sheet was already up or
        // this is where the launch landed.
        .onChange(of: model.pendingRoutine) { _, _ in openPending() }
        .onAppear { openPending() }
    }

    /// Opens the routine a tapped reminder named, if one is waiting.
    private func openPending() {
        guard let id = model.pendingRoutine else { return }
        model.pendingRoutine = nil
        path = [.detail(routine: id, run: nil)]
    }
}

// MARK: - The list

private struct RoutineList: View {
    let onSelect: (String) -> Void
    let onOpen: (String, String) -> Void
    let onCompose: () -> Void

    @Environment(AppModel.self) private var model
    @State private var feed: [RoutineFeedEntry] = []

    private var enabled: Int { model.routines.filter(\.enabled).count }

    var body: some View {
        List {
            if model.remindersAllowed == false {
                Section {
                    Label("Reminders are off — allow notifications in Settings.", systemImage: "bell.slash")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            }

            if let error = model.routinesError, model.routines.isEmpty {
                Section {
                    Text(error)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                    Button("Try again") { Task { await model.refreshRoutines() } }
                }
            } else if model.routines.isEmpty {
                Section {
                    if model.routinesLoading {
                        Text("Reading routines…")
                            .font(MiloTheme.Text.base)
                            .foregroundStyle(MiloTheme.muted)
                    } else {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            Image(systemName: "repeat")
                                .font(.system(size: 22, weight: .medium))
                                .foregroundStyle(MiloTheme.muted)
                            Text("No routines yet")
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("Describe a task and when to run it. Milo will work out the schedule.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(.vertical, MiloTheme.Space.two)
                    }
                }
            } else {
                Section {
                    ForEach(model.routines) { routine in
                        RoutineRow(
                            routine: routine,
                            onOpen: { onSelect(routine.id) },
                            onRun: { Task { await model.runRoutine(routine.id) } },
                            onToggle: { Task { await model.setRoutineEnabled(routine.id, enabled: !routine.enabled) } }
                        )
                    }
                } header: {
                    Text("\(enabled) active · \(model.routines.count) total")
                } footer: {
                    Button {
                        onCompose()
                    } label: {
                        Label("New routine", systemImage: "plus")
                    }
                    .disabled(model.busy)
                }
            }

            if !feed.isEmpty {
                Section("Recent outputs") {
                    ForEach(feed) { entry in
                        Button {
                            onOpen(entry.routineId, entry.runId)
                        } label: {
                            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                                HStack {
                                    Text(entry.routine)
                                        .font(MiloTheme.Text.base.weight(.semibold))
                                        .foregroundStyle(MiloTheme.foreground)
                                    Spacer(minLength: MiloTheme.Space.two)
                                    Text(RelativeTime.when(entry.at))
                                        .font(MiloTheme.Text.meta)
                                        .foregroundStyle(MiloTheme.muted)
                                }
                                Text(entry.answer.isEmpty ? "No words — the run sent a file." : entry.answer)
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.foreground2)
                                    .lineLimit(2)
                            }
                        }
                        .buttonStyle(PressableStyle())
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(MiloTheme.background)
        .task { await model.refreshRoutines() }
        .task { await loadFeed() }
        .refreshable {
            await model.refreshRoutines()
            await loadFeed()
        }
    }

    private func loadFeed() async {
        feed = (try? await model.routineFeed()) ?? []
    }
}

private struct RoutineRow: View {
    let routine: RoutineSummary
    let onOpen: () -> Void
    let onRun: () -> Void
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: MiloTheme.Space.three) {
            Circle()
                .fill(routine.enabled ? MiloTheme.success : MiloTheme.muted)
                .frame(width: 8, height: 8)

            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                    Text(routine.label)
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                    Text("\(routine.whenLabel) · \(routine.targetLabel)")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())

            VStack(alignment: .trailing, spacing: MiloTheme.Space.one) {
                Text(routine.lastRunAt != nil ? "Last run" : routine.enabled ? "Next run" : "Status")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
                Text(RoutineWording.state(routine))
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(routine.failed ? MiloTheme.danger : MiloTheme.foreground2)
            }

            MiloIconButton(systemName: "play.fill", size: 13, span: 32, action: onRun)
                .accessibilityLabel("Run \(routine.label) now")
            MiloIconButton(
                systemName: routine.enabled ? "pause.fill" : "play",
                size: 13,
                span: 32,
                action: onToggle
            )
            .accessibilityLabel(routine.enabled ? "Pause \(routine.label)" : "Resume \(routine.label)")
        }
    }
}

// MARK: - One routine

private struct RoutineDetail: View {
    let routineId: String
    let initialRun: String?

    @Environment(AppModel.self) private var model
    @State private var runs: [RoutineRun] = []
    @State private var total = 0
    @State private var runsError: String?
    @State private var openRun: String?
    @State private var run: [AppModel.Message]?
    @State private var runError: String?
    @State private var working = false
    @State private var confirmRemove = false

    private static let page = 20

    private var routine: RoutineSummary? { model.routines.first { $0.id == routineId } }

    var body: some View {
        List {
            if let routine {
                Section {
                    fact("Schedule", routine.whenLabel, failed: false)
                    fact("Deliver to", routine.targetLabel, failed: false)
                    fact(
                        routine.lastRunAt != nil ? "Last run" : "Next run",
                        routine.lastRunAt != nil
                            ? RoutineWording.lastRun(routine)
                            : (routine.enabled ? RoutineWording.nextRun(routine) : "Paused"),
                        failed: routine.failed
                    )
                }

                if !routine.allow.isEmpty {
                    Section {
                        Label("May use \(routine.allow.joined(separator: ", ")) while unattended", systemImage: "shield")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }

                Section {
                    Button {
                        Task { await runNow(routine) }
                    } label: {
                        Label(working ? "Running…" : "Run now", systemImage: "play.fill")
                    }
                    .disabled(working)
                    Button(routine.enabled ? "Pause" : "Enable") {
                        Task { await model.setRoutineEnabled(routine.id, enabled: !routine.enabled) }
                    }
                    Button("Remove", role: .destructive) { confirmRemove = true }
                }
            } else {
                Section {
                    Text("This routine is gone.")
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.muted)
                }
            }

            if let runsError {
                Section("Runs") {
                    Text(runsError)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                    Button("Try again") { Task { await loadRuns(reset: true) } }
                }
            } else if runs.isEmpty {
                Section("Runs") {
                    Text("No runs yet. Run it now or wait for its next scheduled time.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            } else {
                Section("Runs") {
                    ForEach(Array(runs.enumerated()), id: \.element.id) { index, entry in
                        Button {
                            openRun = entry.id
                        } label: {
                            HStack {
                                Text(index == 0 ? "Latest run" : "Run \(total - index)")
                                    .font(MiloTheme.Text.body)
                                    .foregroundStyle(MiloTheme.foreground)
                                Spacer(minLength: MiloTheme.Space.two)
                                Text(RelativeTime.when(entry.at))
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                            }
                        }
                        .buttonStyle(PressableStyle())
                    }
                    if runs.count < total {
                        Button("Show more") { Task { await loadRuns(reset: false) } }
                            .font(MiloTheme.Text.small)
                    }
                }

                if openRun != nil {
                    Section("Run output") {
                        if let runError {
                            Text(runError)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.danger)
                        } else if let run {
                            ForEach(Array(run.enumerated()), id: \.element.id) { index, message in
                                MessageRow(
                                    message: message,
                                    turn: index + 1,
                                    regenerate: nil,
                                    onQuote: { _ in },
                                    onEdit: { _, _ in },
                                    readOnly: true
                                )
                            }
                        } else {
                            Text("Reading run…")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(MiloTheme.background)
        .navigationTitle(routine?.label ?? "Routine")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Remove the routine “\(routine?.label ?? "")”?",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                Task {
                    await model.removeRoutine(routineId)
                }
            }
        }
        .task { await loadRuns(reset: true) }
        .task(id: openRun) { await loadRun() }
    }

    private func fact(_ label: String, _ value: String, failed: Bool) -> some View {
        HStack {
            Text(label)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
            Spacer(minLength: MiloTheme.Space.three)
            Text(value)
                .font(MiloTheme.Text.base)
                .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.foreground)
                .multilineTextAlignment(.trailing)
        }
    }

    private func loadRuns(reset: Bool) async {
        runsError = nil
        do {
            let page = try await model.routineRuns(routineId, offset: reset ? 0 : runs.count, limit: Self.page)
            runs = reset ? page.runs : runs + page.runs
            total = page.total
            if reset, openRun == nil { openRun = initialRun ?? page.runs.first?.id }
        } catch {
            runsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func loadRun() async {
        guard let openRun else {
            run = nil
            runError = nil
            return
        }
        run = nil
        runError = nil
        do {
            let transcript = try await model.routineTranscript(openRun)
            run = transcript.map {
                AppModel.Message(
                    isUser: $0.role == "user",
                    parts: $0.parts,
                    attachments: $0.attachments ?? [],
                    streaming: false,
                    thought: nil,
                    raw: $0.raw,
                    rawNoOutput: $0.rawNoOutput
                )
            }
        } catch {
            runError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Fires it now and opens the run it made — one way to see what a run said.
    private func runNow(_ routine: RoutineSummary) async {
        working = true
        defer { working = false }
        guard let result = await model.runRoutine(routine.id) else { return }
        openRun = result.runId
        await loadRuns(reset: true)
    }
}

// MARK: - A new routine

private struct NewRoutine: View {
    let account: Account
    let onBack: () -> Void

    @Environment(AppModel.self) private var model
    @State private var ask = ""
    @State private var destination: Destination = .chat
    @State private var chatId = ""
    /// Where the creation turn starts in the chat's transcript; nil until asked.
    @State private var createdFrom: Int?

    private enum Destination: String, CaseIterable, Identifiable {
        case chat, telegram, discord, screenOnly
        var id: String { rawValue }
        var label: String {
            switch self {
            case .chat: return "This chat"
            case .telegram: return "Telegram"
            case .discord: return "Discord"
            case .screenOnly: return "Routines screen only"
            }
        }
        var needsChatId: Bool { self == .telegram || self == .discord }
    }

    private var canCreate: Bool {
        !ask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.busy
            && model.connection == .online
            && (!destination.needsChatId || !chatId.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    /// What has been asked here and answered here: nothing until the first ask.
    private var thread: [AppModel.Message] {
        guard let createdFrom, createdFrom <= model.messages.count else { return [] }
        return Array(model.messages[createdFrom...])
    }

    var body: some View {
        List {
            Section {
                TextField(
                    "Every weekday at 8, look at the repo and tell me what moved.",
                    text: $ask,
                    axis: .vertical
                )
                .lineLimit(3...6)
                .font(MiloTheme.Text.body)
            } header: {
                Text("What should Milo do, and when?")
            } footer: {
                Text("Describe the task and schedule. Milo will turn your request into a routine.")
            }

            Section("Delivery destination") {
                Picker("Service", selection: $destination) {
                    ForEach(Destination.allCases) { choice in
                        Text(choice.label).tag(choice)
                    }
                }
                if destination.needsChatId {
                    TextField("a chat or channel id", text: $chatId)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            }

            Section {
                Button {
                    create()
                } label: {
                    Label(model.busy ? "Milo is on it…" : "Create routine", systemImage: "plus")
                }
                .disabled(!canCreate)
            }

            if !thread.isEmpty {
                Section("Routine setup") {
                    ForEach(Array(thread.enumerated()), id: \.element.id) { index, message in
                        MessageRow(
                            message: message,
                            turn: index + 1,
                            regenerate: nil,
                            onQuote: { _ in },
                            onEdit: { _, _ in },
                            readOnly: true
                        )
                    }
                    if let pending = model.pending {
                        PermissionBar(pending: pending)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(MiloTheme.background)
        .navigationTitle("New routine")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { onBack() } label: { Label("Routines", systemImage: "chevron.left") }
            }
        }
    }

    private func create() {
        let text = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Taken before the turn starts: everything from here on is this ask and Milo's
        // answer, so the wait and the permission prompt stay beside it.
        if createdFrom == nil { createdFrom = model.messages.count }
        ask = ""
        // The destination is pinned on the turn, so a routine named for Telegram is made
        // for Telegram even though the chat it was asked in is this one.
        model.send(text, target: SendTarget(gateway: gateway, conversationId: conversationId))
    }

    private var gateway: SendTarget.Gateway {
        switch destination {
        case .chat: return .web
        case .telegram: return .telegram
        case .discord: return .discord
        case .screenOnly: return .none
        }
    }

    /// The chat to post into. The bot gateways take the id that was typed; this chat and
    /// the Routines screen carry this phone's own conversation, the way the browser does.
    private var conversationId: String {
        destination.needsChatId ? chatId.trimmingCharacters(in: .whitespaces) : account.conversationId
    }
}

// MARK: - Wording

/// How a routine reads on a row and on its page, from the daemon's own labels and times.
private enum RoutineWording {
    static func state(_ routine: RoutineSummary) -> String {
        if routine.failed { return "Failed" }
        if !routine.enabled { return "Paused" }
        if let last = routine.lastRunAt { return RelativeTime.when(last) }
        if let next = routine.nextRunAt { return RelativeTime.ahead(next) }
        return "Enabled"
    }

    static func lastRun(_ routine: RoutineSummary) -> String {
        let when = routine.lastRunAt.map(RelativeTime.when) ?? "—"
        return routine.failed ? "\(when) · failed" : when
    }

    static func nextRun(_ routine: RoutineSummary) -> String {
        routine.nextRunAt.map(RelativeTime.ahead) ?? "Enabled"
    }
}
