import SwiftUI

/// The sessions, resting behind the chat. The chat is the layer that travels, so
/// the rounded edge and the shadow belong to it; this one is a plain column on
/// the sidebar's own tone, full-bleed to the screen's edges.
struct SessionsDrawer: View, Equatable {
    let routinesSelected: Bool
    let tasksSelected: Bool
    let analyticsSelected: Bool
    let crewSelected: Bool
    /// Which world the session in front belongs to: the card is a project's, or the chat is
    /// a session working in one. The list the drawer opens on follows it.
    /// Whether the drawer is uncovered, so the list starts on the world in front each time
    /// it is opened rather than on whichever one was looked at last.
    let revealed: Bool
    let swiping: Bool
    let onClose: () -> Void
    let onNewSession: () -> Void
    let onNewFolderSession: (String, String) -> Void
    let onSettings: () -> Void
    let onRoutines: () -> Void
    let onTasks: () -> Void
    let onAnalytics: () -> Void
    let onCrew: () -> Void
    let onTraces: (SessionSummary) -> Void

    nonisolated static func == (lhs: SessionsDrawer, rhs: SessionsDrawer) -> Bool {
        lhs.routinesSelected == rhs.routinesSelected
            && lhs.tasksSelected == rhs.tasksSelected
            && lhs.analyticsSelected == rhs.analyticsSelected
            && lhs.crewSelected == rhs.crewSelected
            && lhs.revealed == rhs.revealed
            && lhs.swiping == rhs.swiping
    }
    /// The switch's two sides. Choosing one moves the card behind the drawer to where that
    /// world begins, while the list it changed stays in front.
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
    /// The footer's glass, named so the controls that stay keep their skin while the ones
    /// that change melt into place — one material, not two that blink at each other.
    @Namespace private var footerGlass
    @State private var listCache = ListCache()

    var body: some View {
        let snapshot = listCache.snapshot(
            sessions: model.sessions,
            sessionId: model.sessionId,
            projects: model.projects,
            query: text
        )
        HStack(spacing: 0) {
            column(snapshot)
                .frame(width: 300, alignment: .leading)
                // What starts a session and what sets one up float at the drawer's own
                // end, over the list, on the right, in the platform's glass — the controls
                // here that are not sessions themselves.
                .overlay(alignment: .bottomTrailing) {
                    // Out of the tree the moment the drawer starts to close, not faded: glass
                    // does not follow its parent's opacity, and the card sliding over this
                    // layer is glass too, so a control still there shows through it.
                    if revealed {
                        controls.transition(.identity)
                    }
                }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(MiloTheme.surface.ignoresSafeArea())
        .sessionRename($renaming)
        .onChange(of: revealed) { _, up in
            if up {
                closeSearch()
            }
        }
    }

    private func column(_ snapshot: ListSnapshot) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            // The drawer's name, with the way into the list's search at the far end — where
            // this platform puts search on a list's own screen rather than among the list's
            // rows. It is glass, as the drawer's floating controls are.
            HStack(spacing: MiloTheme.Space.two) {
                Menu {
                    Picker("Colour palette", selection: Binding(
                        get: { model.effectivePalette },
                        set: { palette in Task { await model.setPalette(palette) } }
                    )) {
                        ForEach(MiloPaletteId.allCases) { palette in
                            Label {
                                Text(palette == .peach ? "\(palette.label) (Default)" : palette.label)
                            } icon: {
                                Image(uiImage: MiloMark.menuImage(for: palette, size: 22, trailingSpace: 0))
                            }
                            .tag(palette)
                        }
                    }
                } label: {
                    MiloMark(size: 26)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .accessibilityLabel("Choose colour palette")
                Text("Milo")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: 0)
                if snapshot.canSearch {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { searchOpen = true }
                    } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .frame(width: 38, height: 38)
                            .contentShape(Circle())
                    }
                    .glassEffect(.regular.interactive(), in: Circle())
                    .accessibilityLabel("Search sessions")
                }
            }
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.top, MiloTheme.Space.six)
            .padding(.bottom, MiloTheme.Space.two)

            // Places, not modes: the routines and the task lists are pages of their own,
            // reached the same way from either world, so they sit above the switch — never
            // inside the list the switch narrows.
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                pageTab("Analytics", symbol: "chart.bar", selected: analyticsSelected, action: onAnalytics)
                pageTab("Crew", symbol: "crew", selected: crewSelected, action: onCrew)
                pageTab("Routines", symbol: "clock", selected: routinesSelected, action: onRoutines)
                pageTab("Task lists", symbol: "checklist", selected: tasksSelected, action: onTasks)
            }
            .padding(.horizontal, MiloTheme.Space.three)

            // Which world the list is of, asked in the platform's own shape — and, asked for,
            // the field that narrows it takes that row.
            if searchOpen { searchField }

            if let emptyLine = snapshot.emptyLine {
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
                    chatListRows(snapshot)
                }
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.bottom, Self.controlsClearance)
            }
            .scrollIndicators(.hidden)
            .scrollDisabled(swiping)
        }
    }

    /// The tap target of each floating control, and the room the list keeps under them so
    /// the last session is not lost behind the glass. They sit side by side, so it is their
    /// height the list has to clear, not their width.
    private static let controlSpan: CGFloat = 44
    private static let controlsClearance = controlSpan + MiloTheme.Space.four + MiloTheme.Space.three

    /// Starting a session and setting one up, at the drawer's own end. On the Chat side the
    /// one act is a chat. On Work both live here: a new session, which asks which project
    /// first — a work session works in one, and the menu is where it is chosen, with no
    /// caret to spend the row's room on — and adding the folder, as a mark-only control
    /// because its name is said on the page the press opens.
    /// The session action carries the active palette on both sides of the list.
    private var controls: some View {
        // One glass surface per control, held in the drawer's container, so switching sides
        // morphs the strip rather than replacing it: the session keeps its capsule and the
        // folder's skin melts out beside it, the way the platform's own glass rearranges.
        GlassEffectContainer(spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                    Button(action: onNewSession) {
                        HStack(spacing: MiloTheme.Space.two) {
                            Image(systemName: "plus")
                                .font(.system(size: 16, weight: .semibold))
                            Text("New session")
                                .font(MiloTheme.Text.base)
                        }
                        .foregroundStyle(MiloTheme.accentOn)
                        .padding(.horizontal, MiloTheme.Space.five)
                        .frame(height: Self.controlSpan)
                        .background(MiloTheme.accent, in: Capsule())
                        .contentShape(Capsule())
                    }
                    .glassEffect(.regular.tint(MiloTheme.accent).interactive(), in: Capsule())
                    .glassEffectID("new-session", in: footerGlass)
                Button { onSettings() } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .frame(width: Self.controlSpan, height: Self.controlSpan)
                }
                .glassEffect(.regular.interactive(), in: Circle())
                .glassEffectID("settings", in: footerGlass)
                .accessibilityLabel("Settings")
            }
        }
        .padding(.trailing, MiloTheme.Space.three)
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
                Group {
                    if symbol == "crew" {
                        CrewDrawerMark(size: 23)
                    } else {
                        Image(systemName: symbol)
                            .font(MiloTheme.Text.body)
                    }
                }
                .foregroundStyle(MiloTheme.foreground)
                .frame(width: MiloTheme.Space.six)
                Text(title)
                    .font(MiloTheme.Text.body.weight(.medium))
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.three)
            .background(
                selected ? MiloTheme.surfaceRaised : Color.clear,
                in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
            )
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// What the search field narrows the list to: the words on the row, the preview and
    /// the id — the browser's own fields, so the same query finds the same rows on both.
    private var text: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var searched: Bool { !text.isEmpty }

    private struct ListSnapshot {
        let canSearch: Bool
        let emptyLine: String?
        let filteredCount: Int
        let groups: [(title: String, sessions: [SessionSummary])]
        let projectNames: [String: String]
    }

    private final class ListCache {
        private var sessions: [SessionSummary] = []
        private var sessionId = ""
        private var projects: [Project] = []
        private var query = ""
        private var startOfToday: Double = 0
        private var cached: ListSnapshot?

        func snapshot(
            sessions: [SessionSummary],
            sessionId: String,
            projects: [Project],
            query: String
        ) -> ListSnapshot {
            let today = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
            if let cached,
               self.sessions == sessions,
               self.sessionId == sessionId,
               self.projects == projects,
               self.query == query,
               self.startOfToday == today {
                return cached
            }

            let chats = sessions.filter {
                $0.messageCount > 0 || $0.backend?.kind == "command-code" || $0.id == sessionId
            }
            let filtered = query.isEmpty ? chats : chats.filter { $0.searchText.contains(query) }

            let day: Double = 86_400_000
            let yesterday = today - day
            let week = today - 7 * day
            var todayList: [SessionSummary] = []
            var yesterdayList: [SessionSummary] = []
            var weekList: [SessionSummary] = []
            var olderList: [SessionSummary] = []
            for session in filtered {
                if session.updatedAt >= today {
                    todayList.append(session)
                } else if session.updatedAt >= yesterday {
                    yesterdayList.append(session)
                } else if session.updatedAt >= week {
                    weekList.append(session)
                } else {
                    olderList.append(session)
                }
            }

            var groups: [(title: String, sessions: [SessionSummary])] = []
            if !todayList.isEmpty { groups.append(("Today", todayList)) }
            if !yesterdayList.isEmpty { groups.append(("Yesterday", yesterdayList)) }
            if !weekList.isEmpty { groups.append(("Previous 7 days", weekList)) }
            if !olderList.isEmpty { groups.append(("Older", olderList)) }

            let projectNames = Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            let next = ListSnapshot(
                canSearch: !chats.isEmpty,
                emptyLine: chats.isEmpty ? "No sessions yet" : nil,
                filteredCount: filtered.count,
                groups: groups,
                projectNames: projectNames
            )
            self.sessions = sessions
            self.sessionId = sessionId
            self.projects = projects
            self.query = query
            self.startOfToday = today
            self.cached = next
            return next
        }
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
            TextField("Search sessions", text: $query)
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searching)
                .onAppear { searching = true }
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                .accessibilityLabel("Clear text")
            }
            Button {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) { closeSearch() }
            } label: {
                Text("Cancel")
                    .font(MiloTheme.Text.small.weight(.medium))
                    .foregroundStyle(MiloTheme.accent)
            }
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .frame(height: 38)
        // The same material as the magnifier that asked for it: the field is the list's own
        // control while it is up, not a filled line laid under the switch.
        .glassEffect(.regular, in: Capsule())
        .padding(.horizontal, MiloTheme.Space.three)
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    @ViewBuilder private func chatListRows(_ snapshot: ListSnapshot) -> some View {
        if searched {
            Text(snapshot.filteredCount == 0 ? "No sessions found." : (snapshot.filteredCount == 1 ? "1 session found" : "\(snapshot.filteredCount) sessions found"))
                .font(MiloTheme.Text.meta.weight(.medium))
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.top, MiloTheme.Space.two)
        }
        ForEach(snapshot.groups, id: \.title) { group in
            Text(group.title)
                .font(MiloTheme.Text.small.weight(.medium))
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.top, MiloTheme.Space.three)
                .padding(.bottom, MiloTheme.Space.one)
            ForEach(group.sessions) { session in
                row(session, projectName: session.project.flatMap { snapshot.projectNames[$0] }) {
                    Task {
                        await model.resume(session.id)
                        onClose()
                    }
                }
            }
        }
    }

    private func row(_ session: SessionSummary, projectName: String?, opening: @escaping () -> Void) -> some View {
        SessionRow(
            session: session,
            renaming: $renaming,
            current: session.id == model.sessionId,
            projectName: projectName,
            onOpen: opening,
            onTraces: { onTraces(session) }
        )
        .equatable()
    }
}
