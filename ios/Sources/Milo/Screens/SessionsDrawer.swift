import SwiftUI

/// The sessions, resting behind the chat. The chat is the layer that travels, so
/// the rounded edge and the shadow belong to it; this one is a plain column on
/// the sidebar's own tone, full-bleed to the screen's edges.
struct SessionsDrawer: View {
    let routinesSelected: Bool
    let tasksSelected: Bool
    /// Which world the session in front belongs to: the card is a project's, or the chat is
    /// a session working in one. The list the drawer opens on follows it.
    let workMode: Bool
    /// Whether the drawer is uncovered, so the list starts on the world in front each time
    /// it is opened rather than on whichever one was looked at last.
    let revealed: Bool
    let onClose: () -> Void
    let onNewSession: () -> Void
    let onNewProject: () -> Void
    let onSettings: () -> Void
    let onRoutines: () -> Void
    let onTasks: () -> Void
    /// The switch's two sides. Choosing one moves the card behind the drawer to where that
    /// world begins, while the list it changed stays in front.
    let onChatWorld: () -> Void
    let onWorkWorld: () -> Void
    let onWorkProject: (String) -> Void
    let onWorkSession: (String) -> Void
    @Environment(AppModel.self) private var model
    /// The session being renamed, by id: the row's own press names one, and the alert
    /// the modifier presents does the rest.
    @State private var renaming: String?
    /// What is typed into the search field, narrowing the list to the rows that carry it.
    @State private var query = ""
    /// Whether the field is up. It folds behind the magnifier in the drawer's own title row,
    /// where this platform keeps search on a list, and takes the switch's row when asked for.
    @State private var searchOpen = false
    /// Where the cursor goes as the field comes up, so the first thing done is typing.
    @FocusState private var searching: Bool
    /// Which half of the list is drawn. It starts on the world in front and is the person's
    /// to move while the drawer is open; chosen here rather than by the card because looking
    /// through the other list is not yet opening anything.
    @State private var workList = false

    var body: some View {
        HStack(spacing: 0) {
            column
                .frame(width: 300, alignment: .leading)
                // What starts a session and what sets one up float at the drawer's own
                // end, over the list, on the right, in the platform's glass — the controls
                // here that are not sessions themselves.
                .overlay(alignment: .bottomTrailing) { controls }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(MiloTheme.surface.ignoresSafeArea())
        .sessionRename($renaming)
        .onAppear { workList = workMode }
        .onChange(of: workMode) { _, next in workList = next }
        .onChange(of: revealed) { _, up in
            if up {
                workList = workMode
                closeSearch()
            }
        }
    }

    private var column: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            // The drawer's name, with the way into the list's search at the far end — where
            // this platform puts search on a list's own screen rather than among the list's
            // rows. It is glass, as the drawer's floating controls are.
            HStack(spacing: MiloTheme.Space.two) {
                Text("Milo")
                    .font(.title.weight(.bold))
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: 0)
                if canSearch {
                    Button {
                        withAnimation(.smooth(duration: 0.22)) { searchOpen = true }
                    } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .frame(width: 38, height: 38)
                            .contentShape(Circle())
                    }
                    .glassEffect(.regular.interactive(), in: Circle())
                    .accessibilityLabel(workList ? "Search work" : "Search chats")
                }
            }
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.top, MiloTheme.Space.four)

            // Places, not modes: the routines and the task lists are pages of their own,
            // reached the same way from either world, so they sit above the switch — never
            // inside the list the switch narrows.
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                pageTab("Routines", symbol: "clock", selected: routinesSelected, action: onRoutines)
                pageTab("Task lists", symbol: "checklist", selected: tasksSelected, action: onTasks)
            }
            .padding(.horizontal, MiloTheme.Space.three)

            // Which world the list is of, asked in the platform's own shape — and, asked for,
            // the field that narrows it takes that row.
            if searchOpen {
                searchField
            } else {
                ModeSwitch(
                    work: workList,
                    onChat: {
                        workList = false
                        onChatWorld()
                    },
                    onWork: {
                        workList = true
                        onWorkWorld()
                    }
                )
                .padding(.horizontal, MiloTheme.Space.three)
            }

            if let emptyLine {
                Text(emptyLine)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.muted)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.top, MiloTheme.Space.two)
            }

            // The list is a column, not a page: its own scroll bar would be drawn at the seam
            // with the card and flash there each time the drawer is uncovered.
            ScrollView {
                LazyVStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                    if workList {
                        workListRows
                    } else {
                        chatListRows
                    }
                }
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.bottom, Self.controlsClearance)
            }
            .scrollIndicators(.hidden)
        }
    }

    /// The tap target of each floating control, and the room the list keeps under them so
    /// the last session is not lost behind the glass. They sit side by side, so it is their
    /// height the list has to clear, not their width.
    private static let controlSpan: CGFloat = 44
    private static let controlsClearance = controlSpan + MiloTheme.Space.four + MiloTheme.Space.three

    /// Starting a session and setting one up, at the drawer's own end. The label follows the
    /// list: a chat starts from here, and a project does not — Work starts a session on a
    /// project's page, so the way in from this side is adding the folder it would work in.
    /// New session states what it does in words — a disc with a mark on it would leave the
    /// mark to be read — and wears the accent as the glass's tint, in the tone the composer
    /// spends on the way to send; the way into the settings keeps the plain glass of a
    /// control that only goes somewhere, and the gear says that much on its own.
    private var controls: some View {
        HStack(spacing: MiloTheme.Space.three) {
            Button { workList ? onNewProject() : onNewSession() } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: workList ? "folder.badge.plus" : "square.and.pencil")
                        .font(.system(size: 16, weight: .semibold))
                    Text(workList ? "New project" : "New session")
                        .font(MiloTheme.Text.base)
                }
                .foregroundStyle(MiloTheme.accentOn)
                .padding(.horizontal, MiloTheme.Space.five)
                .frame(height: Self.controlSpan)
                .contentShape(Capsule())
            }
            .glassEffect(.regular.tint(MiloTheme.accent).interactive(), in: Capsule())

            Button { onSettings() } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .frame(width: Self.controlSpan, height: Self.controlSpan)
            }
            .glassEffect(.regular.interactive(), in: Circle())
            .accessibilityLabel("Settings")
        }
        .padding(.trailing, MiloTheme.Space.four)
        .padding(.bottom, MiloTheme.Space.four)
    }

    /// A workspace page beside the list: routines and task lists are places you go to from
    /// either world, not controls that start a session and not sides of the switch, so they
    /// sit under their own heading above it rather than inside the list it narrows or among
    /// the controls at the foot.
    /// Drawn as the list's own row — the same box, the same tone, the same fill for the one
    /// showing — so it answers the finger the way a session does; what tells the two apart is
    /// the mark and the name, never the box.
    private func pageTab(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .medium))
                Text(title)
                    .font(MiloTheme.Text.body.weight(.medium))
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.two)
            .background(
                selected ? MiloTheme.surfaceRaised : Color.clear,
                in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
            )
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(title)
    }

    /// What the search field narrows the list to: the words on the row, the preview and
    /// the id — the browser's own fields, so the same query finds the same rows on both.
    private var text: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var searched: Bool { !text.isEmpty }

    /// What the Work list says when it holds no project: reading, a read that failed, and
    /// none at all are three different things a bare "none" would flatten into one.
    private var projectsEmptyLine: String {
        if model.projectsError != nil { return "Could not read your projects" }
        if model.projectsLoading || !model.projectsRead { return "Reading your projects…" }
        return "No projects yet"
    }

    /// The sessions this drawer holds on the Chat side: the chats. A session working in a
    /// project belongs to the Work side, under that project's own name.
    private var chats: [SessionSummary] {
        model.sessions.filter {
            !isWorkSession($0, projects: model.projects, read: model.projectsRead)
        }
    }

    private var filtered: [SessionSummary] {
        guard searched else { return chats }
        return chats.filter { sessionMatches($0, query: text) }
    }

    /// Whether there is anything for the search to narrow: nothing to find is no magnifier.
    private var canSearch: Bool {
        workList ? !model.projects.isEmpty : !chats.isEmpty
    }

    /// What the list says when it has nothing to draw: reading, a failed read, or none at
    /// all in Work; a new install or a filter of only empty sessions in Chat.
    private var emptyLine: String? {
        if workList {
            return model.projects.isEmpty ? projectsEmptyLine : nil
        }
        guard chats.isEmpty else { return nil }
        return model.sessions.isEmpty ? "No sessions yet" : "No chats yet"
    }

    /// Folding the field away, which also gives the list back whole.
    private func closeSearch() {
        searching = false
        searchOpen = false
        query = ""
    }

    /// The search field, filled like every control here rather than outlined: a field on
    /// the drawer's own surface, with the mark the browser's own search carries. Its words
    /// name the list it narrows, because the two lists are not searched alike.
    private var searchField: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Image(systemName: "magnifyingglass")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
            TextField(workList ? "Search work" : "Search chats", text: $query)
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searching)
                .onAppear { searching = true }
            Button {
                withAnimation(.smooth(duration: 0.22)) { closeSearch() }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
            }
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .frame(height: 38)
        // The same material as the magnifier that asked for it: the field is the list's own
        // control while it is up, not a filled line laid under the switch.
        .glassEffect(.regular, in: Capsule())
        .padding(.horizontal, MiloTheme.Space.three)
        .transition(.opacity)
    }

    /// The list the way the browser buckets it: how recent, newest group first, with the
    /// same four headings and the same boundaries — a session sits under the same one on
    /// both surfaces. `updatedAt` is in milliseconds, as the daemon sends it.
    private var groups: [(title: String, sessions: [SessionSummary])] {
        let day: Double = 86_400_000
        let startOfToday = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        let ranges: [(title: String, from: Double, to: Double)] = [
            ("Today", startOfToday, .infinity),
            ("Yesterday", startOfToday - day, startOfToday),
            ("Previous 7 days", startOfToday - 7 * day, startOfToday - day),
            ("Older", -.infinity, startOfToday - 7 * day),
        ]
        return ranges
            .map { range in
                (
                    title: range.title,
                    sessions: filtered.filter { $0.updatedAt >= range.from && $0.updatedAt < range.to }
                )
            }
            .filter { !$0.sessions.isEmpty }
    }

    @ViewBuilder private var chatListRows: some View {
        if groups.isEmpty, searched {
            Text("No sessions found.")
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.top, MiloTheme.Space.two)
        }
        ForEach(groups, id: \.title) { group in
            Text(group.title)
                .font(MiloTheme.Text.meta.weight(.medium))
                .textCase(.uppercase)
                .tracking(0.7)
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.top, MiloTheme.Space.three)
                .padding(.bottom, MiloTheme.Space.one)
            ForEach(group.sessions) { session in
                row(session) {
                    onClose()
                    Task { await model.resume(session.id) }
                }
            }
        }
    }

    /// One project of the Work side: its own name over the sessions it holds, the way the
    /// index draws it one level in. The name opens the project's page, where the folder and
    /// the rest of its sessions are; a session opens its chat.
    private struct WorkGroupRow: Identifiable {
        let project: Project
        let sessions: [SessionSummary]
        /// Every session the project holds, drawn or behind "All N sessions".
        let total: Int
        var id: String { project.id }
    }

    private var workGroups: [WorkGroupRow] {
        model.projects.compactMap { project in
            let mine = model.sessions
                .filter { $0.project == project.id }
                .sorted { $0.updatedAt > $1.updatedAt }
            let named = searched && project.name.lowercased().contains(text)
            let matching = searched && !named ? mine.filter { sessionMatches($0, query: text) } : mine
            if searched && !named && matching.isEmpty { return nil }
            return WorkGroupRow(
                project: project,
                sessions: inlineWorkSessions(matching),
                total: mine.count
            )
        }
    }

    @ViewBuilder private var workListRows: some View {
        if workGroups.isEmpty, searched {
            Text("No sessions found.")
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.top, MiloTheme.Space.two)
        }
        ForEach(workGroups) { group in
            VStack(alignment: .leading, spacing: 0) {
                projectHeading(group.project)
                ForEach(group.sessions) { session in
                    row(session) {
                        onWorkSession(session.id)
                    }
                }
                if group.total > group.sessions.count {
                    Button { onWorkProject(group.project.id) } label: {
                        HStack(spacing: MiloTheme.Space.two) {
                            Text("All \(group.total) sessions")
                            Spacer(minLength: MiloTheme.Space.two)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .font(MiloTheme.Text.meta.weight(.medium))
                        .foregroundStyle(MiloTheme.muted)
                        .padding(.horizontal, MiloTheme.Space.three)
                        .padding(.vertical, MiloTheme.Space.two)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("All \(group.total) sessions")
                }
            }
            .padding(.top, MiloTheme.Space.three)
        }
    }

    /// A project's name over its sessions: a heading that answers like a row, so opening the
    /// page is the same press as opening a session. A folder that is gone still opens — its
    /// page is where the reason is read and the project is removed — and says so here.
    private func projectHeading(_ project: Project) -> some View {
        Button { onWorkProject(project.id) } label: {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: ProjectMark.symbol(project.icon))
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(MiloTheme.muted2)
                Text(project.name)
                    .font(MiloTheme.Text.body.weight(.semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: MiloTheme.Space.two)
                if project.error != nil {
                    Text("Gone")
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.danger)
                }
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.two)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(project.error.map { "\(project.name), \($0)" } ?? project.name)
    }

    /// A session: a tap opens it, a hold lifts it into its card. Not a `Button` — a
    /// `ButtonStyle` takes the press for its own animation, and the platform's long press
    /// then never reaches the row, so nothing is ever raised.
    private func row(_ session: SessionSummary, opening: @escaping () -> Void) -> some View {
        let current = session.id == model.sessionId
        return HStack(spacing: MiloTheme.Space.two) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                // How much was said, and when — the browser's own second line on a
                // session's row, so a list of names is not all the drawer says.
                Text(session.meta)
                    .font(MiloTheme.Text.meta.monospacedDigit())
                    .foregroundStyle(MiloTheme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: MiloTheme.Space.two)
            // One mark at the row's edge, never two: it breathes while a turn is
            // running there, and stands still when the session moved after it was last
            // looked at.
            SessionMark(running: session.running, unread: session.unread)
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.two)
        .background(
            current ? MiloTheme.surfaceRaised : .clear,
            in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
        )
        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .onTapGesture(perform: opening)
        // A row that opens a session reads as a control, the way the button it used to be
        // did: a tap is not the only way to answer one.
        .accessibilityAddTraits(.isButton)
        .sessionMenu(session, renaming: $renaming)
    }
}
