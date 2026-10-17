import SwiftUI

/**
 The controls a session answers to, wherever they are offered: the press on its own row
 in the drawer, and the dots beside the new-session control in the session's own header.
 One declaration, so the two cannot drift — and the browser's own four, in the browser's
 own order.
 */
@ViewBuilder
func sessionActions(
    onRename: @escaping () -> Void,
    onExport: @escaping () -> Void,
    onCopy: @escaping () -> Void,
    onDelete: @escaping () -> Void
) -> some View {
    menuItem("Rename", "pencil", action: onRename)
    menuItem("Export", "arrow.down.doc", action: onExport)
    menuItem("Copy ID", "doc.on.doc", action: onCopy)
    // A destructive line: the menu draws its words in the platform's own red, and the mark
    // beside them wears whatever tone the line is told — so it is told that same red, since
    // the accent it would otherwise take makes the trash the loudest thing on the row.
    Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
        .tint(Color(.systemRed))
}

/**
 The way back to the sessions, wherever there is one: the drawer belongs to the chat, but
 every screen the card can show reaches it through this same control, so the mark, the
 material and the words cannot drift between them.
 */
struct SessionsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(MiloTheme.foreground)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .controlSize(.regular)
        .tint(MiloTheme.foreground)
        .accessibilityLabel("Sessions")
    }
}

/**
 How the socket's state is worn on a screen's own line: the mark and the tone, read off the
 state so the words and what they are drawn in cannot come apart. A wait — reaching for the
 daemon, reconnecting to it — is the warning a transient thing wears and keeps the app's
 sweeping indicator; a state the daemon itself gave, a refusal or a frame this app cannot
 read, is the danger that needs the person's hand and is drawn settled.
 */
extension MiloClient.State {
    var tone: Color {
        switch self {
        case .refused, .unreadable: return MiloTheme.danger
        case .connecting, .offline: return MiloTheme.warning
        case .online, .idle: return MiloTheme.muted
        }
    }

    /// One mark for the whole wait: the socket still being worked at. It does not change as
    /// the outage passes between connecting and offline, so the pill cannot flicker a mark
    /// while the thumb is only watching it retry.
    var symbol: String {
        switch self {
        case .refused, .unreadable: return "exclamationmark.triangle.fill"
        default: return "arrow.triangle.2.circlepath"
        }
    }

    /// Whether the socket is still working at it — what decides between the app's own sweep
    /// and a line that is simply there to read.
    var waiting: Bool {
        switch self {
        case .connecting, .offline: return true
        default: return false
        }
    }
}

/**
 What a screen says about the socket, worn the way every control here is made — the
 platform's own glass, tinted with the tone of the state — so the line reads as part of the
 surface rather than a bare sentence dropped over the page. A wait keeps the app's own sweep
 travelling its words, which is what says the app is still trying; an answer the daemon gave
 is drawn settled, because it is a thing to read rather than a thing to wait on. Held between
 the bar's own margins and hugging its words: a two-word line is a small pill, and a long
 refusal grows and wraps it.
 */
struct ConnectionPill: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let state = model.connectionLine {
            let tone = model.connection.tone
            let content = HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: model.connection.symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tone)
                if model.connection.waiting {
                    Glare(text: state, font: MiloTheme.Text.small, tone: tone)
                } else {
                    Text(state)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(tone)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.two)
            .glassEffect(.regular.tint(tone.opacity(0.28)), in: Capsule())

            HStack(spacing: 0) {
                Spacer(minLength: 0)
                content
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .transition(.opacity)
        }
    }
}

/**
 Renaming, wherever it is asked for: one alert, one starting point, one call. Presented
 with the id of the session to rename, nil for none, so a surface only has to name one.
 */
struct SessionRename: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var id: String?
    @State private var draft = ""

    func body(content: Content) -> some View {
        content
            .alert("Rename session", isPresented: showing) {
                TextField("Name", text: $draft)
                Button("Save") {
                    if let id { Task { await model.rename(id, to: draft) } }
                    id = nil
                }
                Button("Cancel", role: .cancel) { id = nil }
            }
            // Seeded as the alert opens: the words the session already goes by, or the
            // ones it opened with — the browser's own starting point, and never the
            // label a row shows, which stands in words for a session that has none. A
            // session the list has not caught up with leaves the field empty rather
            // than holding what the last rename left in it.
            .onChange(of: id) { _, named in
                guard let named else { return }
                let session = model.sessions.first { $0.id == named }
                draft = session?.title ?? session?.preview ?? ""
            }
    }

    private var showing: Binding<Bool> {
        Binding(get: { id != nil }, set: { if !$0 { id = nil } })
    }
}

extension View {
    /// Lets a surface offer renaming by naming the session, and hold nothing else.
    func sessionRename(_ id: Binding<String?>) -> some View {
        modifier(SessionRename(id: id))
    }
}
