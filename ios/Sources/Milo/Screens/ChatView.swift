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
    /// Whether the thread is at its end, read off the scroll itself. What the arrow
    /// above the composer answers to.
    @State private var atEnd = true
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
        // A swipe from the left edge opens the sessions and a swipe back closes them — the
        // gesture the platform's own sidebars answer to, and the reason it is the edge: a
        // code block scrolls sideways, and a drag that starts inside one is the block's to
        // answer. From anywhere, the box could never be read along its longest line. Only a
        // mostly horizontal drag counts, so scrolling the thread is never mistaken for it.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { drag in
                    let across = drag.translation.width
                    guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                    if !drawer, across > 60, drag.startLocation.x <= Self.edge {
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
    /// How far from the left edge a drag counts as pulling the sessions out. Wide enough
    /// for a thumb to find, narrow enough to leave the thread its own gestures.
    private static let edge: CGFloat = 28
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
        ScrollViewReader { proxy in
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
                    // The end of the thread, as something to be pointed at: where the arrow
                    // goes back to, and where a send takes the person.
                    Color.clear.frame(height: 1).id(Self.threadEnd)
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.top, MiloTheme.Space.four)
                // The thread sits close over the composer: the last line belongs to the
                // thing being typed, not a hand's width above it.
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .vertical)
            // Asked of the scroll box, the way the browser asks its own: the end is the
            // end within a hundred points, so the arrow does not appear while the last
            // line is still in sight.
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 120
            } action: { _, atEnd in
                self.atEnd = atEnd
            }
            // A send takes the person to the end of the thread: their own words are the
            // last thing said, and the answer is about to grow under them.
            .onChange(of: model.messages.last?.id) { _, _ in
                guard model.messages.last?.isUser == true else { return }
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(Self.threadEnd, anchor: .bottom) }
            }
            .safeAreaInset(edge: .top, spacing: 0) { topbar }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottom(proxy) }
        }
    }

    /// The end of the thread, as an id the scroll view answers to.
    private static let threadEnd = "thread-end"
    /// The way back to the end: the box the thumb finds, and how far it floats above the
    /// composer it rides over.
    private static let jumpSpan: CGFloat = 40

    /// Whether the way back to the end is offered: there is a thread to go back to, and the
    /// end of it is not in sight.
    private var showJump: Bool { !model.messages.isEmpty && !atEnd }

    /// The end of the thread, brought back into view rather than jumped to — the browser's
    /// own control, in the platform's own glass.
    ///
    /// It rides over the composer instead of standing above it in the column, and it stays
    /// on screen to fade rather than being taken off and put back: what the thread is
    /// scrolled in has to keep its height while a thumb is moving it, because the scroll's
    /// own bar reads how far along the thread is off exactly that height — a box that grows
    /// and shrinks as a control comes and goes is a bar that jumps under the finger.
    private func jumpToEnd(_ proxy: ScrollViewProxy) -> some View {
        Button {
            withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(Self.threadEnd, anchor: .bottom) }
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(MiloTheme.foreground)
                .frame(width: Self.jumpSpan, height: Self.jumpSpan)
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("Go to the latest")
        .opacity(showJump ? 1 : 0)
        .allowsHitTesting(showJump)
        .accessibilityHidden(!showJump)
        .animation(.smooth(duration: 0.22), value: showJump)
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
                .tint(MiloTheme.foreground)
                .accessibilityLabel("Sessions")

                Spacer(minLength: MiloTheme.Space.two)

                // Starting a new session and acting on this one: one surface holding both,
                // the way this platform pairs two controls that belong together. The
                // platform's glass button draws a surface of its own, so two of them side
                // by side are two surfaces however close they sit; the capsule is one, and
                // each half keeps the size the platform's own control would have had —
                // its 30pt glyph box with the house's 8pt around it. Both are offered only
                // where there is a session to leave.
                if !model.messages.isEmpty {
                    HStack(spacing: 0) {
                        Button { Task { await model.newSession() } } label: {
                            topGlyph("square.and.pencil")
                                .frame(width: 46, height: 46)
                        }
                        .accessibilityLabel("New session")

                        Menu {
                            sessionActions(
                                onRename: { renaming = model.sessionId },
                                onExport: { Task { await model.export(model.sessionId) } },
                                onDelete: { Task { await model.delete(model.sessionId) } }
                            )
                        } label: {
                            topGlyph("ellipsis")
                                .frame(width: 46, height: 46)
                        }
                        .accessibilityLabel("Session actions")
                    }
                    .foregroundStyle(MiloTheme.foreground)
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.interactive(), in: Capsule())
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
        .padding(.horizontal, MiloTheme.margin)
        .padding(.bottom, MiloTheme.Space.two)
    }

    /// The mark a glass control in the top bar wears: one size, so the row's buttons
    /// cannot come out at three different weights — and one tone, the foreground's own,
    /// so the bar's controls are not the accent the pointer is spent on.
    private func topGlyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(MiloTheme.foreground)
            .frame(width: 30, height: 30)
    }

    private func bottom(_ proxy: ScrollViewProxy) -> some View {
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
                // The way back to the end, floating over the composer's own edge. An
                // overlay draws and takes taps without taking room, so the column under the
                // thread is the same whether the arrow is up or not.
                .overlay(alignment: .top) {
                    jumpToEnd(proxy)
                        .offset(y: -(Self.jumpSpan + MiloTheme.Space.two))
                }
        }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    /// The heading, and the lines under it: what the screen is, then the ways in. The
    /// lines are the browser's own set — the last conversation and the ideas the model
    /// drew — drawn the way this platform lists a choice: an icon and its words on a
    /// plain row, no card and nothing drawn around it, so the accent stays on the
    /// pointer and not on the surface.
    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("What's on your mind?")
                .font(.title3.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
                .padding(.top, MiloTheme.Space.two)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(model.suggestions) { suggestion in
                    line(suggestion)
                }
            }
            .animation(.easeInOut(duration: 0.3), value: model.ideas)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One way in: its mark, its words, and what a press does — the prompt said as a
    /// message, or the session it names opened.
    ///
    /// The line is drawn a step off the heading's white: the mark and the words share
    /// one near-white grey, so the row reads as a quiet way in rather than as the answer.
    private func line(_ suggestion: Suggestion) -> some View {
        Button {
            press(suggestion)
        } label: {
            HStack(spacing: MiloTheme.Space.three) {
                Image(systemName: suggestion.symbol)
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(MiloTheme.foreground2)
                    .frame(width: 28, alignment: .center)
                Text(suggestion.title)
                    .font(MiloTheme.Text.body)
                    .foregroundStyle(MiloTheme.foreground2)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.vertical, MiloTheme.Space.three)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }

    private func press(_ suggestion: Suggestion) {
        switch suggestion.act {
        case .send(let prompt): model.send(prompt)
        case .resume(let id): Task { await model.resume(id) }
        }
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
                .padding(.horizontal, MiloTheme.Space.six + MiloTheme.Space.four)
            }

            // Centred against the field: the send control is shorter than a line of text,
            // so bottom-aligning it left the air above it and read as a bump at the top.
            HStack(alignment: .center, spacing: MiloTheme.Space.one) {
                // The model lives behind this, not on the bar: what belongs to the
                // message is the field and the way to send it.
                Menu {
                    menuItem("Model", "cpu") { openPicker() }
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
                    // The way to send becomes the way to stop — one control, as the
                    // browser draws it: the turn that is running is stopped by the same
                    // control that ran it, not by a second one standing beside it.
                    stopControl
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
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .padding(.top, MiloTheme.Space.one)
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// While a turn runs, the control stops it. What is typed meanwhile still has the
    /// two send intents — the browser offers them on Enter and Cmd+Enter; a phone has
    /// no keys, so they ride the long press this control already answers to. Stop stays
    /// the tap, so the way out of a turn is never behind a press-and-hold.
    @ViewBuilder
    private var stopControl: some View {
        if canSend {
            Menu {
                menuItem("Steer the running turn", "arrow.turn.down.right") {
                    submit(intent: .steer)
                }
                menuItem("Send after this turn", "text.append") {
                    submit(intent: .queue)
                }
            } label: {
                stopGlyph
            } primaryAction: {
                model.stop()
            }
            .accessibilityLabel("Stop")
        } else {
            Button(action: model.stop) { stopGlyph }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Stop")
        }
    }

    /// A quiet fill — the accent stays on the one thing to press when nothing runs.
    private var stopGlyph: some View {
        Image(systemName: "stop.fill")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(MiloTheme.foreground)
            .frame(width: 36, height: 36)
            .background(Circle().fill(MiloTheme.surface))
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

    /// The answer's parts as they are drawn: a run of consecutive calls is one chain,
    /// and everything else stands on its own. A turn's work arrives as those runs, so
    /// this is where the screen decides how much of it is worth its height.
    ///
    /// What a part draws decides whether it breaks the run: thinking is not on the screen
    /// — it is the line above the answer, and the whole of it behind that press — so a
    /// call either side of it is still one piece of work, and a chain of four does not
    /// come out as two with two strangers.
    private var drawn: [Drawn] {
        var out: [Drawn] = []
        for part in message.parts {
            switch part {
            case .reasoning, .other:
                continue
            case .tool(let call):
                if case .calls(let earlier)? = out.last {
                    out[out.count - 1] = .calls(earlier + [call])
                } else {
                    out.append(.calls([call]))
                }
            case .text, .todo, .ui:
                out.append(.one(part))
            }
        }
        return out
    }

    /// One part on its own, or the run of calls it belongs to.
    private enum Drawn {
        case one(WirePart)
        case calls([ToolMark])
    }

    var body: some View {
        if message.isUser {
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    if !message.prose.isEmpty {
                        Prose(text: message.prose, color: MiloTheme.accentOn)
                    }
                    // Guarded like the assistant side: an empty `Attachments` is still a
                    // child, and the stack's spacing would show up as a chin under the text.
                    if !message.attachments.isEmpty {
                        Attachments(items: message.attachments)
                    }
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.vertical, MiloTheme.Space.three)
                .background(MiloTheme.accent, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
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
                ForEach(Array(drawn.enumerated()), id: \.offset) { _, group in
                    switch group {
                    case .calls(let calls):
                        ToolChain(calls: calls)
                    case .one(let part):
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
        menuItem("Copy", "doc.on.doc") { UIPasteboard.general.string = message.prose }
        if let raw = message.raw {
            menuItem("Copy raw", "curlybraces") { UIPasteboard.general.string = raw }
        }
        if let tokens = message.tokens {
            menuItem("\(tokens.input) in · \(tokens.output) out", "cpu", disabled: true) {}
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
        HStack(spacing: 0) {
            control(copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = message.prose
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            }
            // SF's branch arrows each carry a triangle, and at this size the triangle is
            // the whole mark; the branch alone reads as the one thing it says.
            control("arrow.branch", label: "Fork session from here", disabled: model.busy) {
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
                menuItem("\(tokens.input) in · \(tokens.output) out", "cpu", disabled: true) {}
            }
            if let raw = message.raw {
                menuItem("Copy raw", "curlybraces") { UIPasteboard.general.string = raw }
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
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(MiloTheme.muted)
            .frame(width: 32, height: 28)
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

/// One drawn part below an answer. A call is not one of them: every call belongs to the
/// chain it arrived in, and the chain is what knows how much of it to draw.
struct PartView: View {
    let part: WirePart
    @Environment(AppModel.self) private var model

    var body: some View {
        switch part {
        case .text(let text):
            Prose(text: text)
        case .todo(let items):
            TodoRow(items: items)
        case .ui(let widget, _):
            // A widget's button speaks the same way the composer does, so the message
            // it builds lands in the conversation as an ordinary turn.
            GenUiView(widget: widget) { model.send($0) }
        case .tool, .reasoning, .other:
            EmptyView()
        }
    }
}

/**
 A run of calls in one answer. One call is a line; two or more are a chain — the work a
 turn did, which in a long one fills the screen and answers a question nobody asked.
 Folded it is one quiet line, open it is the list, and the press is what decides.

 The chain is the phone's own: the browser draws every link of it. Its starting state is
 the setting in Settings, and a chain the person has touched keeps what they chose.
 */
struct ToolChain: View {
    let calls: [ToolMark]
    @AppStorage("tools-folded") private var foldedByDefault = false
    /// Nothing until the person touches it. That is what keeps the setting a starting
    /// point rather than a rule: a chain read open stays open when the setting changes
    /// under it — and, folded, it says out loud what is still running in it.
    @State private var chosen: Bool?

    private var folded: Bool { chosen ?? (foldedByDefault && calls.count > 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            if let only = calls.first, calls.count == 1 {
                ToolRow(tool: only)
            } else {
                Button {
                    withAnimation(.easeInOut(duration: 0.22)) { chosen = !folded }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                            .rotationEffect(.degrees(folded ? 0 : 90))
                        summary
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel(folded ? "Show \(calls.count) tool calls" : "Hide tool calls")

                if !folded {
                    ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                        ToolRow(tool: call)
                    }
                }
            }
        }
    }

    /// What a folded chain says about itself: how many calls it holds, and — because a
    /// folded thing may not hide a failure or a wait — the light travelling along the
    /// words while one of them runs, and how many of them failed.
    private var summary: some View {
        let running = calls.contains { $0.state == "running" }
        let failed = calls.filter { $0.state == "failed" }.count
        return HStack(spacing: MiloTheme.Space.two) {
            if running {
                Glare(text: "\(calls.count) tool calls")
            } else {
                Text("\(calls.count) tool calls")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
            }
            if failed > 0 {
                // How many of them failed, not that they did: a chain of four with one
                // failure said "4 tool calls failed", which reads as all four.
                Text(failed == calls.count ? "all failed" : "\(failed) failed")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.danger)
            }
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
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(state)
            // A call in flight is one swept line — the name and its value as the server
            // drew them, lit together, which is the browser's own treatment. Settled, the
            // whole line is drawn in the quiet tone, the mark being what carries the
            // state: it sits in the answer's own text, and the grey is what sets it
            // apart from it.
            if running {
                Glare(text: line, font: MiloTheme.Text.body)
                    .lineLimit(1)
            } else {
                Text(name)
                    .font(MiloTheme.Text.body)
                    .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !value.isEmpty {
                    Text(value)
                        .font(MiloTheme.Text.body)
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
                    Image(systemName: symbol(item.status))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(mark(item.status))
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

    private func symbol(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"
        default: return "circle"
        }
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
                // Filled, not glass: the card is already a surface, and glass over glass
                // loses the edge of both — the same solid pair the browser draws.
                MiloWideButton(title: "Deny") { model.answerPermission(allowed: false) }
                MiloWideButton(title: "Allow", primary: true) { model.answerPermission(allowed: true) }
            }
            // The daemon lets a prompt expire; the countdown says how long it holds.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Label(remaining(at: context.date), systemImage: "clock")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            }
        }
        .padding(MiloTheme.Space.four)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .padding(.horizontal, MiloTheme.Space.three)
    }

    private func remaining(at now: Date) -> String {
        let left = max(0, Int((pending.expiresAt / 1000 - now.timeIntervalSince1970).rounded(.up)))
        return String(format: "%d:%02d", left / 60, left % 60)
    }
}
