import SwiftUI

/// The sessions, resting behind the chat. The chat is the layer that travels, so
/// the rounded edge and the shadow belong to it; this one is a plain column on
/// the sidebar's own tone, full-bleed to the screen's edges.
struct SessionsDrawer: View {
    let onClose: () -> Void
    let onSettings: () -> Void
    @Environment(AppModel.self) private var model
    @State private var renaming: SessionSummary?
    @State private var draftName = ""

    var body: some View {
        HStack(spacing: 0) {
            column
                .frame(width: 300, alignment: .leading)
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(MiloTheme.background.ignoresSafeArea())
        .alert("Rename session", isPresented: renameBinding) {
            TextField("Name", text: $draftName)
            Button("Save") {
                if let id = renaming?.id { Task { await model.rename(id, to: draftName) } }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }

    private var column: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack {
                Text("Sessions")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
                MiloIconButton(systemName: "square.and.pencil", size: 16, span: 36) {
                    Task {
                        await model.newSession()
                        onClose()
                    }
                }
                .accessibilityLabel("New session")
                MiloIconButton(systemName: "gearshape", size: 16, span: 36) { onSettings() }
                    .accessibilityLabel("Settings")
            }
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.top, MiloTheme.Space.four)

            if model.sessions.isEmpty {
                Text("No sessions yet")
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.muted)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.top, MiloTheme.Space.two)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: MiloTheme.Space.one) {
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
                .padding(.bottom, MiloTheme.Space.four)
            }
        }
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
                    sessions: model.sessions.filter { $0.updatedAt >= range.from && $0.updatedAt < range.to }
                )
            }
            .filter { !$0.sessions.isEmpty }
    }

    private func row(_ session: SessionSummary) -> some View {
        let current = session.id == model.sessionId
        return Button {
            Task {
                await model.resume(session.id)
                onClose()
            }
        } label: {
            HStack(spacing: MiloTheme.Space.two) {
                Text(session.label)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                Spacer(minLength: MiloTheme.Space.two)
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.three)
            .background(
                current ? MiloTheme.surface : .clear,
                in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
            )
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        }
        .buttonStyle(PressableStyle())

        .contextMenu {
            Button {
                draftName = session.title ?? ""
                renaming = session
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button(role: .destructive) {
                Task { await model.delete(session.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var renameBinding: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }
}
