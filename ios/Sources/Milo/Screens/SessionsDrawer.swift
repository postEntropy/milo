import SwiftUI

/// The sessions, resting behind the chat. The chat is the layer that travels, so
/// the rounded edge and the shadow belong to it; this one is a plain column on
/// the sidebar's own tone, full-bleed to the screen's edges.
struct SessionsDrawer: View {
    let routinesSelected: Bool
    let tasksSelected: Bool
    let workSelected: Bool
    let onClose: () -> Void
    let onNewSession: () -> Void
    let onSettings: () -> Void
    let onRoutines: () -> Void
    let onTasks: () -> Void
    let onWork: () -> Void
    @Environment(AppModel.self) private var model
    /// The session being renamed, by id: the row's own press names one, and the alert
    /// the modifier presents does the rest.
    @State private var renaming: String?
    /// What is typed into the search field, narrowing the list to the rows that carry it.
    @State private var query = ""

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
    }

    private var column: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Milo")
                .font(.title.weight(.bold))
                .foregroundStyle(MiloTheme.foreground)
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.top, MiloTheme.Space.four)

            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                pageTab("Routines", symbol: "clock", selected: routinesSelected, action: onRoutines)
                pageTab("Task lists", symbol: "checklist", selected: tasksSelected, action: onTasks)
                pageTab("Work", symbol: "folder", selected: workSelected, action: onWork)
            }

            if chats.isEmpty {
                Text(model.sessions.isEmpty ? "No sessions yet" : "No chats yet")
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.muted)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.top, MiloTheme.Space.two)
            } else {
                searchField
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: MiloTheme.Space.one) {
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
                            row(session)
                        }
                    }
                }
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.bottom, Self.controlsClearance)
            }
        }
    }

    /// The tap target of each floating control, and the room the list keeps under them so
    /// the last session is not lost behind the glass. They sit side by side, so it is their
    /// height the list has to clear, not their width.
    private static let controlSpan: CGFloat = 44
    private static let controlsClearance = controlSpan + MiloTheme.Space.four + MiloTheme.Space.three

    /// Starting a session and setting one up, at the drawer's own end. New session states
    /// what it does in words — a disc with a mark on it would leave the mark to be read —
    /// and wears the accent as the glass's tint, in the tone the composer spends on the way
    /// to send; the way into the settings keeps the plain glass of a control that only goes
    /// somewhere, and the gear says that much on its own.
    private var controls: some View {
        HStack(spacing: MiloTheme.Space.three) {
            Button { onNewSession() } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 16, weight: .semibold))
                    Text("New session")
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

    /// A workspace page under the drawer's own name: routines and task lists are places you
    /// go to, not controls that start a session, so they sit above the list rather than
    /// among the controls at the foot. Drawn as the list's own row — the same box, the same
    /// tone, the same fill for the one showing — so it answers the finger the way a session
    /// does; what tells the two apart is the mark and the name, never the box.
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
        .padding(.horizontal, MiloTheme.Space.three)
        .accessibilityLabel(title)
    }

    /// What the search field narrows the list to: the words on the row, the preview and
    /// the id — the browser's own fields, so the same query finds the same rows on both.
    private var searched: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The sessions this drawer holds: the chats. A session working in a project belongs
    /// to that project's page in Work, where it is opened beside the folder it works in —
    /// listing it here as well would offer the same session under two different roofs.
    private var chats: [SessionSummary] {
        model.sessions.filter { $0.project == nil }
    }

    private var filtered: [SessionSummary] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty else { return chats }
        return chats.filter {
            "\($0.title ?? "") \($0.preview) \($0.id)".lowercased().contains(text)
        }
    }

    /// The search field, filled like every control here rather than outlined: a field on
    /// the drawer's own surface, with the mark the browser's own search carries.
    private var searchField: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Image(systemName: "magnifyingglass")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
            TextField("Search chats", text: $query)
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if searched {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .frame(height: 38)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .padding(.horizontal, MiloTheme.Space.three)
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

    /// A session: a tap opens it, a hold lifts it into its card. Not a `Button` — a
    /// `ButtonStyle` takes the press for its own animation, and the platform's long press
    /// then never reaches the row, so nothing is ever raised.
    private func row(_ session: SessionSummary) -> some View {
        let current = session.id == model.sessionId
        return HStack(spacing: MiloTheme.Space.two) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label)
                    .font(MiloTheme.Text.body)
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
            // A session running now, said with the accent the way the accent already
            // points: one dot at the row's own edge, no words.
            if session.running == true {
                Circle()
                    .fill(MiloTheme.accent)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel("Running")
            }
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.two)
        .background(
            current ? MiloTheme.surfaceRaised : .clear,
            in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
        )
        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .onTapGesture {
            // The card answers the tap, not the daemon: the drawer slides closed while
            // the binding is made, instead of holding still through a round trip and
            // moving only once it lands.
            onClose()
            Task { await model.resume(session.id) }
        }
        // A row that opens a session reads as a control, the way the button it used to be
        // did: a tap is not the only way to answer one.
        .accessibilityAddTraits(.isButton)
        .sessionMenu(session, renaming: $renaming)
    }
}
