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
    /// Whether one routine's own page is open on top of the list, told to the shell: the
    /// drawer's swipe belongs to the list, and over a page it keeps out of the way — the way
    /// back from one is the platform's own, the edge swipe it answers and the control the stack
    /// draws.
    @Binding var pushed: Bool
    /// Opening the sessions from here. The drawer belongs to the chat, but a screen that is
    /// not the chat still reaches it — by this control and by the same swipe.
    let onSessions: () -> Void
    @Environment(AppModel.self) private var model
    @State private var path: [Route] = []
    @State private var showingNewRoutine = false

    /// Where this page can navigate: one routine's page, or the field that makes one.
    private enum Route: Hashable {
        case detail(routine: String)
    }

    var body: some View {
        NavigationStack(path: $path) {
            RoutineList(
                onSelect: { path.append(.detail(routine: $0)) },
                onCompose: { showingNewRoutine = true },
                onSessions: onSessions
            )
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .detail(let routine):
                    RoutineDetail(routineId: routine)
                }
            }
            .sheet(isPresented: $showingNewRoutine) {
                NewRoutine(account: account)
            }
        }
        // No drag of this screen's own over the stack: the way back from a page is the platform's
        // own — the edge swipe the stack already answers, and the control it draws in the bar —
        // rather than a second gesture that only mimics them from the middle of the screen.
        // The permission the reminders need, asked once, the first time the screen opens.
        .task { await model.askToRemind() }
        // A tapped reminder names a routine: open it whether this page is already up or
        // this is where the launch landed.
        .onChange(of: model.pendingRoutine) { _, _ in openPending() }
        // On the way in, and as the stack moves: the shell keeps the drawer's swipe off a
        // page, and hands it back the moment the list is what is showing.
        .onChange(of: path) { _, next in pushed = !next.isEmpty }
        .onAppear {
            openPending()
            pushed = !path.isEmpty
        }
    }

    /// Opens the routine a tapped reminder named, if one is waiting.
    private func openPending() {
        guard let id = model.pendingRoutine else { return }
        model.pendingRoutine = nil
        path = [.detail(routine: id)]
    }
}

// MARK: - The list

private struct RoutineList: View {
    let onSelect: (String) -> Void
    let onCompose: () -> Void
    let onSessions: () -> Void

    @Environment(AppModel.self) private var model
    @State private var feed: [RoutineFeedEntry] = []
    /// The output being read, risen from the bottom of the screen. A timeline row reads
    /// its run here rather than opening the routine behind it: the person asked for the
    /// output, not for the page it belongs to.
    @State private var reading: ReadingRun?
    @State private var showAllOutputs = false
    @State private var showFinished = false
    @State private var removing: RoutineSummary?

    private var enabled: Int { model.routines.filter(\.enabled).count }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "clock")
                            .font(.system(size: 13, weight: .semibold))
                        Text("AUTOMATION")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .tracking(1.1)
                    }
                    .foregroundStyle(MiloTheme.accent)

                    Text("Routines")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(MiloTheme.foreground)
                    Text("Tasks Milo handles on a schedule.")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)

                    HStack(spacing: MiloTheme.Space.two) {
                        Label("\(enabled) active", systemImage: "bolt.fill")
                        Text("·").foregroundStyle(MiloTheme.muted)
                        Text("\(model.routines.count) total")
                            .foregroundStyle(MiloTheme.muted)
                        Spacer()
                    }
                    .font(MiloTheme.Text.small.weight(.medium))
                    .padding(.top, MiloTheme.Space.one)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MiloTheme.Space.five)
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))

                if model.notificationsAllowed == false {
                    Label("Reminders are off. Allow notifications in Settings.", systemImage: "bell.slash")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    HStack {
                        Text("Your routines")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                    }

                    if let error = model.routinesError, model.routines.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            Text(error).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.danger)
                            Button("Try again") { Task { await model.refreshRoutines() } }
                                .buttonStyle(.glass)
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else if model.routines.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            Image(systemName: model.routinesLoading ? "hourglass" : "sparkles")
                                .font(.system(size: 22, weight: .medium))
                                .foregroundStyle(MiloTheme.accent)
                            Text(model.routinesLoading ? "Reading routines…" : "A little time back, every day.")
                                .font(MiloTheme.Text.body.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("Describe what Milo should do and when. Your routines will show up here.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.five)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else {
                        let visible = model.routines.filter { !$0.finished }
                        if visible.isEmpty {
                            Text("No active routines.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                                .padding(MiloTheme.Space.four)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                        } else {
                            VStack(spacing: MiloTheme.Space.two) {
                                ForEach(visible) { routine in
                                    RoutineRow(
                                        routine: routine,
                                        onOpen: { onSelect(routine.id) },
                                        onRun: { Task { await model.runRoutine(routine.id) } },
                                        onToggle: { Task { await model.setRoutineEnabled(routine.id, enabled: !routine.enabled) } },
                                        onRemove: { removing = routine }
                                    )
                                }
                            }
                        }
                    }
                }

                if !feed.isEmpty {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Text("Recent outputs")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                        ForEach(showAllOutputs ? feed : Array(feed.prefix(4))) { entry in
                            Button {
                                reading = ReadingRun(
                                    run: RoutineRun(id: entry.runId, at: entry.at),
                                    name: entry.routine
                                )
                            } label: {
                                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                                    HStack {
                                        Text(entry.routine).font(MiloTheme.Text.base.weight(.semibold))
                                            .foregroundStyle(MiloTheme.foreground)
                                        Spacer()
                                        Text(RelativeTime.when(entry.at)).font(MiloTheme.Text.meta)
                                            .foregroundStyle(MiloTheme.muted)
                                    }
                                    Text(entry.answer.isEmpty ? "No words — the run sent a file." : entry.answer)
                                        .font(MiloTheme.Text.small)
                                        .foregroundStyle(MiloTheme.foreground2)
                                        .lineLimit(3)
                                }
                                .padding(MiloTheme.Space.four)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                            }
                            .buttonStyle(PressableStyle())
                        }
                        if feed.count > 4 {
                            Button(showAllOutputs ? "Show fewer" : "Show all \(feed.count)") {
                                withAnimation(.easeInOut(duration: 0.2)) { showAllOutputs.toggle() }
                            }
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground2)
                            .buttonStyle(.plain)
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
        .background(MiloTheme.background)
        // The way back to the sessions, at this screen's own top and in the chat's own
        // control: the drawer belongs to the chat, but the routines are one press from it
        // rather than a page with no exit. Drawn in the page's tone, so what scrolls under
        // it stays under it — the same room the chat's bar keeps, in this screen's material.
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: MiloTheme.Space.one) {
                HStack(spacing: 0) {
                    SessionsButton(action: onSessions)
                    Spacer(minLength: 0)
                    if model.routines.contains(where: \.finished) {
                        Menu {
                            menuItem(
                                "Finished (\(model.routines.filter(\.finished).count))",
                                "checkmark.circle"
                            ) {
                                showFinished = true
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .frame(width: 30, height: 30)
                                .frame(width: 46, height: 46)
                                .contentShape(Circle())
                        }
                        .foregroundStyle(MiloTheme.foreground)
                        .buttonStyle(PressableStyle())
                        .glassEffect(.regular.interactive(), in: Circle())
                        .accessibilityLabel("Routine actions")
                    }
                }
                .frame(minHeight: 46)
                ConnectionPill()
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .animation(.smooth(duration: 0.22), value: model.connectionLine)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button(action: onCompose) {
                Label("New routine", systemImage: "plus")
                    .font(MiloTheme.Text.base.weight(.semibold))
                    .foregroundStyle(MiloTheme.accentOn)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(MiloTheme.accent, in: Capsule())
            }
            .disabled(model.busy)
            .glassEffect(.regular.tint(MiloTheme.accent).interactive(), in: Capsule())
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.two)
            .padding(.bottom, MiloTheme.Space.two)
        }
        .refreshable {
            await model.refreshRoutines()
            await loadFeed()
        }
        .task { await model.refreshRoutines() }
        .task { await loadFeed() }
        // The output itself, risen from the bottom of the screen — the same drawer a
        // run on a routine's page opens, over the list it was read from.
        .sheet(item: $reading) { open in
            RunDetail(run: open.run, name: open.name)
        }
        .sheet(isPresented: $showFinished) {
            FinishedRoutinesSheet(onSelect: { id in
                showFinished = false
                onSelect(id)
            })
        }
        .confirmationDialog(
            "Remove the routine “\(removing?.label ?? "")”?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let routine = removing {
                    Task { await model.removeRoutine(routine.id) }
                }
                removing = nil
            }
        }
    }

    private func loadFeed() async {
        feed = (try? await model.routineFeed()) ?? []
    }
}

private struct FinishedRoutinesSheet: View {
    let onSelect: (String) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var removing: RoutineSummary?

    private var finished: [RoutineSummary] {
        model.routines.filter(\.finished)
    }

    var body: some View {
        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
                HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text("Finished")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                        Text("Routines that reached their run limit or finished their schedule.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: MiloTheme.Space.two)
                    MiloIconButton(
                        systemName: "xmark",
                        size: 15,
                        span: 36,
                        glass: true,
                        action: { dismiss() }
                    )
                    .accessibilityLabel("Close")
                }

                if finished.isEmpty {
                    Text("No finished routines.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                } else {
                    VStack(spacing: MiloTheme.Space.two) {
                        ForEach(finished) { routine in
                            RoutineRow(
                                routine: routine,
                                onOpen: { onSelect(routine.id) },
                                onRun: { Task { await model.runRoutine(routine.id) } },
                                onToggle: nil,
                                onRemove: { removing = routine }
                            )
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            "Remove the routine “\(removing?.label ?? "")”?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let routine = removing {
                    Task { await model.removeRoutine(routine.id) }
                }
                removing = nil
            }
        }
    }
}

private struct RoutineRow: View {
    let routine: RoutineSummary
    let onOpen: () -> Void
    let onRun: () -> Void
    var onToggle: (() -> Void)? = nil
    let onRemove: () -> Void

    private var statusColor: Color {
        if routine.finished { return MiloTheme.muted }
        return routine.enabled ? MiloTheme.success : MiloTheme.warning
    }

    var body: some View {
        HStack(alignment: .center, spacing: MiloTheme.Space.three) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                HStack(spacing: MiloTheme.Space.two) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text(routine.label)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                }
                Text("\(routine.whenLabel) · \(routine.targetLabel)")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                    .lineLimit(1)
                Text("\(RoutineWording.stateLabel(routine)) · \(RoutineWording.state(routine))")
                    .font(MiloTheme.Text.meta.weight(.medium))
                    .foregroundStyle(routine.failed ? MiloTheme.danger : MiloTheme.foreground2)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            .accessibilityAddTraits(.isButton)

            HStack(spacing: MiloTheme.Space.two) {
                Button(action: onRun) {
                    Image(systemName: "play.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(MiloTheme.success)
                        .frame(width: 34, height: 34)
                        .contentShape(Circle())
                }
                .buttonStyle(PressableStyle())
                .glassEffect(.regular.tint(MiloTheme.success.opacity(0.24)).interactive(), in: Circle())
                .accessibilityLabel("Run \(routine.label) now")

                if !routine.finished, let onToggle {
                    let pauseTone = routine.enabled ? MiloTheme.warning : MiloTheme.foreground2
                    let iconName = routine.enabled ? "pause.fill" : "play.circle.fill"
                    Button(action: onToggle) {
                        Image(systemName: iconName)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(pauseTone)
                            .frame(width: 34, height: 34)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.tint(pauseTone.opacity(0.24)).interactive(), in: Circle())
                    .accessibilityLabel(routine.enabled ? "Pause \(routine.label)" : "Resume \(routine.label)")
                }
            }
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.vertical, MiloTheme.Space.three + 2)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .contextMenu {
            menuItem("Run now", "play.fill", action: onRun)
            if !routine.finished, let onToggle {
                menuItem(routine.enabled ? "Pause" : "Resume", routine.enabled ? "pause.fill" : "play.circle.fill", action: onToggle)
            }
            Button(role: .destructive, action: onRemove) {
                Label("Remove", systemImage: "trash")
            }
            .tint(Color(.systemRed))
        }
    }
}

// MARK: - One routine

private struct RoutineDetail: View {
    let routineId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var runs: [RoutineRun] = []
    @State private var feed: [RoutineFeedEntry] = []
    @State private var total = 0
    @State private var runsError: String?
    /// The run being read, risen from the bottom of the screen — nil while none is.
    @State private var reading: ReadingRun?
    @State private var working = false
    @State private var confirmRemove = false
    /// Whether the whole of what the routine was asked is open on its card, rather than
    /// the first lines of it.
    @State private var promptOpen = false

    private static let page = 20

    private var routine: RoutineSummary? { model.routines.first { $0.id == routineId } }

    var body: some View {
        // Drawn the way the list it came from is drawn: cards on the page's own tone, and
        // nothing ruled between them.
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let routine {
                    // What the routine is, at a glance: whether it is on, what it is called,
                    // what it was asked to do, and where its answer goes.
                    VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                        HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                            let tone = routine.finished ? MiloTheme.muted : (routine.enabled ? MiloTheme.success : MiloTheme.warning)
                            HStack(spacing: MiloTheme.Space.one + 2) {
                                Circle().fill(tone).frame(width: 7, height: 7)
                                Text(routine.finished ? "Finished" : (routine.enabled ? "Active" : "Paused"))
                                    .font(MiloTheme.Text.meta.weight(.semibold))
                                    .foregroundStyle(tone)
                            }
                            .padding(.horizontal, MiloTheme.Space.two + 2)
                            .padding(.vertical, MiloTheme.Space.one)
                            .background(tone.opacity(0.14), in: Capsule())

                            Spacer()

                            HStack(spacing: MiloTheme.Space.one + 2) {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 10, weight: .semibold))
                                Text(routine.targetLabel)
                                    .font(MiloTheme.Text.meta.weight(.medium))
                                    .lineLimit(1)
                            }
                            .foregroundStyle(MiloTheme.muted)
                            .padding(.horizontal, MiloTheme.Space.two + 2)
                            .padding(.vertical, MiloTheme.Space.one)
                            .background(MiloTheme.surfaceRaised, in: Capsule())
                        }

                        Text(routine.label)
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                            .fixedSize(horizontal: false, vertical: true)

                        if !routine.prompt.isEmpty && routine.name != nil {
                            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                                Text("Instruction")
                                    .font(MiloTheme.Text.meta.weight(.semibold))
                                    .foregroundStyle(MiloTheme.muted)

                                Button {
                                    withAnimation(.easeInOut(duration: 0.22)) { promptOpen.toggle() }
                                } label: {
                                    Text(routine.prompt)
                                        .font(MiloTheme.Text.base)
                                        .foregroundStyle(MiloTheme.foreground2)
                                        .lineLimit(promptOpen ? nil : 3)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(PressableStyle())
                                .accessibilityLabel(promptOpen ? "Show less of the instruction" : "Read the whole instruction")
                            }
                            .padding(MiloTheme.Space.three)
                            .background(MiloTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.five)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))

                    // When it runs and what it last did: the two facts, side by side.
                    HStack(spacing: MiloTheme.Space.two) {
                        factCard(
                            "Schedule",
                            routine.whenLabel,
                            icon: "calendar",
                            iconTone: MiloTheme.accent
                        )
                        factCard(
                            routine.finished ? "State" : routine.lastRunAt != nil ? "Last run" : "Next run",
                            routine.finished ? "Finished" : routine.lastRunAt != nil ? RoutineWording.lastRun(routine) : (routine.enabled ? RoutineWording.nextRun(routine) : "Paused"),
                            icon: "clock",
                            iconTone: routine.failed ? MiloTheme.danger : (routine.enabled ? MiloTheme.success : MiloTheme.warning),
                            failed: routine.failed
                        )
                    }

                    // What it may do with nobody there to ask — the same note the list draws
                    // for the reminders it cannot send.
                    if !routine.allow.isEmpty {
                        Label("May use \(routine.allow.joined(separator: ", ")) while unattended", systemImage: "shield")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .padding(MiloTheme.Space.four)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    }

                    // Whether a run may answer nothing, in the daemon's words.
                    if let silent = routine.silentLabel {
                        Label(silent, systemImage: "bell.slash")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .padding(MiloTheme.Space.four)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    }
                } else {
                    Text("This routine is gone.")
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.muted)
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }

                // The runs it has made, newest first. A tap reads one in the drawer — the
                // same container a changed file's hunks rise in (`DetailSheet`) — rather than
                // opening it under its own row: a run is a whole thread of words, and the
                // page it is listed on is no place for one.
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    Text(total > 0 ? "Runs · \(total)" : "Runs")
                        .font(MiloTheme.Text.title)
                        .foregroundStyle(MiloTheme.foreground)

                    if let runsError {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            Text(runsError)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.danger)
                            Button("Try again") { Task { await loadRuns(reset: true) } }
                                .buttonStyle(.glass)
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else if runs.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                            Label("No runs yet", systemImage: "clock")
                                .font(MiloTheme.Text.body.weight(.medium))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("Your routine’s results will appear here after it runs.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else {
                        VStack(spacing: MiloTheme.Space.two) {
                            ForEach(Array(runs.enumerated()), id: \.element.id) { index, entry in
                                let name = runName(index: index)
                                let preview = feed.first(where: { $0.runId == entry.id })?.answer
                                RunRow(
                                    name: name,
                                    at: entry.at,
                                    isLatest: index == 0,
                                    failed: index == 0 && (routine?.failed ?? false),
                                    preview: preview
                                ) {
                                    reading = ReadingRun(run: entry, name: name)
                                }
                            }
                            if runs.count < total {
                                Button("Show more") { Task { await loadRuns(reset: false) } }
                                    .font(MiloTheme.Text.small)
                                    .buttonStyle(.glass)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six + 56)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(MiloTheme.background)
        .navigationTitle(routine?.label ?? "Routine")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let routine {
                    Menu {
                        menuItem("Run now", "play.fill") {
                            Task { await runNow(routine) }
                        }
                        if !routine.finished {
                            menuItem(routine.enabled ? "Pause" : "Resume", routine.enabled ? "pause.fill" : "play.circle.fill") {
                                Task { await model.setRoutineEnabled(routine.id, enabled: !routine.enabled) }
                            }
                        }
                        Button(role: .destructive) {
                            confirmRemove = true
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                        .tint(Color(.systemRed))
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .frame(width: 32, height: 32)
                            .contentShape(Circle())
                    }
                    .tint(MiloTheme.foreground)
                    .accessibilityLabel("Routine options")
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let routine {
                HStack(spacing: MiloTheme.Space.two) {
                    Button {
                        Task { await runNow(routine) }
                    } label: {
                        HStack(spacing: MiloTheme.Space.two) {
                            if working {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(MiloTheme.successOn)
                            } else {
                                Image(systemName: "play.fill")
                                    .font(.system(size: 14, weight: .semibold))
                            }
                            Text(working ? "Running…" : "Run now")
                                .font(MiloTheme.Text.base.weight(.semibold))
                        }
                        .foregroundStyle(MiloTheme.successOn)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .contentShape(Capsule())
                    }
                    .disabled(working)
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.tint(MiloTheme.success.opacity(0.32)).interactive(), in: Capsule())

                    if !routine.finished {
                        let pauseTone = routine.enabled ? MiloTheme.warning : MiloTheme.foreground
                        Button {
                            Task { await model.setRoutineEnabled(routine.id, enabled: !routine.enabled) }
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                Image(systemName: routine.enabled ? "pause.fill" : "play.circle.fill")
                                    .font(.system(size: 15, weight: .semibold))
                                Text(routine.enabled ? "Pause" : "Resume")
                                    .font(MiloTheme.Text.base.weight(.semibold))
                            }
                            .foregroundStyle(pauseTone)
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .glassEffect(.regular.tint(pauseTone.opacity(0.24)).interactive(), in: Capsule())
                    }
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.top, MiloTheme.Space.two)
                .padding(.bottom, MiloTheme.Space.two)
                .background(.ultraThinMaterial.opacity(0.85))
            }
        }
        .confirmationDialog(
            "Remove the routine “\(routine?.label ?? "")”?",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                Task {
                    await model.removeRoutine(routineId)
                    dismiss()
                }
            }
        }
        .task { await loadRuns(reset: true) }
        // The run itself, risen from the bottom of the screen: the same container a changed
        // file's hunks use (see `DetailSheet`).
        .sheet(item: $reading) { open in
            RunDetail(run: open.run, name: open.name)
        }
    }

    private func factCard(_ label: String, _ value: String, icon: String, iconTone: Color = MiloTheme.muted, failed: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(iconTone)
                Text(label)
                    .font(MiloTheme.Text.meta.weight(.medium))
                    .foregroundStyle(MiloTheme.muted)
            }
            Text(value)
                .font(MiloTheme.Text.base.weight(.semibold))
                .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.foreground)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(MiloTheme.Space.four)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }

    private func loadRuns(reset: Bool) async {
        runsError = nil
        async let runsTask: RoutineRuns = model.routineRuns(routineId, offset: reset ? 0 : runs.count, limit: Self.page)
        async let feedTask: [RoutineFeedEntry] = (try? await model.routineFeed()) ?? []
        do {
            let page = try await runsTask
            runs = reset ? page.runs : runs + page.runs
            total = page.total
            feed = await feedTask
        } catch {
            runsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// What a run is called where it is listed and where it is read: the newest is the latest
    /// run, and every other is counted from the routine's first.
    private func runName(index: Int) -> String {
        index == 0 ? "Latest run" : "Run \(total - index)"
    }

    /// Opens the drawer on one of the runs the list is showing, by id: the one just fired.
    /// A run the list has not caught up with opens nothing — there is no row for it to have
    /// been read from.
    private func read(_ id: String?) {
        guard let id, let index = runs.firstIndex(where: { $0.id == id }) else { return }
        reading = ReadingRun(run: runs[index], name: runName(index: index))
    }

    /// Fires it now and reads the run it made — one way to see what a run said.
    private func runNow(_ routine: RoutineSummary) async {
        working = true
        defer { working = false }
        guard let result = await model.runRoutine(routine.id) else { return }
        await loadRuns(reset: true)
        read(result.runId)
    }
}

// MARK: - One run

/// One run as the drawer reads it: the run itself, and what the row it came from called it,
/// so the two cannot disagree about which run is open.
private struct ReadingRun: Identifiable {
    let run: RoutineRun
    /// The words its row carries — "Latest run", or the run's number.
    let name: String

    var id: String { run.id }
}

/// One run as the list draws it: which run it is and when it happened. A tap reads it in the
/// drawer, where a whole thread of words has the room to itself — and the row, being the
/// control, wears no glyph of its own.
private struct RunRow: View {
    let name: String
    let at: Double
    let isLatest: Bool
    let failed: Bool
    let preview: String?
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.two) {
                    Circle()
                        .fill(failed ? MiloTheme.danger : (isLatest ? MiloTheme.success : MiloTheme.muted2))
                        .frame(width: 8, height: 8)
                    Text(name)
                        .font(MiloTheme.Text.body.weight(isLatest ? .semibold : .medium))
                        .foregroundStyle(MiloTheme.foreground)
                    Spacer(minLength: MiloTheme.Space.two)
                    Text(RelativeTime.when(at))
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                if let preview, !preview.isEmpty {
                    Text(preview)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground2)
                        .lineLimit(2)
                        .padding(.leading, MiloTheme.Space.two + 8)
                }
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        }
        .buttonStyle(PressableStyle())
    }
}

/**
 One run, risen from the bottom of the screen: which run it is and when, then what it said,
 drawn as the chat draws a thread.

 The words are not in the page's own list — that holds the runs' summaries — so they are read
 from the daemon as the drawer opens, and the drawer says it is reading them rather than
 standing there empty.
 */
private struct RunDetail: View {
    let run: RoutineRun
    /// What the drawer calls it, in the words the row it came from carried.
    let name: String

    @Environment(AppModel.self) private var model
    @State private var thread: [AppModel.Message]?
    @State private var error: String?

    var body: some View {
        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                HStack(spacing: MiloTheme.Space.two) {
                    Text(name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                    Spacer(minLength: MiloTheme.Space.two)
                    Text(RelativeTime.when(run.at))
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }

                if let error {
                    Text(error)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                } else if let thread {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
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
                    }
                } else {
                    HStack(spacing: MiloTheme.Space.two) {
                        ProgressView().controlSize(.small)
                        Text("Reading this run…")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
            }
        }
        .task { await read() }
    }

    private func read() async {
        do {
            let transcript = try await model.routineTranscript(run.id)
            thread = transcript.map {
                AppModel.Message(
                    isUser: $0.role == "user",
                    parts: $0.parts,
                    attachments: $0.attachments ?? [],
                    streaming: false,
                    thought: $0.thoughtMs.map { $0 / 1000 },
                    raw: $0.raw,
                    rawNoOutput: $0.rawNoOutput
                )
            }
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - A new routine

private struct NewRoutine: View {
    let account: Account

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ask = ""
    @State private var destination: Destination = .chat
    @State private var typedChatId = ""
    /// Where the creation turn starts in the chat's transcript; nil until asked.
    @State private var createdFrom: Int?
    @FocusState private var asking: Bool

    private struct Starter: Identifiable {
        let icon: String
        let title: String
        let detail: String
        let prompt: String
        var id: String { title }

        static let all: [Starter] = [
            Starter(
                icon: "envelope",
                title: "Morning inbox brief",
                detail: "Summarize unread mail every weekday morning",
                prompt: "Every weekday at 8am, check my inbox and summarize anything that needs a reply."
            ),
            Starter(
                icon: "arrow.triangle.branch",
                title: "Daily repo digest",
                detail: "Check what changed in the repository each evening",
                prompt: "Every weekday at 6pm, look at the repo and summarize what moved today."
            ),
            Starter(
                icon: "checklist",
                title: "Weekly open tasks",
                detail: "Review open task lists every Monday morning",
                prompt: "Every Monday at 9am, go through my task lists and shape a plan for the week."
            ),
        ]
    }

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
        var symbol: String {
            switch self {
            case .chat: return "bubble.left"
            case .telegram: return "paperplane"
            case .discord: return "number"
            case .screenOnly: return "clock"
            }
        }
        var note: String {
            switch self {
            case .chat: return "This phone’s chat."
            case .telegram, .discord: return "The chat or channel to post into."
            case .screenOnly: return "Kept on the Routines screen — no chat."
            }
        }
        var needsChatId: Bool { self == .telegram || self == .discord }
    }

    private var canCreate: Bool {
        !ask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.busy
            && model.connection == .online
            && (!destination.needsChatId || !typedChatId.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    /// What has been asked here and answered here: nothing until the first ask.
    private var thread: [AppModel.Message] {
        guard let createdFrom, createdFrom <= model.messages.count else { return [] }
        return Array(model.messages[createdFrom...])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                header

                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    Text("What should Milo do, and when?")
                        .font(MiloTheme.Text.base.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)

                    TextField(
                        "Every weekday at 8, look at the repo and tell me what moved.",
                        text: $ask,
                        axis: .vertical
                    )
                    .lineLimit(4...8)
                    .focused($asking)
                    .font(MiloTheme.Text.body)
                    .foregroundStyle(MiloTheme.foreground)
                    .padding(MiloTheme.Space.four)
                    .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    .onTapGesture { asking = true }

                    if createdFrom == nil {
                        VStack(spacing: MiloTheme.Space.two) {
                            ForEach(Starter.all) { starter in
                                Button {
                                    ask = starter.prompt
                                    asking = true
                                } label: {
                                    HStack(spacing: MiloTheme.Space.three) {
                                        Image(systemName: starter.icon)
                                            .font(.system(size: 15, weight: .medium))
                                            .foregroundStyle(MiloTheme.accent)
                                            .frame(width: 24, alignment: .center)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(starter.title)
                                                .font(MiloTheme.Text.base.weight(.medium))
                                                .foregroundStyle(MiloTheme.foreground)
                                            Text(starter.detail)
                                                .font(MiloTheme.Text.meta)
                                                .foregroundStyle(MiloTheme.muted)
                                        }
                                        Spacer(minLength: MiloTheme.Space.two)
                                    }
                                    .padding(.horizontal, MiloTheme.Space.four)
                                    .padding(.vertical, MiloTheme.Space.three)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                                    .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                                }
                                .buttonStyle(PressableStyle())
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    Text("Delivery destination")
                        .font(MiloTheme.Text.base.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)

                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        HStack(spacing: MiloTheme.Space.three) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Service")
                                    .font(MiloTheme.Text.base.weight(.medium))
                                    .foregroundStyle(MiloTheme.foreground)
                                Text(destination.note)
                                    .font(MiloTheme.Text.meta)
                                    .foregroundStyle(MiloTheme.muted)
                            }
                            Spacer(minLength: MiloTheme.Space.two)
                            Menu {
                                ForEach(Destination.allCases) { choice in
                                    menuItem(choice.label, choice.symbol) {
                                        destination = choice
                                    }
                                }
                            } label: {
                                HStack(spacing: MiloTheme.Space.two) {
                                    Text(destination.label)
                                        .font(MiloTheme.Text.small.weight(.semibold))
                                        .foregroundStyle(MiloTheme.foreground)
                                        .lineLimit(1)
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(MiloTheme.muted)
                                }
                                .padding(.horizontal, MiloTheme.Space.three)
                                .padding(.vertical, MiloTheme.Space.two)
                                .background(MiloTheme.surfaceWarm, in: Capsule())
                                .contentShape(Capsule())
                            }
                            .buttonStyle(PressableStyle())
                        }

                        if destination.needsChatId {
                            TextField("a chat or channel id", text: $typedChatId)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .font(MiloTheme.Text.base)
                                .foregroundStyle(MiloTheme.foreground)
                                .padding(.horizontal, MiloTheme.Space.four)
                                .padding(.vertical, MiloTheme.Space.three)
                                .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                        }
                    }
                    .padding(MiloTheme.Space.four)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }

                if !thread.isEmpty {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Routine setup")
                                .font(MiloTheme.Text.title)
                                .foregroundStyle(MiloTheme.foreground)
                            Text("Milo’s questions and confirmation appear here.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }

                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
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
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.six)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(MiloTheme.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: MiloTheme.Space.two) {
                ConnectionPill()
                Button(action: create) {
                    HStack(spacing: MiloTheme.Space.two) {
                        if model.busy {
                            ProgressView()
                                .controlSize(.small)
                                .tint(MiloTheme.accentOn)
                        } else {
                            Image(systemName: "plus")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        Text(model.busy ? "Milo is on it…" : "Create routine")
                            .font(MiloTheme.Text.base.weight(.semibold))
                    }
                    .foregroundStyle(MiloTheme.accentOn)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(MiloTheme.accent, in: Capsule())
                }
                .buttonStyle(PressableStyle())
                .disabled(!canCreate)
                .opacity(canCreate ? 1 : 0.45)
                .glassEffect(.regular.tint(MiloTheme.accent).interactive(), in: Capsule())
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.two)
            .padding(.bottom, MiloTheme.Space.two)
        }
        .presentationDetents([.fraction(0.9), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(MiloTheme.background)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                Text("New routine")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Text("Describe the task and schedule. Milo will turn your request into a routine.")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: MiloTheme.Space.two)
            MiloIconButton(
                systemName: "xmark",
                size: 15,
                span: 36,
                glass: true,
                action: { dismiss() }
            )
            .accessibilityLabel("Close")
        }
    }

    private func create() {
        let text = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        asking = false
        // Taken before the turn starts: everything from here on is this ask and Milo's
        // answer, so the wait and the permission prompt stay beside it.
        if createdFrom == nil { createdFrom = model.messages.count }
        ask = ""
        // The destination is pinned on the turn, so a routine named for Telegram is made
        // for Telegram even though the chat it was asked in is this one.
        model.send(text, target: SendTarget(gateway: gateway, chatId: destinationChatId))
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
    /// the Routines screen carry this phone's own chat, the way the browser does.
    private var destinationChatId: String {
        destination.needsChatId ? typedChatId.trimmingCharacters(in: .whitespaces) : account.chatId
    }
}

// MARK: - Wording

/// How a routine reads on a row and on its page, from the daemon's own labels and times.
private enum RoutineWording {
    /// What the state cell is labelled: a word is a status, a time is a run.
    static func stateLabel(_ routine: RoutineSummary) -> String {
        if routine.finished { return "Status" }
        if routine.lastRunAt != nil { return "Last run" }
        return routine.enabled ? "Next run" : "Status"
    }

    /// How a routine reads as a state: a failure first, then the two words that mean not
    /// running — finished, which its own ceiling did, and paused, which the person did.
    static func state(_ routine: RoutineSummary) -> String {
        if routine.failed { return "Failed" }
        if routine.finished { return "Finished" }
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
