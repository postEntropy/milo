import SwiftUI

extension SessionSummary {
    /// What a row says under the name: how much has been said and when — the browser's
    /// own `sessionMeta`, on the phone. A session nobody has spoken in yet has no count
    /// to give, so it says only when it was made.
    var meta: String {
        let when = RelativeTime.when(updatedAt)
        guard messageCount > 0 else { return when }
        return "\(messageCount) \(messageCount == 1 ? "message" : "messages") · \(when)"
    }
}

/**
 The controls a session answers to, wherever they are offered: the press on its own row
 in the drawer, and the dots beside the new-session control in the session's own header.
 One declaration, so the two cannot drift — and the browser's own, in the browser's own
 order.
 */
@ViewBuilder
func sessionActions(
    onRename: @escaping () -> Void,
    onExport: @escaping () -> Void,
    onCopy: @escaping () -> Void,
    onClear: (() -> Void)? = nil,
    onDelete: @escaping () -> Void
) -> some View {
    menuItem("Rename", "pencil", action: onRename)
    menuItem("Export", "arrow.down.doc", action: onExport)
    menuItem("Copy ID", "doc.on.doc", action: onCopy)
    // Only the session this chat is in can be cleared: the daemon clears the session
    // the chat is bound to, and the transcript it empties is this one's.
    if let onClear {
        menuItem("Clear transcript", "eraser", action: onClear)
    }
    // A destructive line: the menu draws its words in the platform's own red, and the mark
    // beside them wears whatever tone the line is told — so it is told that same red, since
    // the accent it would otherwise take makes the trash the loudest thing on the row.
    Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
        .tint(Color(.systemRed))
}

/**
 Holding a session, wherever a list draws one: the press keeps the row, the row lifts into
 a card, and the actions are laid under it. One declaration, so the drawer and a project's
 own page offer the same four under the same press — and the card that rises is the same
 card.

 Two things this has to live with, both of them the platform's:

 - The card is drawn once, as it is lifted. So the session's last words cannot be read
   when the finger lands: they are read before it, as the row comes up (and again when the
   session moves) — a short, local read against the list the row is already in.
 - The long press has to reach the platform, which is why what this is attached to is not
   a `Button`: a `ButtonStyle` takes the press for its own animation, and the card is then
   never raised at all.
 */
extension View {
    func sessionMenu(_ session: SessionSummary, renaming: Binding<String?>) -> some View {
        modifier(SessionMenu(session: session, renaming: renaming))
    }
}

private struct SessionMenu: ViewModifier {
    let session: SessionSummary
    @Binding var renaming: String?

    /// Where the session left off. Nil until the read lands; the reason when it could not
    /// be made.
    @State private var peek: [PeekLine]?
    @State private var peekError: String?

    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            // Read as the row comes up, and read again whenever the session moves.
            .task(id: session.updatedAt) { await read() }
            .contextMenu {
                sessionActions(
                    onRename: { renaming = session.id },
                    onExport: { Task { await model.export(session.id) } },
                    onCopy: { model.copyId(session.id) },
                    onClear: session.id == model.sessionId ? { Task { await model.clear() } } : nil,
                    onDelete: { Task { await model.delete(session.id) } }
                )
            } preview: {
                SessionPeek(session: session, lines: peek, error: peekError)
            }
    }

    /// Where the session left off. A read that fails is kept as the reason: a card that
    /// went quiet about it would read as a session with nothing in it. A session nobody has
    /// said anything in is answered without asking the daemon at all.
    private func read() async {
        guard session.messageCount > 0 else {
            peek = []
            peekError = nil
            return
        }
        do {
            peek = try await model.peek(session.id)
            peekError = nil
        } catch {
            peek = []
            peekError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/**
 A session, held: what rises under the finger while its actions rest below it. The row it
 was lifted from is drawn in whatever surface that row sits on — clear in the drawer, a
 filled card on a project's page — so the lifted one is drawn here as a card of its own,
 and the peek is a card on both surfaces rather than floating words on one of them.

 It carries the session itself, not just its name: the last few things said, drawn the way
 the chat draws the two sides — the person on their own fill, Milo in prose — so a peek
 answers what a peek is asked, which is where this conversation left off.
 */
struct SessionPeek: View {
    let session: SessionSummary
    /// Where the session left off, oldest first. Nil until the read lands.
    let lines: [PeekLine]?
    /// Why there is nothing to draw, when the read could not be made.
    let error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.two) {
                    if session.running == true {
                        Circle().fill(MiloTheme.accent).frame(width: 7, height: 7)
                    }
                    Text(session.label)
                        .font(MiloTheme.Text.body.weight(.medium))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                }
                Text(session.meta)
                    .font(MiloTheme.Text.small.monospacedDigit())
                    .foregroundStyle(MiloTheme.muted)
            }

            if let error {
                Text(error)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.danger)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let lines {
                if lines.isEmpty {
                    Text("Nothing has been said in this one yet.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            said(line)
                        }
                    }
                }
            }
        }
        .padding(MiloTheme.Space.four)
        .frame(width: Self.width, alignment: .leading)
        .background(MiloTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }

    /// One thing said: the person's own words wear the fill their message wears in the
    /// chat, on the side of the card the chat puts them on, and Milo's are prose. The words
    /// arrive already cut to what a card holds; three lines each is what is left of that
    /// cut on a card this size.
    private func said(_ line: PeekLine) -> some View {
        Text(line.text)
            .font(MiloTheme.Text.base)
            .foregroundStyle(line.fromPerson ? MiloTheme.accentOn : MiloTheme.foreground)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, line.fromPerson ? MiloTheme.Space.three : 0)
            .padding(.vertical, line.fromPerson ? MiloTheme.Space.two : 0)
            .background(
                line.fromPerson ? MiloTheme.accent : .clear,
                in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg)
            )
            .frame(maxWidth: .infinity, alignment: line.fromPerson ? .trailing : .leading)
    }

    /// One width rather than the row's: the drawer's column and a project's page are two
    /// different widths, and a card that changed size with the screen it was opened on
    /// would be two cards. This is the width the drawer's own rows come to.
    private static let width: CGFloat = 276
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
