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
    /// The files picked for the message being written, held until it is sent — the phone's
    /// half of the field the browser attaches through.
    @State private var drafts: [AttachmentDraft] = []
    /// A message being edited: the turn just before it, which the session is forked at so
    /// the edited words replace it rather than stacking a second copy on top.
    @State private var editing: Int?
    @State private var drawer = false
    @State private var picker = false
    @State private var settings = false
    @State private var routines = false
    @State private var routinesSelected = false
    @State private var tasks = false
    @State private var tasksSelected = false
    @State private var work = false
    @State private var workSelected = false
    /// The project the Work page is to open on top of its index, when the way back from a
    /// session named one. Cleared by that page as it opens it.
    @State private var workProject: String?
    /// Whether one routine's, task list's or project's own page is open on top of its index. The
    /// drawer's swipe belongs to the list: over a page that drag is the page's own way back, and
    /// the two cannot both answer it.
    @State private var routinePage = false
    @State private var taskPage = false
    @State private var workPage = false
    /// Whether the card is aside on the work behind it rather than on the sessions. Set as a drag
    /// claims the card, so what is uncovered and what the shell thinks is uncovered cannot differ.
    @State private var backing = false
    /// The composer's panel, when one is open — raised by the `+` or by a long press on the
    /// send control, drawn over the composer, dismissed by a tap anywhere but itself.
    @State private var menu: ComposerMenu?
    /// The pickers the panel's attach lines raise: the platform's own chooser for each, over
    /// this screen, which is where the files come from.
    @State private var attach: AttachKind?
    /// How tall the composer came out, so the panel opens above it instead of through it.
    /// Read off the composer itself: it grows with the draft and with every strip above the
    /// field, so no constant would place the panel right.
    @State private var composerHeight: CGFloat = 0
    /// How tall the top bar came out, so the line under it is placed where the bar ends.
    @State private var topbarHeight: CGFloat = 0
    /// The session being renamed from this screen — the dots in the top bar name it,
    /// and the shared alert does the rest.
    @State private var renaming: String?
    /// Whether the thread is at its end, read off the scroll itself. What the arrow
    /// above the composer answers to.
    @State private var atEnd = true
    /// How wide the screen is, so the panel can take a share of it rather than a fixed number
    /// of points — the same column on a phone and on a tablet.
    @State private var screenWidth: CGFloat = 0
    /// The hand's own travel across the card, before it is let go: a lid follows the finger
    /// rather than appearing once the gesture has finished — the platform's own sidebars' move.
    /// Measured from where the drag was claimed, so the card begins under the hand and does not
    /// jump by the distance it took to tell a swipe from a scroll.
    @State private var drag: CGFloat = 0
    /// Where that claim happened, in the hand's own travel.
    @State private var dragFrom: CGFloat = 0
    /// Whether the drag on the card is the card's to answer — decided once per gesture, as soon
    /// as the hand has said which way it is going, and kept for the rest of it. `nil` while it is
    /// still anybody's. A drag the thread is scrolling is left to the thread; one the card has
    /// claimed freezes the thread under it — see the scroll's own `scrollDisabled`.
    @State private var held: Bool?
    /// Where the touch in hand began. A touch begins at a place of its own, so a different one
    /// is the signal that the last is over — even one the system took away mid-gesture, which
    /// would otherwise leave its claim behind.
    @State private var touch: CGPoint?
    /// Whether a finger is on the card at all, straight off the gesture: a `@GestureState`, so
    /// the platform clears it the moment the touch ends and the thread can never be left frozen
    /// by a swipe that was taken away.
    @GestureState private var touching = false
    /// Whether the reply being written is carried along with the thread's end, so its newest
    /// line stays in view. On wherever the person has left the thread at its end — their own
    /// move takes it away, and coming back to the end gives it back.
    @State private var following = true
    /// Whether the person is the one moving the thread — a finger in it, or the glide a flick
    /// left behind. It holds the following off until they have settled, so a reply is never
    /// carried along under their hand.
    @State private var moving = false
    /// The room the thread keeps under its words: exactly what it takes for the message a send
    /// has just put in to sit at the top of the box, and not a point more, so the thread has
    /// nowhere to scroll but back to that message. It is only opened for a send — a thread
    /// nobody has just written into is left alone, and one that fits gets no room and no
    /// scroll at all. A screen with no words on it rests against the composer, the room's own
    /// floor.
    @State private var room: CGFloat = 1
    /// The thread's own box, what the words in it take before the room is added, and where the
    /// send's own message sits inside it: what the room is measured from. `boxHeight` follows
    /// the live viewport height even while the keyboard is up so the empty state always rests
    /// against the composer without flipping the scroll view's alignment anchor on send.
    @State private var boxHeight: CGFloat = 0
    @State private var threadHeight: CGFloat = 0
    @State private var bare: CGFloat = 0
    @State private var sentTop: CGFloat?
    /// The message a send has just put in — the one the room is opened for, and the one the
    /// scroll waits on — and whether that scroll has been made.
    @State private var sent: UUID?
    @State private var placed = true
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
            Group {
            if backing, model.sessionProject != nil {
                // The work, uncovered by the same drag that uncovers the sessions: a session in
                // a project goes back to that project rather than to the list of every chat. A
                // session chosen on it closes the lid onto the chat it opened, and the control
                // the index carries opens the sessions from here too.
                WorkView(
                    pushed: $workPage,
                    opening: $workProject,
                    onSessions: openDrawer,
                    onChat: { focusing in
                        closeLid()
                        leaveWork(focusing: focusing)
                    }
                )
                // Coming back from it: a drag the other way is the card returning, the same
                // gesture the drawer answers when it is the one uncovered.
                .simultaneousGesture(
                    DragGesture(minimumDistance: 24, coordinateSpace: .global)
                        .onEnded { drag in
                            let across = drag.translation.width
                            guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                            guard across < -60 else { return }
                            closeLid()
                        }
                )
            } else {
            SessionsDrawer(
                routinesSelected: routinesSelected,
                tasksSelected: tasksSelected,
                workSelected: workSelected,
                onClose: {
                    routinesSelected = false
                    routines = false
                    tasksSelected = false
                    tasks = false
                    workSelected = false
                    work = false
                    Task { @MainActor in
                        drawer = false
                    }
                },
                onNewSession: {
                    // Inside the tap that asked for it, before the session moves: the
                    // cursor is in the field the press just opened, so the next thing
                    // said is typed rather than looked for. The browser's own new
                    // session takes focus the same way.
                    routinesSelected = false
                    routines = false
                    tasksSelected = false
                    tasks = false
                    workSelected = false
                    work = false
                    composing = true
                    Task { @MainActor in
                        drawer = false
                        await model.newSession()
                    }
                },
                onSettings: {
                    drawer = false
                    routinesSelected = false
                    routines = false
                    tasksSelected = false
                    tasks = false
                    workSelected = false
                    work = false
                    settings = true
                },
                onRoutines: { openPage(.routines) },
                onTasks: { openPage(.tasks) },
                onWork: { openPage(.work) }
            )
            }
            }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .opacity(sessionsShown ? 1 : 0)
                .animation(sessionsShown ? nil : .linear(duration: 0.01).delay(Self.drawerDuration), value: sessionsShown)
                .allowsHitTesting(drawer)
                .accessibilityHidden(!drawer)

            // The panel, behind the chat on the other edge: the sessions' own arrangement,
            // mirrored, so the same card uncovers either one. Drawn under the chat rather than
            // over it, while it is up at rest and under a hand dragging the panel's way — the
            // card is what uncovers it, so a peek at it is there for the finger rather than
            // appearing only once the gesture has finished.
            if let showing = panelTabs, panelShown || travel < 0 {
                SidePanel(tabs: showing.tabs, active: showing.active, width: panelWidth) {
                    model.panelOpen = false
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                // The surface comes in from the edge it lives on, while the card goes the other
                // way — one opening rather than a slab of chrome sliding across.
                .transition(.move(edge: .trailing))
            }

            cardContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The card is the background: it runs under the status bar and the
                // home indicator, and carries the rounded edge and the shadow while
                // the content stays inside the safe area.
                .background {
                    UnevenRoundedRectangle(
                        topLeadingRadius: travel > 0 ? 28 : 0,
                        bottomLeadingRadius: travel > 0 ? 28 : 0,
                        bottomTrailingRadius: travel < 0 ? 28 : 0,
                        topTrailingRadius: travel < 0 ? 28 : 0
                    )
                    .fill(MiloTheme.background)
                    .shadow(
                        color: travel == 0 ? .clear : MiloTheme.seamShadow,
                        radius: 14,
                        x: travel < 0 ? 2 : -2,
                        y: 0
                    )
                    .ignoresSafeArea()
                }
                .offset(x: travel)
                // While either lid is open, the chat is that lid: a tap on it closes what it
                // covers instead of reaching what is underneath. The lid starts where the chat
                // does — its frame still spans the whole screen, because an offset moves what is
                // drawn and not what the view occupies, and a lid over the whole frame swallowed
                // the taps on the surface below it, so choosing something closed the list and
                // changed nothing.
                .overlay {
                    if drawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .padding(.leading, Self.drawerWidth)
                            .onTapGesture { drawer = false }
                    } else if panelShown {
                        Color.clear
                            .contentShape(Rectangle())
                            .padding(.trailing, panelWidth)
                            .onTapGesture { model.panelOpen = false }
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
        // The card's own move, keyed on where it rests rather than on where a finger has it: a
        // drag is the hand's own motion and carries the card point for point, so only the
        // opening and the closing — and the fall back of a drag let go short — are animated.
        .animation(Self.lidMove, value: rest)
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
        // A swipe across the thread carries the card with it rather than waiting for the
        // gesture to end: the lid follows the hand, and a drag let go short of a decision falls
        // back where it came from — the platform's own sidebars' move, from wherever the person
        // swipes. Only a mostly sideways drag is the card's, so scrolling the thread is never
        // mistaken for it; one that began inside a box with its own sideways scroll is the
        // box's; and one the card has claimed freezes the thread under it, so the words do not
        // creep while the card is being pulled aside.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24, coordinateSpace: .global)
                .updating($touching) { _, state, _ in state = true }
                .onChanged { value in
                    // A touch begins at a place of its own: clearing here is what keeps a swipe
                    // the system took away from carrying its claim — and its half-open lid —
                    // into the next one, and lets the thread go with it.
                    if touch != value.startLocation {
                        touch = value.startLocation
                        if held != nil { drag = 0 }
                        held = nil
                        dragFrom = 0
                    }
                    let across = value.translation.width
                    let down = value.translation.height
                    // Which way the hand is going, decided once and kept: sideways is the
                    // card's — where that edge has something to show — and up or down is the
                    // thread's, which the card then leaves alone for the rest of the gesture.
                    // A diagonal that has not said yet is nobody's; nothing moves until it does.
                    if held == nil {
                        if abs(across) > abs(down) * 1.5 {
                            held = claims(across, from: value.startLocation)
                            if held == true {
                                dragFrom = across
                                // What the card is about to uncover, decided once, here: a chat
                                // in the middle of work goes back to that work — the project's own
                                // page, which is where that session belongs — and a chat that is
                                // not in a project goes back to the list of chats.
                                backing = across > 0 && onChatPage && model.sessionProject != nil
                                if backing, let project = model.sessionProject {
                                    workProject = project.error == nil ? project.id : nil
                                }
                                // The keys go down with the card as it is pulled aside — the
                                // rule opening a lid follows, made here too so the field does
                                // not sit under a swipe with the keyboard left to the scroll,
                                // closing and springing back as the thread is held still.
                                composing = false
                            }
                        } else if abs(down) > abs(across) {
                            held = false
                        }
                    }
                    guard held == true else { return }
                    drag = across - dragFrom
                }
                .onEnded { value in
                    let ours = held == true
                    touch = nil
                    guard ours else {
                        held = nil
                        drag = 0
                        return
                    }
                    settle(value)
                    // The claim is kept a turn past the touch-up. The platform recognizes a
                    // drag and a tap together while a card is being swiped, so the row the
                    // finger crossed is still asked whether it was pressed — and it is the
                    // card's claim, still standing here, that says it was not. Cleared a turn
                    // later, once this touch-up has been answered and no press can follow it.
                    Task { @MainActor in held = nil }
                }
        )
        .onPreferenceChange(ScrollBoxKey.self) { boxes.frames = $0 }
        // The screen's own share, which is what the panel's width is a fraction of: measured
        // rather than assumed, so the same screen reads right whichever phone or tablet it is.
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { _, width in
            screenWidth = width
        }
        .task {
            composing = true
            // A tap on a reply's notice names the session its answer is in, and that is the
            // session to open — not the fresh one this app otherwise starts on.
            let opened = await model.openPendingSession()
            if !opened { await model.begin(at: account) }
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
        // One lid at a time: the two surfaces move the same card in opposite directions, and
        // what the model has just shown is the one the card answers to.
        .onChange(of: model.panelOpen) { _, open in
            if open { drawer = false }
        }
        // The keys go down with the panel as they do with the sessions: a surface that carries
        // reading matter is not the field. Watched on where the panel comes up rather than on
        // the choice, so the model bringing one forward on its own drops the keyboard too.
        .onChange(of: panelShown) { _, up in
            if up { composing = false }
        }
        // A tapped reply notice with the chat already up: the session it named is opened
        // here, rather than waiting for the next launch to read it — the shape a tapped
        // reminder takes just below.
        .onChange(of: model.pendingSession) { _, id in
            guard id != nil else { return }
            Task { _ = await model.openPendingSession() }
        }
        // A tapped reminder opens the Routines page in the same shell as the chat.
        .onChange(of: model.pendingRoutine) { _, id in
            if id != nil {
                tasksSelected = false
                tasks = false
                routinesSelected = true
                routines = true
            }
        }
        .onAppear {
            if model.pendingRoutine != nil {
                tasksSelected = false
                tasks = false
                routinesSelected = true
                routines = true
            }
        }
        .sessionRename($renaming)
        // Where the files come from: the platform's own chooser for each, over this screen —
        // the same pair a project's own page raises, from `ComposerAttach`.
        .attachmentPickers(drafts: $drafts, asked: $attach) { message in
            model.showNote(message)
        }
    }

    @ViewBuilder
    private var cardContent: some View {
        if routines {
            // The sessions are the chat's own drawer, and this screen opens it the
            // way the chat does: the same control, the same gesture. Dismissing the
            // drawer without choosing a session leaves the person on the routines —
            // only a session chosen takes the card back to the chat.
            RoutinesView(account: account, pushed: $routinePage, onSessions: openDrawer)
        } else if tasks {
            TaskListsView(pushed: $taskPage, onSessions: openDrawer)
        } else if work {
            // A session started or opened here is a session like any other: the card goes
            // back to the chat it was begun in, which is where it is read and spoken to.
            WorkView(pushed: $workPage, opening: $workProject, onSessions: openDrawer, onChat: leaveWork)
        } else {
            chat
        }
    }

    /// Back to the chat from the Work screen, with the cursor in the field when the
    /// session was started there rather than opened.
    private func leaveWork(focusing: Bool) {
        if focusing { composing = true }
        workSelected = false
        work = false
    }

    /// The panel's tabs and the one in front, when the daemon has any and the sessions are not
    /// the lid that is up: the tab in front is picked here, so the panel never has to draw a
    /// state the daemon cannot send — an index that has gone stale slides back into the list
    /// rather than being trusted to point at it.
    private var panelTabs: (tabs: [PanelTab], active: PanelTab)? {
        // The sessions win while they are up: the drawer's own change closes the panel a moment
        // later, and until it does the two lids would otherwise be on the card at once.
        guard !drawer, let panel = model.panel, !panel.tabs.isEmpty else { return nil }
        return (panel.tabs, panel.tabs[min(max(panel.active, 0), panel.tabs.count - 1)])
    }

    /// Whether the panel is up at rest: the model's own choice about the person's screen, and
    /// only when there is something on it — the browser's own gate, so a switch left on with no
    /// tabs is not an empty lid.
    private var panelShown: Bool { model.panelOpen && hasPanel }

    /// Whether there is a panel to open at all. A swipe that raised an empty lid would be a
    /// gesture that promises a surface there is nothing to put on.
    private var hasPanel: Bool { !(model.panel?.tabs.isEmpty ?? true) }

    /// Whether the sessions are uncovered at all — at rest or under a hand — so the list is
    /// drawn only while something, the opening or the finger, is carrying the card off it.
    private var sessionsShown: Bool { travel > 0 }

    /// How wide the panel comes out: most of the screen, because it carries reading matter
    /// rather than a list — and never all of it, so the chat it slid over stays the thing the
    /// tap and the drag go back to. Held between a floor and a ceiling, so the share that
    /// reads right on a phone does not become a column of air on a tablet.
    private var panelWidth: CGFloat {
        min(max(screenWidth * 0.9, 300), 480)
    }

    /// Where the card rests when nothing is being dragged: right for the sessions, left for the
    /// panel. They never both ask — the two lids move the same card — so this is one value
    /// rather than two offsets that could come to add up. What a hand is doing to the card rides
    /// on top of it — see `travel`.
    private var rest: CGFloat {
        if drawer { return lidWidth }
        if panelShown { return -panelWidth }
        return 0
    }

    /// Where the card is drawn: where it rests, carried along by a hand in it. A drag never
    /// reaches past either edge, so a swipe that began on one lid cannot open the other through
    /// the gap — and a drag let go short of a decision falls back to the rest it came from.
    private var travel: CGFloat {
        let raw = rest + drag
        if rest > 0 { return min(rest, max(0, raw)) }
        if rest < 0 { return max(rest, min(0, raw)) }
        return min(lidWidth, max(-panelWidth, raw))
    }

    private static let drawerWidth: CGFloat = 300

    /// Whether the card is showing the chat itself rather than a page the drawer opened: the drag
    /// means one thing over the chat and another over those pages.
    private var onChatPage: Bool { !routines && !tasks && !work }

    /// How wide the surface behind the card comes out: the chats are a column of the screen, and a
    /// project's own page is a whole one.
    private var lidWidth: CGFloat { backing ? screenWidth : Self.drawerWidth }
    /// The slide of the chat uncovering the sessions. One value for the move and for
    /// the moment the list under it comes back, so the two cannot drift apart.
    private static let drawerDuration: Double = 0.28
    /// The move the card makes when a lid opens: the same length as the sessions' own slide, so
    /// the list underneath comes back exactly as the card covers it — with a little spring in
    /// it, which is what says a surface has been brought over the chat rather than through it.
    private static let lidMove = Animation.spring(duration: drawerDuration, bounce: 0.16)

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

    /// Whether a sideways drag belongs to the card rather than to the thread: toward an edge
    /// that has something to show — the sessions on the right, the panel on the left — and from
    /// outside any box that scrolls sideways of its own. A lid already up is the one the drag
    /// answers, whichever way the hand goes; from rest, a rightward drag over a routine's,
    /// task list's or project's own page is that page's way back to its list (`RoutinesView`,
    /// `TaskListsView`, `WorkView`), so the sessions stay out of it.
    private func claims(_ across: CGFloat, from start: CGPoint) -> Bool {
        guard !boxes.frames.contains(where: { $0.contains(start) }) else { return false }
        if drawer || panelShown { return true }
        return across > 0 ? !((routines && routinePage) || (tasks && taskPage) || (work && workPage)) : hasPanel
    }

    /// Where a drag that has just been let go leaves the card: past halfway, or flicked there,
    /// is a decision about which lid is up; short of that the card falls back to the rest it came
    /// from. Halfway is measured on the lid the card is standing in, so the wide sessions and the
    /// narrower panel are each answered by their own width rather than by a length picked for one
    /// of them.
    private func settle(_ value: DragGesture.Value) {
        let live = travel
        let flick = rest + (value.predictedEndTranslation.width - dragFrom)
        let half = (live >= 0 ? lidWidth : panelWidth) / 2
        withAnimation(Self.lidMove) {
            if rest > 0 {
                if live < half || flick < half {
                    drawer = false
                    backing = false
                    workProject = nil
                }
            } else if rest < 0 {
                if -live < half || -flick < half { model.panelOpen = false }
            } else if live > 0 {
                if live > half || flick > half {
                    // Settled on what the drag was uncovering: the chats, or the work.
                    drawer = true
                } else {
                    // A drag let go short of a decision falls back, and what it was going to
                    // uncover goes with it — the card returning is the whole of the move.
                    backing = false
                    workProject = nil
                }
            } else if live < 0 {
                if -live > half || -flick > half { model.panelOpen = true }
            }
            drag = 0
        }
    }

    /// Which of the three pages the drawer opens.
    private enum Page { case routines, tasks, work }

    /// Coming out of the drawer onto a page: the page takes its place on the card first while
    /// `drawer` is still up (`rest` unchanged, so no animation transaction runs on the swap),
    /// and the next turn closes `drawer` so `.animation(Self.lidMove, value: rest)` slides the
    /// already-swapped card across the screen — the exact two-step sequence a session row runs.
    private func openPage(_ page: Page) {
        closeMenu()
        model.panelOpen = false
        routinesSelected = page == .routines
        routines = page == .routines
        tasksSelected = page == .tasks
        tasks = page == .tasks
        workSelected = page == .work
        work = page == .work
        Task { @MainActor in
            drawer = false
        }
    }

    /// Opening the sessions is leaving the thread: the keys go down with it rather
    /// than sitting under a list that has nothing to type into. The list is re-read
    /// as it opens, so a session started on another surface is there when it does.
    private func openDrawer() {
        composing = false
        // The panel belongs to the composer this screen is showing, and the sessions are
        // leaving it: it goes with the field rather than floating over the list.
        closeMenu()
        // And the two lids move the same card: looking at the sessions is the person's own
        // choice about their screen, which the panel stands down for.
        model.panelOpen = false
        backing = false
        workProject = nil
        drawer = true
        Task { await model.refreshSessions() }
    }

    /// Putting the card back over the work: the page was uncovered by a drag, so leaving it is
    /// that drag undone rather than a page swapped out inside the card.
    private func closeLid() {
        withAnimation(Self.lidMove) {
            drawer = false
            backing = false
            workProject = nil
        }
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
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !drafts.isEmpty else { return }
        let outgoing = (quote.map(quotedLead) ?? "") + draft
        let attached = drafts
        // An edit is a redo from the turn before the message it changed, and a redo has
        // nowhere to put a file: with one attached the words go as a turn of their own —
        // the rule the browser's own composer keeps.
        if let upToTurn = editing, attached.isEmpty {
            draft = ""
            quote = nil
            editing = nil
            Task { await model.regenerate(prompt: outgoing, upToTurn: upToTurn) }
        } else {
            // The arrival the bubble is drawn with is this transaction: a send moves the
            // control that carried it the way the thread moves, so it reads as one motion.
            withAnimation(SettlesIn.motion) {
                draft = ""
                quote = nil
                editing = nil
                drafts = []
                model.send(outgoing, intent: intent, drafts: attached)
            }
            // Named here, inside the same update the words went in with: the row is told where
            // it sits as it is laid out, and a name set any later would arrive after the
            // measuring it is there for.
            if let id = model.messages.last?.id { armSend(id) }
        }
        // The keys come down with the words: the room the keyboard was holding is where the
        // reply is about to write itself, and the person's own words have gone up to the top
        // of the thread to open it.
        composing = false
    }

    /// Marks the message a send just put in as the one the room and the scroll answer to,
    /// clearing the previous turn's measurement so the room waits for this row's own.
    private func armSend(_ id: UUID) {
        guard sent != id else { return }
        // The first message in a session is already at the top of the thread; opening extra
        // room or calling scrollTo while the keyboard drops would only fight the scroll box.
        if model.messages.count == 1 {
            bare = 0
            sent = nil
            sentTop = nil
            placed = true
            if room != 1 { room = 1 }
            following = true
            return
        }
        sent = id
        sentTop = nil
        placed = false
        // A send is the thread's own end — the room below the words is opened for the
        // reply, and the reply is followed from there, whatever the person was doing
        // before the send.
        following = true
    }

    /// What a panel says, per control that raises one. Every line carries the mark of what it
    /// does: a list of words alone is what the platform's own menu draws, and this panel is
    /// drawn here so it can say more than that.
    private func panel(_ which: ComposerMenu) -> some View {
        let rows: [MenuRow]
        switch which {
        case .actions:
            // What belongs to the message being written: the files, and how hard the model
            // thinks — one set of rows, from `ComposerAttach`, so the panel a project's own
            // page raises is this one.
            let modelRow: (() -> Void)? = model.sessionProject == nil ? {
                closeMenu()
                self.picker = true
            } : nil
            rows = composerActionRows(
                model: model,
                modelRow: modelRow,
                ask: { ask in
                    closeMenu()
                    self.attach = ask
                }
            )
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
                // The room sits outside the lazy stack so it is always in the scroll's
                // content size: a lazy stack only measures what is near the viewport, which
                // would leave the room unmeasured whenever the end of the thread begins
                // below the fold.
                VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                    // The empty state and the lazy stack share one top-leading origin rather
                    // than stacking vertically: when the first message is sent inside
                    // `SettlesIn.motion`, the welcome fades out in place while the first row
                    // begins at the top of the thread from frame zero instead of sitting below
                    // the disappearing welcome for 380ms and snapping up at the end.
                    ZStack(alignment: .topLeading) {
                        if model.messages.isEmpty {
                            // The empty state is the thread's only content, but the outer stack
                            // still leaves its own gap before the one-point end sentinel below it;
                            // pulling back after the frame has aligned the suggestions to the
                            // bottom keeps the last line resting above the composer instead of
                            // sliding behind it.
                            WelcomeView(claimed: held == true)
                                .frame(
                                    minHeight: max(0, boxHeight - MiloTheme.Space.four - 1),
                                    alignment: .bottom
                                )
                                .padding(.bottom, -MiloTheme.Space.six)
                                .transition(.opacity)
                                .id(Self.threadTop)
                        }
                        LazyVStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                            ForEach(model.messages) { message in
                                let isSent = message.id == sent
                                let space = Self.threadSpace
                                MessageRow(
                                    message: message,
                                    turn: turns[message.id] ?? 1,
                                    regenerate: regeneration(for: message),
                                    onQuote: quoteIt,
                                    onEdit: editMessage
                                )
                                // A send is what draws this: the words rise into the thread, and
                                // everything else that lands in it is simply there — see
                                // `SettlesIn`.
                                .transition(SettlesIn())
                                // Named so a send can put these words at the top of the thread — and,
                                // for the message the send just put in, told where it sits in the
                                // thread, which is what the room under the words is measured from.
                                .id(message.id)
                                .onGeometryChange(for: CGFloat?.self) { geometry in
                                    isSent ? geometry.frame(in: .named(space)).minY : nil
                                } action: { _, top in
                                    guard let top else { return }
                                    sentTop = top
                                    sizeRoom(proxy)
                                }
                            }
                        }
                    }
                    // The end of the thread, as something to be pointed at: where the arrow goes
                    // back to, and where a send takes the person. It carries the room under the
                    // last words — a screenful of the thread, less what they already take — so a
                    // send can put the person's own message at the top with the reply's space
                    // open beneath it, and so the room gives way to the reply as it grows and
                    // the thread's end stays where the words end.
                    Color.clear.frame(height: room).id(Self.threadEnd)
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.top, MiloTheme.Space.four)
                // The thread's own space: a message's place in it is measured here, where the
                // scroll cannot move it.
                .coordinateSpace(.named(Self.threadSpace))
                // The thread sits close over the composer: the last line belongs to the
                // thing being typed, not a hand's width above it.
            }
            // The thread hangs from its own top: a send puts the person's words up there and
            // the reply writes itself downward in the room below. What has grown past the
            // screen is carried along as it is written, while the person is at the end — see
            // `following`. Keeping the anchor fixed at `.top` avoids flipping the scroll view's
            // alignment mid-send when the first message arrives.
            .defaultScrollAnchor(.top)
            .defaultScrollAnchor(.top, for: .alignment)
            .scrollDismissesKeyboard(.interactively)
            // Frozen the moment the card has claimed the drag: a sideways swipe that pulled the
            // thread along would creep the words under the card as it is carried aside. Gated on
            // the touch as well as the claim, so a swipe taken away mid-gesture unfreezes it.
            .scrollDisabled(touching && held == true)
            .scrollEdgeEffectStyle(.soft, for: .vertical)
            // Asked of the scroll box, the way the browser asks its own: the end is the
            // end within a hundred points, so the arrow does not appear while the last
            // line is still in sight. The room under the words is not content the arrow
            // could be pointing at — it is empty by design, held for the reply — so the
            // end is measured from where the words stop rather than from the box's own
            // bottom; otherwise a flick of the thumb reads as having left the thread
            // behind while every word of it is still on screen.
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - room - geometry.contentOffset.y - geometry.containerSize.height < 120
            } action: { _, atEnd in
                self.atEnd = atEnd
                // The end back in sight is the reply followed again — unless the person is
                // the one moving the thread there. A thread with no words in it has no end
                // to be carried to: the welcome sits against the composer on its own, and
                // the empty moment a session passes through on its way to its replay arms
                // nothing.
                if atEnd, !moving, !model.messages.isEmpty { following = true }
            }
            // What the thread measures with the room in it, and how tall its box is. The room
            // is what the send's message needs under it to sit at the top: a boxful, less what
            // the thread already takes above it — so the most the thread can be scrolled is
            // exactly that message, and a thread that fits is left with no scroll at all.
            .onScrollGeometryChange(for: CGSize.self) { geometry in
                geometry.contentSize
            } action: { _, size in
                bare = size.height - room
                sizeRoom(proxy)
                // A reply being written is carried along with the thread's end once it has
                // filled the room opened for the send, so the newest line stays in view —
                // while the person has left the thread at its end, and never fighting a
                // thumb that took it away from there. `busy` rather than the last row's own
                // flag: a steer puts the person's message after the answer being written,
                // and the reply still grows where it began.
                if following, model.busy, placed, room <= 1 {
                    proxy.scrollTo(Self.threadEnd, anchor: .bottom)
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.containerSize.height
            } action: { _, height in
                boxHeight = height
                // While the keyboard is up for typing, the box is temporarily shorter by
                // the keyboard's height; a send drops the keyboard at once, so keeping the
                // full height means the room is already sized for the open screen the
                // message is landing on. If the box grows further as the keyboard finishes
                // clearing, the room grows with it without re-triggering the scroll animation
                // on every frame.
                guard (!composing && placed) || height > threadHeight else { return }
                threadHeight = height
                sizeRoom(proxy)
            }
            // The person's own move, read off the platform's phase rather than guessed at
            // from the thread's distance to its end: the reply's growth moves that distance
            // too, and the two cannot be told apart by it. A thread in the person's hand is
            // theirs until they settle it, and where they settle it is where the following
            // starts again.
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .tracking, .interacting, .decelerating:
                    moving = true
                    following = false
                    placed = true
                case .idle:
                    moving = false
                    following = atEnd
                case .animating:
                    break
                }
            }
            // A send puts the person's own words at the top of the thread, never at its end:
            // the keyboard goes down with the send, and the room it was taking is where the
            // answer writes itself. The scroll waits for that room to measure itself — the room
            // is only known once the words are in — and settles once the scroll view has laid
            // that room out.
            .onChange(of: model.messages.last?.id) { _, _ in
                guard let words = model.messages.last, words.isUser else { return }
                let id = words.id
                if composing { composing = false }
                armSend(id)
                // In a long thread where the person was reading back, the new row lands below
                // the visible window where a lazy stack will not measure it until the scroll
                // brings it into view.
                Task { @MainActor in
                    if sent == id, sentTop == nil {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
            // A session opens on its own content. The thread is emptied before the daemon
            // replays, and a scroll left where the old thread was leaves the empty state
            // outside the visible region — where a lazy stack draws nothing, so the screen
            // comes out blank. Putting the scroll back on it makes the welcome appear every
            // time, and a thread with words in it takes over from there as it grows.
            .onChange(of: model.sessionId) { oldId, id in
                // When the handshake assigns the id to a fresh session the person has already
                // sent a first message into, leave that message's scroll state intact.
                if oldId.isEmpty, !model.messages.isEmpty, !model.openedFromNotice {
                    return
                }
                // The room is measured off the last message, and the last message is the one
                // session's; the next thread measures its own before the room means anything.
                bare = 0
                sentTop = nil
                sent = nil
                placed = true
                if room != 1 { room = 1 }
                // A different thread: whether its reply is followed is left to the end this
                // one opens at, read off the scroll as usual, rather than carried over from
                // the thread left behind.
                following = false
                // A session opened from a reply's notice lands on its end: the answer is what
                // the person came to read, and the thread's top is the conversation's first
                // turn. Every other open still starts where the thread hangs from — an empty
                // id is the socket forgetting its session before the next one answers, and
                // there is no thread to land on yet.
                if model.openedFromNotice, !id.isEmpty {
                    model.openedFromNotice = false
                    // Landed one turn of the run loop later: the thread's rows come into
                    // being with the very change this is answering, and a lazy stack cannot
                    // be pointed at a row it has not drawn yet.
                    Task { @MainActor in proxy.scrollTo(Self.threadEnd, anchor: .bottom) }
                } else {
                    proxy.scrollTo(Self.threadTop, anchor: .top)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                topbar
                    // How tall the bar came out, so the line under it knows where it starts.
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { _, height in
                        topbarHeight = height
                    }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottom(proxy) }
            // The line floats over the thread, under the bar: it takes no room from what is
            // being read, and comes and goes as a fade rather than a jump.
            .overlay(alignment: .top) { noteToast }
            .animation(.smooth(duration: 0.22), value: model.note)
        }
    }

    /// The end of the thread, as an id the scroll view answers to.
    private static let threadEnd = "thread-end"
    /// The thread's own space, for measuring where a message sits in it.
    private static let threadSpace = "thread-space"
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

    /// Sizes the room beneath the thread so the message a send just put in can sit at the
    /// top, and scrolls that message there once the scroll view has laid the room out.
    private func sizeRoom(_ proxy: ScrollViewProxy) {
        guard let sent else {
            if room != 1 { room = 1 }
            return
        }
        guard let sentTop, bare > sentTop, threadHeight > 0 else { return }
        let next = max(1, sentTop + threadHeight - bare)
        if abs(next - room) > 0.5 {
            room = next
        } else if !placed {
            placed = true
            withAnimation(.smooth(duration: 0.35)) { proxy.scrollTo(sent, anchor: .top) }
        }
    }

    private var topbar: some View {
        VStack(spacing: MiloTheme.Space.one) {
            // Two layers, not three items: the controls keep the places this platform gives them
            // and the name takes the middle, the way a title does — the browser's own bar reads
            // it that way, with the same share of the screen for it. A name is as long as it
            // comes, and a spacer either side of it would be pushed about by whatever else the
            // bar is carrying that day.
            ZStack {
                // Where this session works, said on a session that has not written anything yet
                // too: which folder the work happens in is a fact of the session, not of its
                // words. A project whose folder has gone says so rather than reading as workable.
                if let project = model.sessionProject {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "folder")
                            .font(.system(size: 13, weight: .semibold))
                        Text(project.name)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .foregroundStyle(project.error == nil ? MiloTheme.foreground : MiloTheme.danger)
                    .frame(maxWidth: min(screenWidth * 0.6, 320))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(project.error == nil ? "Project: \(project.name)" : "Project: \(project.name), \(project.error ?? "")")
                    // Read, not pressed: the controls over it are what the bar is for, and the
                    // name is not a control.
                    .allowsHitTesting(false)
                }

                HStack(spacing: MiloTheme.Space.three) {
                    // The platform's own glass button: it takes the tap itself, so the
                    // swipe on the screen cannot swallow it. The routines screen offers the
                    // same control over its own top, so the way back to the sessions is one
                    // press away on either screen — see `SessionsButton`.
                    SessionsButton(action: openDrawer)

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

                    // The panel's own way back, offered only where there is something on it: a
                    // control that opens an empty pane is one that promises what it cannot do. The
                    // browser's topbar control, for the browser's own reason — and at the bar's
                    // trailing end, the side the panel itself comes in from, so the control sits
                    // where the thing it opens does.
                    if model.panel?.tabs.isEmpty == false {
                        Button { model.panelOpen.toggle() } label: {
                            Image(systemName: "sidebar.right")
                                .font(.system(size: 19, weight: .semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .controlSize(.regular)
                        .tint(MiloTheme.foreground)
                        .accessibilityLabel(model.panelOpen ? "Hide the panel" : "Show the panel")
                    }
                }
                .frame(minHeight: 46)
            }
            ConnectionPill()
        }
        .padding(.horizontal, MiloTheme.margin)
        .padding(.bottom, MiloTheme.Space.two)
        // The line comes and goes as a fade rather than a jump, the way the notice over the
        // thread does: the two are the same kind of thing, a state said once and then gone.
        .animation(.smooth(duration: 0.22), value: model.connectionLine)
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

    /// What just happened, floated under the top bar and worn in the platform's own glass —
    /// the material every control here is made of — so the line reads as part of the surface
    /// rather than a bare sentence on the page. It is as wide as its own words need and no
    /// wider: a two-word confirmation is a small bubble, and a long line grows the bubble with
    /// it, held between the thread's own margins.
    @ViewBuilder private var noteToast: some View {
        if let note = model.note {
            // The two spacers are what make the bubble take only its own width — a short line a
            // small bubble, a long one wrapping against the margin — and hold it centred, the
            // same shape the person's own message is given.
            HStack(spacing: 0) {
                Spacer(minLength: MiloTheme.margin)
                HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                    Image(systemName: note.failed ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(note.failed ? MiloTheme.danger : MiloTheme.success)
                    Text(note.text)
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(note.failed ? MiloTheme.danger : MiloTheme.foreground)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        model.dismissNote()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                            .frame(width: 26, height: 26)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Dismiss")
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.vertical, MiloTheme.Space.three)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
                Spacer(minLength: MiloTheme.margin)
            }
            .padding(.top, topbarHeight + MiloTheme.Space.two)
            .transition(.opacity)
            // A notice is not a thing to keep: it says what just happened and then gets out of
            // the way, an error holding longer because it is the one worth reading. The same
            // life the browser's own notice keeps.
            .task(id: note) {
                try? await Task.sleep(for: .seconds(note.failed ? 9 : 5))
                model.dismissNote()
            }
        }
    }

    private func bottom(_ proxy: ScrollViewProxy) -> some View {
        VStack(spacing: MiloTheme.Space.two) {
            if let pending = model.pending {
                PermissionBar(pending: pending)
            }
            Composer(
                draft: $draft,
                quote: $quote,
                drafts: $drafts,
                editing: $editing,
                focused: $composing,
                menu: $menu,
                send: send,
                // A session in a project is a work session: its composer carries the model
                // on the bar, and an ordinary chat keeps it in the `+` panel.
                work: model.sessionProject != nil,
                onModel: {
                    closeMenu()
                    picker = true
                }
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
    /// Whether the card is answering a swipe in the touch now on it. The platform hands a
    /// drag and a press to the same touch at once, so a line the finger crossed on its way
    /// would take the lift for a press of its own; the card's own claim is what says it was
    /// a swipe and the line goes unanswered — the row is wide, and the finger never leaves it.
    let claimed: Bool
    @Environment(AppModel.self) private var model

    /// The heading, and the lines under it: what the screen is, then the ways in. The
    /// lines are the browser's own set — the last conversation and the ideas the model
    /// drew — drawn the way this platform lists a choice: an icon and its words on a
    /// plain row, no card and nothing drawn around it, so the accent stays on the
    /// pointer and not on the surface.
    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("What's on your mind?")
                .font(MiloTheme.Text.title)
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
    /// one quiet grey — a tone down from the platform's own secondary — so the row reads
    /// as a way in rather than as the answer.
    private func line(_ suggestion: Suggestion) -> some View {
        Button {
            press(suggestion)
        } label: {
            HStack(spacing: MiloTheme.Space.three) {
                Image(systemName: suggestion.symbol)
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(MiloTheme.muted2)
                    .frame(width: 28, alignment: .center)
                Text(suggestion.title)
                    .font(MiloTheme.Text.body)
                    .foregroundStyle(MiloTheme.muted2)
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
        // A lift the card has claimed was the end of a swipe, not a press of this line.
        guard !claimed else { return }
        switch suggestion.act {
        case .send(let prompt): withAnimation(SettlesIn.motion) { model.send(prompt) }
        case .resume(let id): Task { await model.resume(id) }
        }
    }
}
