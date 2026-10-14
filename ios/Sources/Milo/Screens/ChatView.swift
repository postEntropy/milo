import SwiftUI

/// The frames, in the window's own space, of every box in the thread that scrolls sideways
/// on its own — a code block, a table. A drag that begins inside one belongs to the box,
/// not to the sessions drawer.
struct ScrollBoxKey: PreferenceKey {
    static var defaultValue: [CGRect] { [] }
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) {
        value.append(contentsOf: nextValue())
    }
}

/// Where those frames are kept: a plain reference, so a scroll that moves the boxes writes
/// them without re-rendering the screen, which reads them only when a drag has ended.
final class ScrollBoxes {
    var frames: [CGRect] = []
}

/// The panel a composer control has raised: what belongs to the message being written, or
/// what a running turn answers to. One at a time, and never in place of the composer.
enum ComposerMenu: Equatable {
    case actions
    case running
}

/// The session on screen: a floating top bar, the thread, and a floating
/// composer pinned above the keyboard. No rules between the regions — each is
/// carried by its own surface and spacing.
struct ChatView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    /// The words picked out of an answer, held until the reply is sent — the phone's half
    /// of the strip the browser keeps above its field.
    @State private var quote: String?
    /// A message being edited: the turn just before it, which the session is forked at so
    /// the edited words replace it rather than stacking a second copy on top.
    @State private var editing: Int?
    @State private var drawer = false
    @State private var picker = false
    @State private var settings = false
    /// The composer's panel, when one is open — raised by the `+` or by a long press on the
    /// send control, drawn over the composer, dismissed by a tap anywhere but itself.
    @State private var menu: ComposerMenu?
    /// How tall the composer came out, so the panel opens above it instead of through it.
    /// Read off the composer itself: it grows with the draft and with every strip above the
    /// field, so no constant would place the panel right.
    @State private var composerHeight: CGFloat = 0
    @State private var liveActivity = MiloLiveActivityController()
    /// The session being renamed from this screen — the dots in the top bar name it,
    /// and the shared alert does the rest.
    @State private var renaming: String?
    /// Whether the thread is at its end, read off the scroll itself. What the arrow
    /// above the composer answers to.
    @State private var atEnd = true
    /// The boxes in the thread that scroll sideways on their own — a code block, a table.
    /// Their frames ride up as a preference so a drag can be told where it began; held in
    /// a plain reference, so a scroll that moves them does not re-render the screen.
    @State private var boxes = ScrollBoxes()
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
                    .shadow(color: drawer ? MiloTheme.seamShadow : .clear, radius: 14, x: -2, y: 0)
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

            // The panel a composer control raised, and the layer that puts it away: a tap
            // anywhere but the panel closes it, the way the platform's own menu answers a tap
            // outside. That layer is under the panel and over everything else, so the first
            // touch after opening is spent closing rather than reaching the thread or the
            // field behind it.
            if let open = menu {
                let alignment: Alignment = open == .running ? .bottomTrailing : .bottomLeading
                let anchor: UnitPoint = open == .running ? .bottomTrailing : .bottomLeading

                Color.clear
                    .contentShape(Rectangle())
                    .ignoresSafeArea()
                    .onTapGesture { closeMenu() }

                panel(open)
                    .transition(MenuBloom(anchor: anchor))
                    // The composer's own height, and a step of air: the panel stands over
                    // the field rather than covering what is being typed into.
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
                    .padding(.horizontal, MiloTheme.margin)
                    .padding(.bottom, composerHeight + MiloTheme.Space.two)
            }
        }
        .animation(.smooth(duration: Self.drawerDuration), value: drawer)
        // The panel's own motion, in one place: the control that raises a panel and the layer
        // that dismisses it then cannot animate apart. Opening blooms with a gentle bounce;
        // closing folds straight back into the control.
        .animation(
            menu != nil ? .spring(duration: 0.35, bounce: 0.18) : .spring(duration: 0.22, bounce: 0),
            value: menu
        )
        .sensoryFeedback(.impact(weight: .light, intensity: 0.7), trigger: menu != nil)
        .sensoryFeedback(.impact(weight: .light), trigger: drawer)
        // The two edges of an answer: a firmer tap when the daemon begins to
        // speak, a softer one when it lands. `busy` cannot be the trigger — it
        // goes up on the send, before the daemon has said anything, so the tap
        // would land on the person's own thumb.
        .sensoryFeedback(.impact(weight: .medium, intensity: 0.6), trigger: model.answerBegan)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.5), trigger: model.answerEnded)
        .onChange(of: model.busy) { _, busy in
            Task {
                if busy {
                    await liveActivity.start(sessionID: model.sessionId)
                } else {
                    await liveActivity.finish()
                }
            }
        }
        .onChange(of: model.answerBegan) { _, _ in
            Task { await liveActivity.update(.replying) }
        }
        // A swipe across the thread opens the sessions and a swipe back closes them — the
        // gesture the platform's own sidebars answer to, from wherever the person swipes.
        // Only a mostly horizontal drag counts, so scrolling the thread is never mistaken
        // for it; and a drag that began inside a box with its own sideways scroll is the
        // box's, not the drawer's.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24, coordinateSpace: .global)
                .onEnded { drag in
                    let across = drag.translation.width
                    guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                    // Inside a box that scrolls sideways, the drag is the box's to answer.
                    guard !boxes.frames.contains(where: { $0.contains(drag.startLocation) }) else { return }
                    if !drawer, across > 60 {
                        openDrawer()
                    } else if drawer, across < -60 {
                        drawer = false
                    }
                }
        )
        .onPreferenceChange(ScrollBoxKey.self) { boxes.frames = $0 }
        .task {
            composing = true
            await model.begin(at: account)
            await model.refreshSessions()
        }
        // The strip answers words picked out of the thread on screen. When the session
        // changes — a new one started, another resumed — that passage is no longer there
        // to answer, so the strip goes with it instead of following into a session it was
        // never picked from.
        .onChange(of: model.sessionId) { _, _ in
            quote = nil
            // An edit belongs to the session it was made in; a new one is not the one to
            // fork, so the request is dropped rather than carried over.
            editing = nil
            // What a panel offered belonged to the session that was on screen — a running
            // turn that this one does not have among them.
            closeMenu()
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
    /// than sitting under a list that has nothing to type into. The list is re-read
    /// as it opens, so a session started on another surface is there when it does.
    private func openDrawer() {
        composing = false
        // The panel belongs to the composer this screen is showing, and the sessions are
        // leaving it: it goes with the field rather than floating over the list.
        closeMenu()
        drawer = true
        Task { await model.refreshSessions() }
    }

    /// The words picked out of an answer come to rest in the composer, focused, so what is
    /// typed next is written as the reply to them.
    private func quoteIt(_ words: String) {
        quote = words
        composing = true
    }

    /// The person's own message, back in the composer to be said again. The session forks
    /// at the turn before it, so sending edits the message rather than adding a second one
    /// — the browser's own Edit, over its own fork. `upToTurn` is that turn.
    private func editMessage(_ text: String, upToTurn: Int) {
        draft = text
        quote = nil
        editing = upToTurn
        composing = true
    }

    /// Putting the composer's panel away: from the layer under it, from a line of it that
    /// leaves the composer, and from a screen that leaves the composer behind. Raising one is
    /// the control's own — and both motions are the same, because the stack animates on the
    /// panel's own value rather than each caller asking for it.
    private func closeMenu() {
        menu = nil
    }

    /// Sending, from wherever it is asked for: the field's control and the panel the send
    /// control raises are one action, so they are one function. The words picked out travel
    /// as a quotation ahead of the reply, so what was answered is part of the message and not
    /// only in the reader's head; an edit is a redo from the turn before the message it
    /// changed, so the words go again with the session forked there rather than a second copy
    /// piling on top.
    private func send(_ intent: ClientFrame.Intent = .queue) {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let outgoing = (quote.map(quotedLead) ?? "") + draft
        draft = ""
        quote = nil
        if let upToTurn = editing {
            editing = nil
            Task { await model.regenerate(prompt: outgoing, upToTurn: upToTurn) }
        } else {
        // The keys come down with the words: the room the keyboard was holding is where the
        // reply is about to write itself, and the person's own words have gone up to the top
        // of the thread to open it.
        composing = false
    }

    /// What a panel says, per control that raises one. Every line carries the mark of what it
    /// does: a list of words alone is what the platform's own menu draws, and this panel is
    /// drawn here so it can say more than that.
    private func panel(_ which: ComposerMenu) -> some View {
        let rows: [MenuRow]
        switch which {
        case .actions:
            let modelRow = MenuRow(
                title: "Model",
                subtitle: model.modelLabel.isEmpty ? nil : model.modelLabel,
                symbol: "cpu"
            ) {
                closeMenu()
                picker = true
            }
            // The bulb is the browser's own mark for this control, off its reasoning pill;
            // the levels live inside it as a submenu, so the root panel names what is being
            // chosen and a press unfolds the levels in place.
            if model.efforts.isEmpty {
                rows = [modelRow]
            } else {
                rows = [
                    modelRow,
                    MenuRow(
                        title: "Reasoning effort",
                        symbol: "lightbulb",
                        children: model.efforts.map { value in
                            MenuRow(
                                title: SettingsWording.of(value),
                                chosen: value == model.effort
                            ) {
                                // The panel stays open: choosing how hard to think is not
                                // leaving, and the tick has to be seen moving onto what was
                                // chosen.
                                Task { await model.setEffort(value) }
                            }
                        }
                    ),
                ]
            }
        case .running:
            rows = [
                MenuRow(title: "Steer the running turn", symbol: "arrow.turn.down.right") {
                    closeMenu()
                    send(.steer)
                },
                MenuRow(title: "Send after this turn", symbol: "text.append") {
                    closeMenu()
                    send(.queue)
                },
                MenuRow(title: "Stop the turn", symbol: "stop.fill") {
                    closeMenu()
                    model.stop()
                },
            ]
        }
        return MenuPanel(rows: rows).id(which)
    }

    private var chat: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                    // The empty state wears an id of its own, so a session that opens can
                    // put the scroll back on it — see the reset below.
                    if model.messages.isEmpty { WelcomeView().id(Self.threadTop) }
                    ForEach(model.messages) { message in
                        MessageRow(
                            message: message,
                            turn: turns[message.id] ?? 1,
                            regenerate: regeneration(for: message),
                            onQuote: quoteIt,
                            onEdit: editMessage
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
            // The thread's end stays in view as it grows, and a screen with no words in it
            // rests against the composer — the ways in are the field's companion, not a
            // banner on an empty page. The role that places content shorter than the room is
            // named on its own rather than left to the other anchor to imply.
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.bottom, for: .alignment)
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
            // A session opens on its own content. The thread is emptied before the daemon
            // replays, and a scroll left where the old thread was leaves the empty state
            // outside the visible region — where a lazy stack draws nothing, so the screen
            // comes out blank. Putting the scroll back on it makes the welcome appear every
            // time, and a thread with words in it takes over from there as it grows.
            .onChange(of: model.sessionId) { _, _ in
                proxy.scrollTo(Self.threadTop, anchor: .top)
            }
            .safeAreaInset(edge: .top, spacing: 0) { topbar }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottom(proxy) }
        }
    }

    /// The end of the thread, as an id the scroll view answers to.
    private static let threadEnd = "thread-end"
    /// The empty state's own id, so a session that opens can put the scroll back on it.
    private static let threadTop = "thread-top"
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
                        Button {
                            // Inside the tap that asked for it, before the session moves:
                            // the cursor is in the field the press just opened, so the next
                            // thing said is typed rather than looked for. The browser's own
                            // new session takes focus the same way.
                            composing = true
                            Task { await model.newSession() }
                        } label: {
                            topGlyph("square.and.pencil")
                                .frame(width: 46, height: 46)
                        }
                        .accessibilityLabel("New session")

                        Menu {
                            sessionActions(
                                onRename: { renaming = model.sessionId },
                                onExport: { Task { await model.export(model.sessionId) } },
                                onCopy: { model.copyId(model.sessionId) },
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
            Composer(
                draft: $draft,
                quote: $quote,
                editing: $editing,
                focused: $composing,
                menu: $menu,
                send: send
            )
                // How tall the composer came out, so the panel opens above it rather than
                // through it — see `composerHeight`.
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { _, height in
                    composerHeight = height
                }
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
    /// The words picked out of an answer, held until the reply is sent.
    @Binding var quote: String?
    /// The turn an edit forks at, when the draft is an edit rather than a new message.
    @Binding var editing: Int?
    @FocusState.Binding var focused: Bool
    /// The panel this composer's controls raise, held by the screen: the panel is drawn over
    /// the composer — above the layer that dismisses it — rather than inside it.
    @Binding var menu: ComposerMenu?
    /// Sending, wherever it is asked for. The field's own control and the lines of the panel
    /// the send control raises are one action, so they are one function, on the screen.
    let send: (ClientFrame.Intent) -> Void
    @Environment(AppModel.self) private var model
    /// Whether the send control is under a finger, for the give every filled control here has.
    /// A control driven by gestures rather than by a `Button` — the long press the panel hangs
    /// on — has to ask for that itself.
    @State private var pressed = false

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

            // The background jobs still running, above the field and below the queued
            // count — the browser's own order. Nothing of the strip is drawn at rest.
            if !model.jobs.isEmpty {
                JobStrip(jobs: model.jobs)
            }

            if let quote {
                quoteStrip(quote)
                    .padding(.horizontal, MiloTheme.margin)
            }

            // Centred against the field: the send control is shorter than a line of text,
            // so bottom-aligning it left the air above it and read as a bump at the top.
            HStack(alignment: .center, spacing: MiloTheme.Space.one) {
                // The composer's own actions live behind this, not on the bar: what belongs
                // to the message is the field and the way to send it. Chosen model and how
                // hard it thinks are the two the browser keeps on its own composer, and they
                // are the shape a way to attach a file takes when the phone grows one.
                //
                // A press raises the panel rather than opening a menu of the platform's: a
                // platform menu takes the shape of the control it came from as it opens, and a
                // control inside the composer then reads as the composer becoming the menu.
                Button {
                    menu = menu == .actions ? nil : .actions
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .frame(width: 40, height: 40)
                        .contentShape(Circle())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("More")
                // The choices are the settings screen's own read, so this asks for them
                // once when it does not have them — one reader, two places that show it.
                .onAppear {
                    if model.efforts.isEmpty { Task { await model.loadSettings() } }
                }

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
                    // While a turn runs the same control sends or stops, and what is in
                    // the field decides which — see `busyControl`. One control, never a
                    // second one standing beside it.
                    busyControl
                } else {
                    MiloIconButton(
                        systemName: "paperplane.fill",
                        size: 16,
                        span: 36,
                        primary: true,
                        disabled: !canSend,
                        action: { send(.queue) }
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

    /// What is being answered, held at the composer until the reply is sent: the words
    /// picked out, and the way to drop them. The browser keeps the same strip above its own
    /// field, and both take the same shape on the wire — see `quotedLead`.
    ///
    /// It wears the platform's own glass, the material the composer below it is made of:
    /// the faint tint it carried before barely showed against the page, so the strip
    /// vanished instead of standing over the thread it was picked from.
    private func quoteStrip(_ words: String) -> some View {
        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
            Image(systemName: "quote.opening")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.accent)
            Text(words)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.foreground2)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                quote = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.muted)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Remove quote")
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.two)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// While a turn runs the field's own text decides this control. Empty, it stops: a tap
    /// ends the turn, and there is nothing typed that wants sending. With words in it, the
    /// tap sends them as a **steer** — the correction the browser puts on Ctrl/Cmd+Enter,
    /// which on a phone with no keys is the plain tap — and the press held down raises the
    /// panel naming all three things a running turn answers to, so neither queuing nor
    /// stopping nor the steering the tap already does is left for the reader to guess.
    /// Stopping never needs the field cleared first. A deliberate divergence from the
    /// browser, whose tap stays stop and whose plain Enter queues.
    ///
    /// Gestures rather than a button, so the platform tells the tap and the hold apart: a
    /// button answers the finger lifting after a hold as well as the hold itself, and
    /// steering on the way into the panel is not what a long press is asking for.
    @ViewBuilder
    private var busyControl: some View {
        if canSend {
            steerGlyph
                .contentShape(Circle())
                // A lift that came after a hold is the hold's, not a steer: with the panel
                // already up, the tap has nothing to send.
                .onTapGesture { if menu == nil { send(.steer) } }
                .onLongPressGesture(pressing: { pressing in
                    pressed = pressing
                }) {
                    menu = .running
                }
                .scaleEffect(pressed ? 0.97 : 1)
                .opacity(pressed ? 0.85 : 1)
                .animation(.snappy(duration: 0.18), value: pressed)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("Steer")
        } else {
            Button(action: model.stop) { stopGlyph }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Stop")
        }
    }

    /// The way to send, wearing what it does: the filled accent the idle send wears, so it
    /// is still read as the way to send, but the turn arrow says the tap steers the running
    /// turn rather than opening a new one — the same mark the panel names that line with.
    private var steerGlyph: some View {
        Image(systemName: "arrow.turn.down.right")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(MiloTheme.accentOn)
            .frame(width: 36, height: 36)
            .background(Circle().fill(MiloTheme.accent))
    }

    /// A quiet fill — the accent stays on the one thing to press when nothing runs.
    private var stopGlyph: some View {
        Image(systemName: "stop.fill")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(MiloTheme.foreground)
            .frame(width: 36, height: 36)
            .background(Circle().fill(MiloTheme.surface))
    }
}

/// The background jobs still running, in a strip above the composer — the browser's own,
/// drawn from the same `jobs` frame. A job is one filled chip: what it is running, how long
/// it has been going, and the tail of what it has printed, folded until a tap opens it; the
/// control beside the chip stops it. Only running jobs are ever in the list, so an ended one
/// leaves the strip on its own.
struct JobStrip: View {
    let jobs: [JobView]
    @Environment(AppModel.self) private var model
    /// The job whose output is open, by id — one at a time, as the browser keeps it.
    @State private var open: String?

    var body: some View {
        // A clock only while a job is on screen: the elapsed counter has to move, and a
        // timer left running under an empty strip would wake the screen for nothing.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(spacing: MiloTheme.Space.two) {
                ForEach(jobs) { job in
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        chip(job, now: context.date.timeIntervalSince1970)
                        if open == job.id { log(job) }
                    }
                }
            }
        }
        .padding(.horizontal, MiloTheme.margin)
    }

    private func chip(_ job: JobView, now: Double) -> some View {
        HStack(spacing: MiloTheme.Space.two) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { open = open == job.id ? nil : job.id }
            } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "terminal")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(MiloTheme.muted)
                    Text(Self.oneLine(job.command))
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: MiloTheme.Space.two)
                    Text(RelativeTime.elapsed(max(0, now - job.startedAt)))
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                        .monospacedDigit()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .rotationEffect(.degrees(open == job.id ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(open == job.id ? "Hide the job's output" : "Show the job's output")

            // Filled, not outlined: the chip is the surface and this is the one control on
            // it. Pressing it is the confirmation the wire wants.
            Button { model.killJob(job.id) } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(MiloTheme.surface))
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("Stop this job")
        }
        .padding(.leading, MiloTheme.Space.three)
        .padding(.trailing, MiloTheme.Space.two)
        .padding(.vertical, MiloTheme.Space.two)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.sm))
    }

    private func log(_ job: JobView) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(job.lines.isEmpty ? "No output yet." : job.lines.joined(separator: "\n"))
                .font(MiloTheme.Text.mono)
                .foregroundStyle(MiloTheme.foreground2)
                .textSelection(.enabled)
                .padding(MiloTheme.Space.three)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.sm))
    }

    /// The command on one line: the browser's own `oneLine` clips at eighty characters, so
    /// a long command cannot take the strip's height.
    private static func oneLine(_ command: String) -> String {
        String(command.replacingOccurrences(of: "\n", with: " ").prefix(80))
    }
}

    }
}

struct MessageRow: View {
    let message: AppModel.Message
    /// Which turn this message belongs to — what a fork cuts at.
    let turn: Int
    /// The words asking again would send, on the one answer it belongs to.
    let regenerate: (prompt: String, upToTurn: Int)?
    /// The words picked out of this answer, handed to the composer. Only the answer wears
    /// it: the person's own bubble is read, not answered.
    let onQuote: (String) -> Void
    /// The person's own message, back in the composer to be said again — with the turn the
    /// session is forked at, so the edit replaces the message rather than following it.
    let onEdit: (String, Int) -> Void
    @Environment(AppModel.self) private var model
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

    /// Whether the block being written is a widget: it is drawn as it grows, so the wait
    /// line has nothing to add while it is. The browser's own rule, read the same way.
    private var drawingADraft: Bool {
        if case .ui(_, true)? = message.parts.last { return true }
        return false
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
                // A `/sessions` answer is its cards: the words the command replied with are
                // the same list in text, and drawing both would say it twice. The parts and
                // the toolbar step aside for them, as the browser's own do.
                if let cards = message.cards, !cards.isEmpty {
                    SessionCards(cards: cards)
                } else {
                    ForEach(Array(drawn.enumerated()), id: \.offset) { _, group in
                            switch group {
                            case .calls(let calls):
                                ToolChain(calls: calls)
                            case .one(let part):
                                PartView(part: part, onQuote: onQuote, isStreaming: message.streaming)
                            }
                    }
                    if !message.attachments.isEmpty {
                        Attachments(items: message.attachments)
                    }
                    // The wait for the model's next output, wherever it falls: the line
                    // belongs to the turn's own state, not to the gap before its first
                    // words — so a turn thinking about a tool's result says so instead of
                    // going quiet. A widget being drawn is the work showing itself, which
                    // is why the browser leaves its own line off while one is.
                    if message.waiting, !drawingADraft {
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
                        MessageToolbar(message: message, turn: turn, regenerate: regenerate, onQuote: onQuote)
                    }
                }
                // The buttons a command drew, under its cards or its words: the pages of
                // `/sessions`, and anything else the daemon offers there.
                if let actions = message.actions, !actions.isEmpty {
                    ActionRows(rows: actions, messageId: message.id.uuidString)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// What can be done with the person's own message, behind the press: its words, the
    /// words again as an edit, and — when the turn is more than prose — the turn copied
    /// whole or, without the tool output, the path it walked, where the arguments and
    /// results the drawn parts leave out still live. The answer's own controls stand under
    /// it instead, so nothing here is said twice.
    @ViewBuilder
    private var menu: some View {
        menuItem("Copy", "doc.on.doc") { UIPasteboard.general.string = message.prose }
        // The words back in the composer and said again: the session forks before them, so
        // the edit replaces the message instead of following it. Not while a turn runs —
        // it would fork mid-answer.
        menuItem("Edit", "pencil", disabled: model.busy) { onEdit(message.prose, turn - 1) }
        if let raw = message.raw {
            rawCopyMenu(raw: raw, rawNoOutput: message.rawNoOutput)
        }
        if let tokens = message.tokens {
            menuItem("\(tokens.input) in · \(tokens.output) out", "cpu", disabled: true) {}
        }
    }
}

/// One turn copied raw, the two ways, behind the one control both menus offer. With the
/// output is the turn whole; without it is the path it walked — the thinking, the words
/// and every call with its arguments, a failed result still said — offered only where it
/// reads any differently from the whole. Declared once here, so the person's menu and the
/// answer's dots cannot draw the pair differently.
func rawCopyMenu(raw: String, rawNoOutput: String?) -> some View {
    Menu {
        menuItem("With output", "doc.plaintext") { UIPasteboard.general.string = raw }
        if let rawNoOutput {
            menuItem("Without output", "text.badge.minus") { UIPasteboard.general.string = rawNoOutput }
        }
    } label: {
        Label {
            Text("Copy raw")
        } icon: {
            Image(systemName: "curlybraces")
        }
    }
    .tint(MiloTheme.foreground)
}

/// The controls under a finished answer, the ones the browser draws there: the words
/// copied, the answer quoted whole and the answer asked again, and — behind the dots — the
/// session forked from this turn, what it cost and the turn copied whole.
///
/// The glyph and nothing around it, which is the same control the page draws: with no
/// pointer to hover with, a phone leaves to the press what the browser saves for the
/// hover. The fork, the cost and the raw copy are not repeated beside it — the browser
/// keeps those behind the dots too.
struct MessageToolbar: View {
    let message: AppModel.Message
    /// Which turn this answer belongs to, and what asking again would send.
    let turn: Int
    let regenerate: (prompt: String, upToTurn: Int)?
    /// The words picked out of this answer, handed to the composer.
    let onQuote: (String) -> Void
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
            // The answer whole, to answer. The browser keeps this a press deeper, in the
            // message's own menu; a phone has the room, and one press is what it has.
            control("text.quote", label: "Quote") { onQuote(message.prose) }
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

    /// What the dots hold: the session forked from this turn, what the answer cost, and
    /// the turn as it was said — the model's words, its thinking and every call with its
    /// arguments and result, or the same path with the results' own text left out.
    private var more: some View {
        Menu {
            if let tokens = message.tokens {
                menuItem("\(tokens.input) in · \(tokens.output) out", "cpu", disabled: true) {}
            }
            // SF's branch arrows each carry a triangle, and at this size the triangle is
            // the whole mark; the branch alone reads as the one thing it says.
            menuItem("Fork session from here", "arrow.branch", disabled: model.busy) {
                Task { await model.fork(from: turn) }
            }
            if let raw = message.raw {
                rawCopyMenu(raw: raw, rawNoOutput: message.rawNoOutput)
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

/// The sessions a `/sessions` command drew, in place of its words: one filled row each, the
/// way this platform lists a choice. A press opens the session it names — choosing one is
/// what the command was for. The command's own text listing is the same list, so it is not
/// drawn beside these.
struct SessionCards: View {
    let cards: [SessionCardItem]
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: MiloTheme.Space.two) {
            ForEach(cards) { card in
                Button { model.act("resume:\(card.id)", messageId: nil) } label: {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        HStack(spacing: MiloTheme.Space.two) {
                            Text(card.title ?? card.id)
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: MiloTheme.Space.two)
                            Text(card.id)
                                .font(MiloTheme.Text.meta.monospaced())
                                .foregroundStyle(MiloTheme.muted)
                                .lineLimit(1)
                        }
                        HStack(spacing: MiloTheme.Space.three) {
                            Text("\(card.messageCount) msgs")
                            Text(card.when)
                            Spacer(minLength: 0)
                        }
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                        if !card.summary.isEmpty {
                            Text(card.summary)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.foreground2)
                                .lineLimit(2)
                        }
                    }
                    .padding(MiloTheme.Space.three)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
            }
        }
    }
}

/// The buttons a command drew, under its reply: one filled row each, the browser's own shape.
/// A button that is not actionable is drawn inert — a marker such as the page count, never a
/// control that promises what it cannot do — and the rest travel as an `action` naming this
/// message, so the daemon answers back into the same bubble.
struct ActionRows: View {
    let rows: [ActionRow]
    let messageId: String
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: MiloTheme.Space.one) {
                    ForEach(row) { button in
                        item(button)
                    }
                }
                .padding(.horizontal, MiloTheme.Space.one)
                .padding(.vertical, MiloTheme.Space.one)
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            }
        }
    }

    @ViewBuilder
    private func item(_ button: ActionButton) -> some View {
        if button.disabled == true {
            Text(button.label)
                .font(MiloTheme.Text.small.monospaced())
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.vertical, MiloTheme.Space.two)
        } else if let url = button.url.flatMap(URL.init(string:)) {
            Link(destination: url) { label(button) }
        } else {
            Button { model.act(button.id, messageId: messageId) } label: { label(button) }
                .buttonStyle(PressableStyle())
        }
    }

    private func label(_ button: ActionButton) -> some View {
        Text(button.label)
            .font(MiloTheme.Text.base)
            .foregroundStyle(tone(button))
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.two)
            .background {
                RoundedRectangle(cornerRadius: MiloTheme.Radius.sm)
                    .fill(button.style == "primary" ? MiloTheme.accent : Color.clear)
            }
    }

    /// The tone a button's words wear: the accent only on the one the person is meant to
    /// press, the semantic colours where the daemon names one, and the quiet foreground
    /// otherwise.
    private func tone(_ button: ActionButton) -> Color {
        switch button.style {
        case "primary": return MiloTheme.accentOn
        case "danger": return MiloTheme.danger
        case "success": return MiloTheme.success
        default: return MiloTheme.foreground2
        }
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
    /// The words picked out of this part of an answer, handed to the composer.
    let onQuote: (String) -> Void
    var isStreaming = false
    @Environment(AppModel.self) private var model

    var body: some View {
        switch part {
        case .text(let text):
            Prose(text: text, isStreaming: isStreaming, onQuote: isStreaming ? nil : onQuote)
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
/// carries the colour and the one value worth showing stays quiet beside it — and, under
/// it, what the call came back with, folded until a tap opens it.
struct ToolRow: View {
    let tool: ToolMark
    @State private var showingResult = false

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            line
            if let result = tool.result, !result.isEmpty { resultDetail(result) }
        }
    }

    private var line: some View {
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
                Glare(text: wholeLine, font: MiloTheme.Text.body)
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

    /// What the call came back with, under its line and on the line's own indent: the
    /// first line while it is shut, the whole of it when the tap opens it. Capped on the
    /// server, so what is folded and what is opened are one reading — the whole record is
    /// the turn's Copy raw.
    private func resultDetail(_ result: String) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { showingResult.toggle() }
            } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .rotationEffect(.degrees(showingResult ? 90 : 0))
                    Text(result.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? "")
                        .font(MiloTheme.Text.small.monospaced())
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(showingResult ? "Hide the tool result" : "Show the tool result")

            if showingResult {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(result)
                        .font(MiloTheme.Text.mono)
                        .foregroundStyle(MiloTheme.foreground2)
                        .textSelection(.enabled)
                        .padding(MiloTheme.Space.three)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            }
        }
        // Under the text, past the mark's own column, so a result lines up with the name
        // it belongs to rather than with the mark.
        .padding(.leading, 22)
    }

    /// The whole line, for the sweep to travel along: the name and its value in one
    /// string, as the server drew it.
    private var wholeLine: String { tool.text.isEmpty ? tool.name : tool.text }

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
