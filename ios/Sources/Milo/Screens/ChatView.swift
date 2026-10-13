import SwiftUI

/// The session on screen: a floating top bar, the thread, and a floating
/// composer pinned above the keyboard. No rules between the regions — each is
/// carried by its own surface and spacing.
struct ChatView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var drawer = false
    @State private var picker = false
    @State private var settings = false
    /// The session being renamed from this screen — the dots in the top bar name it,
    /// and the shared alert does the rest.
    @State private var renaming: String?
    @FocusState private var composing: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            // Behind: the sessions. The chat sits on top and slides aside to show
            // them, as the ChatGPT app does. The sessions are only drawn while
            // they are open — and until the chat has slid back over them — so
            // nothing of the sidebar can show through the chat at rest.
            SessionsDrawer(onClose: { drawer = false }, onSettings: {
                drawer = false
                settings = true
            })
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .opacity(drawer ? 1 : 0)
                .animation(drawer ? nil : .linear(duration: 0.01).delay(Self.drawerDuration), value: drawer)
                .allowsHitTesting(drawer)
                .accessibilityHidden(!drawer)

            chat
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The card is the background: it runs under the status bar and the
                // home indicator, and carries the rounded edge and the shadow while
                // the content stays inside the safe area.
                .background {
                    UnevenRoundedRectangle(
                        topLeadingRadius: drawer ? 28 : 0,
                        bottomLeadingRadius: drawer ? 28 : 0
                    )
                    .fill(MiloTheme.background)
                    .shadow(color: .black.opacity(drawer ? 0.18 : 0), radius: 14, x: -2, y: 0)
                    .ignoresSafeArea()
                }
                .offset(x: drawer ? Self.drawerWidth : 0)
                // While the sessions are open, the chat is a lid: a tap on it closes
                // them instead of reaching what is underneath. The lid starts where
                // the chat does — its frame still spans the whole screen, because an
                // offset moves what is drawn and not what the view occupies, and a lid
                // over the whole frame swallowed the taps on the sessions below it, so
                // choosing one closed the list and changed nothing.
                .overlay {
                    if drawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .padding(.leading, Self.drawerWidth)
                            .onTapGesture { drawer = false }
                    }
                }

        }
        .animation(.smooth(duration: Self.drawerDuration), value: drawer)
        .sensoryFeedback(.impact(weight: .light), trigger: drawer)
        // The two edges of an answer: a firmer tap when the daemon begins to
        // speak, a softer one when it lands. `busy` cannot be the trigger — it
        // goes up on the send, before the daemon has said anything, so the tap
        // would land on the person's own thumb.
        .sensoryFeedback(.impact(weight: .medium, intensity: 0.6), trigger: model.answerBegan)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.5), trigger: model.answerEnded)
        // A swipe right from anywhere opens the sessions and a swipe back closes them — the
        // gesture the platform's own sidebars answer to. Only a mostly horizontal
        // drag counts, so scrolling the thread is never mistaken for it.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { drag in
                    let across = drag.translation.width
                    guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                    if !drawer, across > 60 {
                        openDrawer()
                    } else if drawer, across < -60 {
                        drawer = false
                    }
                }
        )
        .task {
            composing = true
            await model.begin(at: account)
            await model.refreshSessions()
        }
        .sheet(isPresented: $picker) { ModelPickerSheet() }
        .sheet(isPresented: $settings) { SettingsView(account: account) }
        .sessionRename($renaming)
    }

    private static let drawerWidth: CGFloat = 300
    /// The slide of the chat uncovering the sessions. One value for the move and for
    /// the moment the list under it comes back, so the two cannot drift apart.
    private static let drawerDuration: Double = 0.28

    /// Which turn each message belongs to: the person's own line opens one, so a
    /// message's place is how many of them came before it. What a fork cuts at.
    private var turns: [UUID: Int] {
        var turns: [UUID: Int] = [:]
        var turn = 0
        for message in model.messages {
            if message.isUser { turn += 1 }
            turns[message.id] = turn
        }
        return turns
    }

    /// What asking again would redo: the last answer, with the words that asked for it
    /// and the turn before them. Offered only when nothing is running — a turn in
    /// flight is not asked again, the browser's own rule.
    private var regenerate: (message: UUID, prompt: String, upToTurn: Int)? {
        guard !model.busy else { return nil }
        var answer: AppModel.Message?
        var asked: AppModel.Message?
        for message in model.messages {
            if message.isUser { asked = message; continue }
            if !message.streaming, !message.prose.isEmpty { answer = message }
        }
        guard let answer, let asked, let turn = turns[asked.id] else { return nil }
        return (answer.id, asked.prose, turn - 1)
    }

    /// The offer, on the one message it belongs to.
    private func regeneration(for message: AppModel.Message) -> (prompt: String, upToTurn: Int)? {
        guard let offer = regenerate, offer.message == message.id else { return nil }
        return (offer.prompt, offer.upToTurn)
    }

    /// Opening the sessions is leaving the thread: the keys go down with it rather
    /// than sitting under a list that has nothing to type into.
    private func openDrawer() {
        composing = false
        drawer = true
    }

    private var chat: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if model.messages.isEmpty { WelcomeView() }
                ForEach(model.messages) { message in
                    MessageRow(
                        message: message,
                        turn: turns[message.id] ?? 1,
                        regenerate: regeneration(for: message)
                    )
                }
            }
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.vertical, MiloTheme.Space.four)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .safeAreaInset(edge: .top, spacing: 0) { topbar }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottom }

    }

    private var topbar: some View {
        VStack(spacing: MiloTheme.Space.one) {
            HStack(spacing: MiloTheme.Space.three) {
                // The platform's own glass button: it takes the tap itself, so the
                // swipe on the screen cannot swallow it.
                Button { openDrawer() } label: {
                    topGlyph("line.3.horizontal")
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .controlSize(.regular)
                .accessibilityLabel("Sessions")

                Spacer(minLength: MiloTheme.Space.two)

                // Starting a new session and acting on this one: one pair, glued, the
                // way the platform pairs two controls that belong together. Both are
                // offered only where there is a session to leave.
                if !model.messages.isEmpty {
                    HStack(spacing: MiloTheme.Space.one) {
                        Button { Task { await model.newSession() } } label: {
                            topGlyph("square.and.pencil")
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .controlSize(.regular)
                        .accessibilityLabel("New session")

                        Menu {
                            sessionActions(
                                onRename: { renaming = model.sessionId },
                                onExport: { Task { await model.export(model.sessionId) } },
                                onDelete: { Task { await model.delete(model.sessionId) } }
                            )
                        } label: {
                            topGlyph("ellipsis")
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .controlSize(.regular)
                        .accessibilityLabel("Session actions")
                    }
                }
            }
            .overlay {
                if let title = model.title {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.horizontal, 64)
                }
            }
            if let state = model.connectionLine {
                Text(state)
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.danger)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.bottom, MiloTheme.Space.two)
    }

    /// The mark a glass control in the top bar wears: one size, so the row's buttons
    /// cannot come out at three different weights.
    private func topGlyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 20, weight: .semibold))
            .frame(width: 30, height: 30)
    }

    private var bottom: some View {
        VStack(spacing: MiloTheme.Space.two) {
            if let note = model.note {
                Text(note.text)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(note.failed ? MiloTheme.danger : MiloTheme.foreground2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, MiloTheme.Space.five)
            }
            if let pending = model.pending {
                PermissionBar(pending: pending)
            }
            Composer(draft: $draft, focused: $composing, openPicker: { picker = true })
        }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text("What's on your mind?")
                .font(.title3.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Text("This is the same session the browser and the terminal see.")
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, MiloTheme.Space.six)
    }
}

/// The composer is a filled capsule that floats and stays put: the field grows
/// with what is typed, on a single row between the model menu and the way to send.
struct Composer: View {
    @Binding var draft: String
    @FocusState.Binding var focused: Bool
    let openPicker: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: MiloTheme.Space.two) {
            if model.queued > 0 {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "clock.arrow.circlepath")
                    Text(model.queued == 1 ? "1 message queued" : "\(model.queued) messages queued")
                    Spacer(minLength: 0)
                }
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.five)
            }

            // Centred against the field: the send control is shorter than a line of text,
            // so bottom-aligning it left the air above it and read as a bump at the top.
            HStack(alignment: .center, spacing: MiloTheme.Space.one) {
                // The model lives behind this, not on the bar: what belongs to the
                // message is the field and the way to send it.
                Menu {
                    Button { openPicker() } label: { menuLine("Model", "cpu") }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .frame(width: 40, height: 40)
                        .contentShape(Circle())
                }
                .accessibilityLabel("More")

                TextField("Ask Milo anything", text: $draft, axis: .vertical)
                    .lineLimit(1...8)
                    .focused($focused)
                    .font(.body)
                    .foregroundStyle(MiloTheme.foreground)
                    .padding(.vertical, MiloTheme.Space.two + 2)

                // The same span as the `+` opposite it, with no padding of its own: two
                // controls on one row line up because they are the same height, not
                // because each was nudged to look like the other.
                if model.busy {
                    // Stop is its own control while a turn runs, so the way to send is
                    // still there: the message queues behind this turn, and a long press
                    // hands it to the turn now as a steer.
                    MiloIconButton(systemName: "stop.fill", size: 16, span: 36, primary: true, action: model.stop)
                        .accessibilityLabel("Stop")
                    sendControl
                } else {
                    MiloIconButton(
                        systemName: "paperplane.fill",
                        size: 16,
                        span: 36,
                        primary: true,
                        disabled: !canSend,
                        action: { submit() }
                    )
                    .accessibilityLabel("Send")
                }
            }
            .padding(.horizontal, MiloTheme.Space.two)
            // A little air above and below the row, so the send control does not read
            // as the composer's whole height — the capsule stands taller than what it
            // holds.
            .padding(.vertical, MiloTheme.Space.one)
            .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26))
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.two)
            .padding(.top, MiloTheme.Space.two)
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// While a turn runs, the send control queues by the tap and steers on the long
    /// press — the two intents the browser offers on Enter and Cmd+Enter.
    private var sendControl: some View {
        Menu {
            Button { submit(intent: .steer) } label: {
                Label("Steer the running turn", systemImage: "arrow.turn.down.right")
            }
        } label: {
            Image(systemName: "paperplane.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(MiloTheme.accentOn)
                .frame(width: 36, height: 36)
                .background(Circle().fill(MiloTheme.accent))
        } primaryAction: {
            submit(intent: .queue)
        }
        .disabled(!canSend)
        .opacity(canSend ? 1 : 0.35)
        .accessibilityLabel("Send")
    }

    private func submit(intent: ClientFrame.Intent = .queue) {
        guard canSend else { return }
        model.send(draft, intent: intent)
        draft = ""
        // The next message is typed where the last one was, not on the button.
        focused = true
    }
}

struct MessageRow: View {
    let message: AppModel.Message
    /// Which turn this message belongs to — what a fork cuts at.
    let turn: Int
    /// The words asking again would send, on the one answer it belongs to.
    let regenerate: (prompt: String, upToTurn: Int)?
    @State private var showReasoning = false

    var body: some View {
        if message.isUser {
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    if !message.prose.isEmpty {
                        Prose(text: message.prose)
                    }
                    // Guarded like the assistant side: an empty `Attachments` is still a
                    // child, and the stack's spacing would show up as a chin under the text.
                    if !message.attachments.isEmpty {
                        Attachments(items: message.attachments)
                    }
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.vertical, MiloTheme.Space.three)
                .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            }
            .contextMenu { menu }
        } else {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                if let thought = message.thought {
                    Button {
                        withAnimation(.easeInOut(duration: 0.22)) { showReasoning.toggle() }
                    } label: {
                        Text("Thought for \(Int(thought.rounded()))s")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                if showReasoning {
                    ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                        if case .reasoning(let text) = part {
                            Text(text)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                                .textSelection(.enabled)
                        }
                    }
                }
                ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                    switch part {
                    case .reasoning:
                        EmptyView()
                    default:
                        PartView(part: part)
                    }
                }
                if !message.attachments.isEmpty {
                    Attachments(items: message.attachments)
                }
                if message.streaming, !message.parts.contains(where: { part in
                    if case .text = part { return true }
                    return false
                }) {
                    WaitLine()
                }
                if let status = message.status {
                    Text(status)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                // The controls the browser draws under an answer. A turn still being
                // written has nothing to act on yet, and a message with no words has
                // nothing to copy.
                if !message.streaming, !message.prose.isEmpty {
                    MessageToolbar(message: message, turn: turn, regenerate: regenerate)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// What can be done with the person's own message, behind the press: its words,
    /// and — when the turn is more than prose — the turn copied whole, where the tool
    /// arguments and results the drawn parts leave out still live. The answer's own
    /// controls stand under it instead, so nothing here is said twice.
    @ViewBuilder
    private var menu: some View {
        Button {
            UIPasteboard.general.string = message.prose
        } label: {
            menuLine("Copy", "doc.on.doc")
        }
        if let raw = message.raw {
            Button {
                UIPasteboard.general.string = raw
            } label: {
                menuLine("Copy raw", "curlybraces")
            }
        }
        if let tokens = message.tokens {
            Button {} label: {
                menuLine("\(tokens.input) in · \(tokens.output) out", "cpu")
            }
            .disabled(true)
        }
    }
}

/// The controls under a finished answer, the four the browser draws there: the words
/// copied, the session forked from this turn, the answer asked again, and — behind the
/// dots — what the turn cost and the turn copied whole.
///
/// The glyph and nothing around it, which is the same control the page draws: with no
/// pointer to hover with, a phone leaves to the press what the browser saves for the
/// hover. The cost and the raw copy are not repeated beside it — the browser keeps
/// those behind the dots too.
struct MessageToolbar: View {
    let message: AppModel.Message
    /// Which turn this answer belongs to, and what asking again would send.
    let turn: Int
    let regenerate: (prompt: String, upToTurn: Int)?
    @Environment(AppModel.self) private var model
    @State private var copied = false

    var body: some View {
        // The browser's own rhythm: the controls sit as close as their own boxes allow,
        // and the box around a mark is what keeps them apart. Nothing between them but
        // the height of the row.
        HStack(spacing: MiloTheme.Space.one) {
            control(copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = message.prose
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            }
            control("arrow.trianglehead.branch", label: "Fork session from here", disabled: model.busy) {
                Task { await model.fork(from: turn) }
            }
            if let regenerate {
                control("arrow.clockwise", label: "Ask this again", disabled: model.busy) {
                    Task { await model.regenerate(prompt: regenerate.prompt, upToTurn: regenerate.upToTurn) }
                }
            }
            // Only where it holds something: an answer read back from the transcript
            // carries neither its cost nor its raw copy, and dots over an empty menu
            // are a control that promises what it cannot do.
            if message.tokens != nil || message.raw != nil {
                more
            }
        }
    }

    /// What the dots hold: what the answer cost, and the turn as it was said — the
    /// model's words, its thinking and every call with its arguments and result.
    private var more: some View {
        Menu {
            if let tokens = message.tokens {
                Button {} label: {
                    menuLine("\(tokens.input) in · \(tokens.output) out", "cpu")
                }
                .disabled(true)
            }
            if let raw = message.raw {
                Button {
                    UIPasteboard.general.string = raw
                } label: {
                    menuLine("Copy raw", "curlybraces")
                }
            }
        } label: {
            glyph("ellipsis")
        }
        .accessibilityLabel("More")
    }

    private func control(
        _ name: String,
        label: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) { glyph(name) }
            .buttonStyle(PressableStyle())
            .disabled(disabled)
            .opacity(disabled ? 0.35 : 1)
            .accessibilityLabel(label)
    }

    /// The mark itself, in the box a finger needs — the shape every one of these
    /// controls shares, so the row lines up whatever the glyph is.
    private func glyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(MiloTheme.muted)
            .frame(width: 36, height: 28)
            .contentShape(Rectangle())
    }
}

/// The files delivered into this conversation. A picture shows itself; anything else is
/// a row to open. The bytes are fetched from the daemon behind the attachment's id, with
/// the token in the query because an image loader sends no header — the same request the
/// browser makes.
struct Attachments: View {
    let items: [FrameAttachment]
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            ForEach(items) { item in
                if let url = model.attachmentURL(item.id) {
                    if item.image {
                        AsyncImage(url: url) { image in
                            image.resizable().scaledToFit()
                        } placeholder: {
                            RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                                .fill(MiloTheme.surface)
                                .frame(height: 160)
                        }
                        .frame(maxWidth: 280, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                    } else {
                        Link(destination: url) {
                            HStack(spacing: MiloTheme.Space.two) {
                                Image(systemName: "doc")
                                Text(item.name).lineLimit(1)
                                Spacer(minLength: MiloTheme.Space.two)
                                Text(bytes(item.size))
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                            }
                            .font(MiloTheme.Text.base)
                            .foregroundStyle(MiloTheme.foreground)
                            .padding(MiloTheme.Space.three)
                            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                        }
                    }
                }
            }
        }
    }

    private func bytes(_ count: Int) -> String {
        if count < 1024 { return "\(count) B" }
        if count < 1024 * 1024 { return "\(Int((Double(count) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(count) / (1024 * 1024))
    }
}

struct PartView: View {
    let part: WirePart
    @Environment(AppModel.self) private var model

    var body: some View {
        switch part {
        case .text(let text):
            Prose(text: text)
        case .tool(let tool):
            ToolRow(tool: tool)
        case .todo(let items):
            TodoRow(items: items)
        case .ui(let widget, _):
            // A widget's button speaks the same way the composer does, so the message
            // it builds lands in the conversation as an ordinary turn.
            GenUiView(widget: widget) { model.send($0) }
        case .reasoning, .other:
            EmptyView()
        }
    }
}

/// One tool call: the tool's mark says what it was and carries the state, the name
/// carries the colour and the one value worth showing stays quiet beside it.
struct ToolRow: View {
    let tool: ToolMark

    var body: some View {
        HStack(alignment: .center, spacing: MiloTheme.Space.two) {
            // The mark is the state: quiet at rest, accent for the call running now, red
            // on a failure — and the word beside it says the failure for whoever cannot
            // see the colour.
            Image(systemName: ToolIcons.symbol(tool.name))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(state)
            // A call in flight is one swept line — the name and its value as the server
            // drew them, lit together, which is the browser's own treatment. Settled, the
            // name stands loud and the value stays quiet beside it.
            if running {
                Glare(text: line, font: MiloTheme.Text.monoSmall)
                    .lineLimit(1)
            } else {
                Text(name)
                    .font(MiloTheme.Text.monoSmall)
                    .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !value.isEmpty {
                    Text(value)
                        .font(MiloTheme.Text.monoSmall)
                        .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if failed {
                Text("failed").font(MiloTheme.Text.meta).foregroundStyle(MiloTheme.danger)
            }
        }
    }

    /// The whole line, for the sweep to travel along: the name and its value in one
    /// string, as the server drew it.
    private var line: String { tool.text.isEmpty ? tool.name : tool.text }

    /// The line the server drew is the name and its value in one string; splitting on
    /// the name is what lets the name be loud and the value quiet. Where the line does
    /// not begin with the raw name — an MCP tool's display name — the whole of it is the
    /// name, the honest reading rather than a guess at where the value starts.
    private var name: String {
        if tool.text.isEmpty { return tool.name }
        return tool.text.hasPrefix(tool.name) ? tool.name : tool.text
    }

    private var value: String {
        guard tool.text.hasPrefix(tool.name) else { return "" }
        return String(tool.text.dropFirst(tool.name.count)).trimmingCharacters(in: .whitespaces)
    }

    private var failed: Bool { tool.state == "failed" }

    private var running: Bool { tool.state == "running" }

    private var state: Color {
        switch tool.state {
        case "running": return MiloTheme.accent
        case "failed": return MiloTheme.danger
        default: return MiloTheme.muted
        }
    }
}

struct TodoRow: View {
    let items: [TodoItem]

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                    Text(item.mark).font(MiloTheme.Text.mono).foregroundStyle(mark(item.status))
                    Text(item.content)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(item.status == "completed" ? MiloTheme.muted : MiloTheme.foreground2)
                        .strikethrough(item.status == "completed", color: MiloTheme.muted)
                }
            }
        }
        .padding(MiloTheme.Space.three)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
    }

    private func mark(_ status: String) -> Color {
        switch status {
        case "completed": return MiloTheme.success
        case "in_progress": return MiloTheme.accent
        default: return MiloTheme.muted
        }
    }
}

/// The confirmation a tool call needs, waiting where the reply would land.
struct PermissionBar: View {
    let pending: (id: String, request: PermissionRequest, expiresAt: Double)
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text(pending.request.summary)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.foreground2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: MiloTheme.Space.three) {
                Button { model.answerPermission(allowed: false) } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .controlSize(.large)

                Button { model.answerPermission(allowed: true) } label: {
                    Text("Allow").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
            }
            // The daemon lets a prompt expire; the countdown says how long it holds.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Label(remaining(at: context.date), systemImage: "clock")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            }
        }
        .padding(MiloTheme.Space.four)
        .glassEffect(in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .padding(.horizontal, MiloTheme.Space.three)
    }

    private func remaining(at now: Date) -> String {
        let left = max(0, Int((pending.expiresAt / 1000 - now.timeIntervalSince1970).rounded(.up)))
        return String(format: "%d:%02d", left / 60, left % 60)
    }
}
