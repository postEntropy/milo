import SwiftUI
import UIKit

/// Anything landing in the thread coming in: it rises a little and clears as it lands. The
/// browser's own entrance for what appears there — a message, a call line, a to-do card, the
/// wait line — at the duration the browser gives them, so an arrival is drawn the same way on
/// both surfaces.
///
/// The entrance belongs to the transaction the thing arrives in and not to the row: what a turn
/// writes mid-stream is `StreamingText`'s to draw, line by line, and a thread replayed from a
/// stored session — where every row lands in one update and nothing is animated — is simply
/// there.
struct SettlesIn: Transition {
    /// How long it takes: the browser's own 380ms for something coming in.
    static let motion: Animation = .smooth(duration: 0.38)

    func body(content: Content, phase: TransitionPhase) -> some View {
        content
            .opacity(phase.isIdentity ? 1 : 0)
            .blur(radius: phase.isIdentity ? 0 : 6)
            .offset(y: phase.isIdentity ? 0 : 12)
    }
}

/// One thread giving way to another: the words a session is opened from cross-fade with the
/// ones the handshake brought, rising a little as they land. Slower and quieter than
/// `SettlesIn` — this is a whole conversation arriving at once, not a message into one.
struct ThreadSwap: Transition {
    func body(content: Content, phase: TransitionPhase) -> some View {
        content
            .opacity(phase.isIdentity ? 1 : 0)
            .offset(y: phase.isIdentity ? 0 : 8)
    }
}

struct MessageRow: View, Equatable {
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
    var onRestore: (AppModel.Message) -> Void = { _ in }
    /// A message read back rather than spoken to — a routine's run. The controls that
    /// answer it (quote, ask again, fork) are left off, so a past run is read, not acted on.
    var readOnly = false
    /// Which of the answer's pieces this row draws, when a settled turn is too long to be
    /// one row — see `chunk`. Nil is the whole message, the way every other screen draws it.
    var groups: Range<Int>? = nil
    /// Whether this row carries the message's own head — what signs it, and its thinking —
    /// and the foot a finished answer offers. The rows a long turn is cut into carry neither:
    /// the first keeps the head, the last keeps the foot.
    var head = true
    var foot = true
    /// A whole-message quote is useful on an earlier answer; the latest one is already in context.
    var canQuoteMessage = true
    @Environment(AppModel.self) private var model

    nonisolated static func == (lhs: MessageRow, rhs: MessageRow) -> Bool {
        lhs.message == rhs.message
            && lhs.turn == rhs.turn
            && lhs.regenerate?.prompt == rhs.regenerate?.prompt
            && lhs.regenerate?.upToTurn == rhs.regenerate?.upToTurn
            && lhs.readOnly == rhs.readOnly
            && lhs.groups == rhs.groups
            && lhs.head == rhs.head
            && lhs.foot == rhs.foot
            && lhs.canQuoteMessage == rhs.canQuoteMessage
    }

    /// The answer's thinking, when it thought at all. Read off the parts rather than the
    /// turn's own clock, so a thought read back from a session still has its line and its
    /// block — the clock is only known for the turn this app watched.
    private var reasoning: String? {
        let said = message.parts.compactMap { part -> String? in
            if case .reasoning(let text) = part { return text }
            return nil
        }
        return said.isEmpty ? nil : said.joined(separator: "\n\n")
    }

    /// The answer's parts as they are drawn: a run of consecutive calls is one chain,
    /// and everything else stands on its own. A turn's work arrives as those runs, so
    /// this is where the screen decides how much of it is worth its height.
    ///
    /// What a part draws decides whether it breaks the run: thinking is not on the screen
    /// — it is the line above the answer, and the whole of it behind that press — so a
    /// call either side of it is still one piece of work, and a chain of four does not
    /// come out as two with two strangers.
    ///
    /// The browser differs here on purpose, and this is not the copy drifting: it draws the
    /// thought in the flow, so a thought between two calls ends the run there
    /// (`web/src/chat/tool-runs.ts`). Same rule, over two drawings that put the thought in
    /// different places.
    private var drawn: [Drawn] { Self.drawn(of: message) }

    /// How many pieces an answer draws: one per run of consecutive calls and one per other
    /// part. A settled turn longer than `chunk` is drawn as several rows of these pieces, so
    /// a thread opens and scrolls without laying out the whole of every long answer at once.
    static func pieceCount(of message: AppModel.Message) -> Int {
        var count = 0
        var inToolRun = false
        for part in message.parts {
            switch part {
            case .reasoning, .other:
                continue
            case .tool:
                if !inToolRun {
                    count += 1
                    inToolRun = true
                }
            case .text, .todo, .ui, .verification:
                count += 1
                inToolRun = false
            }
        }
        return count
    }

    /// How many pieces one row may hold. Two of them are a screenful of prose: the rest of a
    /// long turn is only built as it comes into reach, so entering the thread costs what is
    /// on the screen rather than the whole of every answer.
    static let chunk = 2

    private static func drawn(of message: AppModel.Message) -> [Drawn] {
        var out: [Drawn] = []
        for part in message.parts {
            switch part {
            case .reasoning, .other:
                continue
            case .tool(let call):
                if case .calls(var earlier)? = out.last {
                    out[out.count - 1] = .calls([])
                    earlier.append(call)
                    out[out.count - 1] = .calls(earlier)
                } else {
                    out.append(.calls([call]))
                }
            case .text, .todo, .ui, .verification:
                out.append(.one(part))
            }
        }
        return out
    }

    /// The pieces this row draws: the whole answer, or the stretch of it this row holds.
    private var groupsToDraw: [(offset: Int, element: Drawn)] {
        let all = Array(drawn.enumerated())
        guard let groups else { return all }
        return all.filter { groups.contains($0.offset) }
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
                        Prose(text: message.prose, color: MiloTheme.userBubbleText)
                    }
                    // Guarded like the assistant side: an empty `Attachments` is still a
                    // child, and the stack's spacing would show up as a chin under the text.
                    // The files still in hand are drawn first, then whatever the daemon
                    // delivered — a message carries one or the other.
                    if !message.drafts.isEmpty {
                        DraftAttachments(items: message.drafts)
                    }
                    if !message.attachments.isEmpty {
                        Attachments(items: message.attachments)
                    }
                    if let status = message.status {
                        Text(status).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.userBubbleText)
                    }
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.vertical, MiloTheme.Space.three)
                .background(MiloTheme.accent, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
                .contextMenu { menu }
            }
        } else {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                if head, let bot = message.bot {
                    let liveBot = model.crewBots.first(where: { $0.id == bot.id })
                    let displayName = liveBot?.name ?? bot.name
                    let displayHandle = liveBot?.handle ?? bot.handle
                    HStack(spacing: MiloTheme.Space.two) {
                        CrewBotAvatar(
                            avatar: CrewAvatarModel.resolved(wire: liveBot?.avatar ?? bot.avatar, id: bot.id, name: displayName),
                            state: message.streaming ? "running" : nil,
                            size: 32,
                            animated: message.streaming
                        )
                        Text(displayName)
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                        if let handle = displayHandle, !handle.isEmpty {
                            Text("@\(handle)")
                                .font(MiloTheme.Text.meta.monospaced())
                                .foregroundStyle(MiloTheme.muted)
                                .lineLimit(1)
                        }
                    }
                }
                // A routine's delivery signs itself: the routine it came from and when
                // it landed, over the answer. A message nobody in this chat asked for
                // does not read as the reply to what the person just said.
                if head, let routine = message.routine {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "repeat")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                        Text(routine.name)
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if routine.failed == true {
                            Text("failed")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .foregroundStyle(MiloTheme.danger)
                        }
                        Spacer(minLength: MiloTheme.Space.two)
                        Text(RelativeTime.when(routine.at))
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                // The line is the handle to the thought: it stands when there is one to open,
                // and not otherwise. A "Thought for Xs" that answers a press with nothing is a
                // promise the turn cannot keep.
                if head, let reasoning {
                    Reasoning(text: reasoning, seconds: message.thought)
                }
                // A `/sessions` answer is its cards: the words the command replied with are
                // the same list in text, and drawing both would say it twice. The parts and
                // the toolbar step aside for them, as the browser's own do.
                if let cards = message.cards, !cards.isEmpty {
                    SessionCards(cards: cards)
                } else {
                    ForEach(groupsToDraw, id: \.offset) { _, group in
                        // What appears in an answer settles in as it lands — a call, a
                        // to-do list, a widget, the paragraph after a call — which is the
                        // browser's own entrance for those same pieces.
                        Group {
                            switch group {
                            case .calls(let calls):
                                ToolChain(calls: calls)
                            case .one(let part):
                                PartView(part: part, onQuote: onQuote, isStreaming: message.streaming)
                            }
                        }
                        .transition(SettlesIn())
                    }
                    if foot, !message.attachments.isEmpty {
                        Attachments(items: message.attachments)
                    }
                    // The wait for the model's next output or provider-signaled reasoning,
                    // wherever it falls. A widget being drawn is the work showing itself,
                    // which is why the browser leaves its own line off while one is.
                    if foot, !drawingADraft {
                        if message.waitPhase == .thinking {
                            WaitLine(label: "Thinking", icon: "lightbulb.max.fill", dots: false)
                        } else if message.waitPhase == .waitingResponse {
                            WaitLine(label: "Waiting for response", dots: true)
                        }
                    }
                    if foot, let error = message.error {
                        Text(error)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.danger)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.two)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                    } else if foot, let status = message.status {
                        Text(status)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    // The controls the browser draws under an answer. A turn still being
                    // written has nothing to act on yet, and a message with no words has
                    // nothing to copy. A routine's delivery is not a turn: there is
                    // nothing here to quote, fork or ask again.
                    if foot, !message.streaming, !message.prose.isEmpty, message.routine == nil {
                        MessageToolbar(message: message, turn: turn, regenerate: regenerate, onQuote: onQuote, readOnly: readOnly, canQuoteMessage: canQuoteMessage)
                    }
                }
                // The buttons a command drew, under its cards or its words: the pages of
                // `/sessions`, and anything else the daemon offers there.
                if foot, let actions = message.actions, !actions.isEmpty {
                    ActionRows(rows: actions, messageId: message.id.uuidString)
                }
            }
            // A routine's delivery is one filled block, the way the browser draws it —
            // the plan and the gate wear the same surface, never an outline.
            .padding(message.routine == nil ? 0 : MiloTheme.Space.four)
            .background(
                message.routine == nil ? Color.clear : MiloTheme.surface,
                in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg)
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            // A piece of the answer appearing — a call, a to-do list, a widget — is what
            // animates here, told from the number of parts. Words growing inside a piece are
            // not: those fade in line by line where they are drawn.
            .animation(SettlesIn.motion, value: message.parts.count)
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
        if let id = message.deliveryId, message.status != "Sending…", message.status != "Queued" {
            menuItem("Restore", "arrow.uturn.backward") { onRestore(message) }
            menuItem("Dismiss", "xmark") { model.dismissDelivery(id) }
        }
        // The words back in the composer and said again: the session forks before them, so
        // the edit replaces the message instead of following it. Not while a turn runs —
        // it would fork mid-answer.
        if message.deliveryId == nil {
            menuItem("Edit", "pencil", disabled: model.busy) { onEdit(message.prose, turn - 1) }
        }
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
    /// A message read back rather than answered: only Copy is offered.
    var readOnly = false
    var canQuoteMessage = true
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
            if !readOnly, canQuoteMessage {
                control("text.quote", label: "Quote") { onQuote(message.prose) }
            }
            if let regenerate {
                control("arrow.clockwise", label: "Ask this again", disabled: model.busy) {
                    Task { await model.regenerate(prompt: regenerate.prompt, upToTurn: regenerate.upToTurn) }
                }
            }
            // Only where it holds something: an answer read back from the transcript
            // carries neither its cost nor its raw copy, and dots over an empty menu
            // are a control that promises what it cannot do.
            if !readOnly, message.tokens != nil || message.raw != nil {
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
                        Picture(url: url, alt: item.name)
                    } else {
                        Link(destination: url) {
                            HStack(spacing: MiloTheme.Space.two) {
                                Image(systemName: "doc")
                                Text(item.name).lineLimit(1)
                                Spacer(minLength: MiloTheme.Space.two)
                                Text(Self.bytes(item.size))
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

    /// A file's size, read the same way for the file the daemon delivered into the chat and
    /// the one still in hand: the same fact on screen gets one reading of it.
    static func bytes(_ count: Int) -> String {
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
        case .verification(let text, let ok):
            VerificationRow(text: text, ok: ok)
        case .ui(let widget, _):
            // A widget's button speaks the same way the composer does, so the message
            // it builds lands in the conversation as an ordinary turn.
            GenUiView(widget: widget) { words in
                withAnimation(SettlesIn.motion) { model.send(words) }
            }
        case .tool, .reasoning, .other:
            EmptyView()
        }
    }
}

/**
 What the model thought, under the answer it belongs to: the line saying how long it took,
 and the reasoning itself. Folded it is one quiet line, open it is the thought, and the
 press is what decides.

 Unlike a chain of calls, the display in Settings is the rule here rather than a starting
 point: a change to it reaches every thought on screen, including one opened by hand. And
 the line stands whenever there is a thought to read — a session read back has no clock to
 say how long it took, and still gets a line that opens it.
 */
struct Reasoning: View {
    let text: String
    /// How long the turn took, when this app watched it. Absent for a thought read back.
    let seconds: Double?
    @Environment(AppModel.self) private var model
    /// Nothing until the person touches it; the display answers until then.
    @State private var toggled: Bool?

    private var open: Bool { toggled ?? (model.thinking == "expanded") }

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { toggled = !open }
            } label: {
                Text(label)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                    // The whole line answers the press, not only the words on it.
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(open ? "Hide thinking" : "Show thinking")

            if open {
                Text(text)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                    .textSelection(.enabled)
            }
        }
        // The display is the rule, not a starting point: when it changes, this thought —
        // and every other — follows it, including one the person opened by hand.
        .onChange(of: model.thinking) { _, _ in toggled = nil }
    }

    /// How long it thought, when the clock is known and worth saying — the thought's own
    /// name otherwise, the same rule the browser's own label follows.
    private var label: String {
        guard let seconds, seconds >= 1 else { return "Thought" }
        return "Thought for \(Int(seconds.rounded()))s"
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
        // The sweep handing over to the settled count, drawn rather than swapped.
        .animation(.easeInOut(duration: 0.22), value: running)
    }
}

/// One tool call: the tool's mark says what it was and carries the state, the name carries
/// the colour and the one value worth showing stays quiet beside it. The call itself is the
/// control where there is something under it — a press opens what it came back with, whole,
/// and no line of its own stands between the call and the answer.
struct ToolRow: View {
    let tool: ToolMark
    @Environment(AppModel.self) private var model
    @State private var showingResult = false
    @State private var showingDrawer = false

    var body: some View {
        let bot = taskBotInfo
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            if canOpen {
                Button {
                    if bot != nil {
                        showingDrawer = true
                    } else {
                        withAnimation(.easeInOut(duration: 0.22)) { showingResult.toggle() }
                    }
                } label: {
                    header
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel(bot != nil ? detailLabel : (showingResult ? detailHiddenLabel : detailLabel))

                if bot == nil && showingResult {
                    Group {
                        if let change = tool.change, !change.isEmpty {
                            changeBody(change)
                        } else {
                            toolDetailBody(input: tool.input, output: tool.result)
                        }
                    }
                    .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.22)) { showingResult = false }
                    }
                    if let preview = tool.preview {
                        ToolPreviewView(preview: preview, callId: tool.callId)
                    }
                }
            } else {
                header
            }
        }
        // A call changing state — running to kept, or to failed — is drawn as a change and not
        // a swap: the mark's colour, and the sweep handing over to the settled line.
        .animation(.easeInOut(duration: 0.22), value: tool.state)
        .sheet(isPresented: $showingDrawer) {
            if let bot = taskBotInfo {
                TaskBotDetailSheet(
                    tool: tool,
                    botAvatar: bot.avatar,
                    botName: bot.name,
                    subtitle: taskSubtitle(botName: bot.name)
                )
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        if let bot = taskBotInfo {
            taskBotCard(avatar: bot.avatar, name: bot.name)
        } else {
            line
        }
    }

    private func taskBotCard(avatar: CrewAvatarModel, name botName: String) -> some View {
        let subtitle = taskSubtitle(botName: botName)
        return HStack(alignment: subtitle.isEmpty ? .center : .top, spacing: MiloTheme.Space.three) {
            CrewBotAvatar(avatar: avatar, state: tool.state, size: 28, animated: running)
                .padding(.top, subtitle.isEmpty ? 0 : 1)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: MiloTheme.Space.two) {
                    if running && subtitle.isEmpty {
                        Glare(text: botName, font: MiloTheme.Text.base.weight(.semibold), tone: MiloTheme.foreground)
                            .lineLimit(1)
                    } else {
                        Text(botName)
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.foreground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    Spacer(minLength: MiloTheme.Space.two)

                    if failed {
                        Text("failed")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.danger)
                    }
                    if canOpen {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(MiloTheme.mutedStrong)
                    }
                }

                if !subtitle.isEmpty {
                    if running {
                        Glare(text: subtitle, font: MiloTheme.Text.small, tone: MiloTheme.mutedStrong)
                            .lineLimit(2)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(subtitle)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.mutedStrong)
                            .lineLimit(2)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.vertical, MiloTheme.Space.three)
        .frame(maxWidth: .infinity, alignment: .leading)
        .miloGlassCard(radius: MiloTheme.Radius.lg, interactive: canOpen)
        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }

    private var line: some View {
        HStack(alignment: .center, spacing: MiloTheme.Space.two) {
            // The mark is the state: quiet at rest, accent for the call running now, red
            // on a failure — and the word beside it says the failure for whoever cannot
            // see the colour.
            if let bot = taskBotInfo {
                CrewBotAvatar(avatar: bot.avatar, state: tool.state, size: 24, animated: running)
            } else if tool.name == "crew" || tool.name == "delegated_work" {
                CrewDrawerMark()
                    .foregroundStyle(state)
            } else {
                Image(systemName: ToolIcons.symbol(tool.name))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(state)
            }
            // A call in flight is one swept line — the name and its value as the server
            // drew them, lit together, which is the browser's own treatment. Settled, the
            // whole line is drawn in the quiet tone, the mark being what carries the
            // state: it sits in the answer's own text, and the grey is what sets it
            // apart from it.
            if running {
                Glare(text: wholeLine, font: MiloTheme.Text.body)
                    .lineLimit(1)
            } else {
                HStack(spacing: 0) {
                    Text(value.isEmpty ? name : "\(name) ")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !value.isEmpty {
                        Text(value)
                            .font(MiloTheme.Text.body)
                            .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.muted)
                            .lineLimit(1)
                            .truncationMode(value.contains("/") ? .middle : .tail)
                    }
                }
                // How much the call moved, in the same two tones the Work screen counts a
                // folder's changes with: read on the line, before the fold is opened.
                if totals.additions > 0 || totals.deletions > 0 {
                    HStack(spacing: MiloTheme.Space.one) {
                        if totals.additions > 0 {
                            Text("+\(totals.additions)").foregroundStyle(MiloTheme.success)
                        }
                        if totals.deletions > 0 {
                            Text("−\(totals.deletions)").foregroundStyle(MiloTheme.danger)
                        }
                    }
                    .font(MiloTheme.Text.meta.monospacedDigit())
                }
            }
            if failed {
                Text("failed").font(MiloTheme.Text.meta).foregroundStyle(MiloTheme.danger)
            }
        }
    }

    /// The lines the call changed, once it is pressed: marked the way the Work screen marks
    /// a folder's changes — added green, removed red, both numbers in the gutter — so what
    /// the call did is read here rather than inferred from the sentence it returned.
    private func changeBody(_ files: [FileChange]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        if files.count > 1 {
                            Text(file.path + (file.created == true ? " (new)" : file.deleted == true ? " (deleted)" : ""))
                                .font(MiloTheme.Text.meta)
                                .foregroundStyle(MiloTheme.mutedStrong)
                        }
                        ForEach(Array(file.lines.enumerated()), id: \.offset) { _, line in
                            HStack(spacing: MiloTheme.Space.two) {
                                Text(line.old.map(String.init) ?? "")
                                    .frame(width: 26, alignment: .trailing)
                                    .foregroundStyle(MiloTheme.mutedStrong)
                                Text(line.new.map(String.init) ?? "")
                                    .frame(width: 26, alignment: .trailing)
                                    .foregroundStyle(MiloTheme.mutedStrong)
                                Text(line.kind == "add" ? "+" : line.kind == "remove" ? "−" : " ")
                                    .foregroundStyle(line.kind == "add"
                                        ? MiloTheme.success
                                        : line.kind == "remove" ? MiloTheme.danger : MiloTheme.mutedStrong)
                                Text(line.text.isEmpty ? " " : line.text)
                                    .foregroundStyle(MiloTheme.foreground2)
                            }
                            .font(MiloTheme.Text.mono)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(line.kind == "add"
                                ? MiloTheme.success.opacity(0.18)
                                : line.kind == "remove" ? MiloTheme.danger.opacity(0.15) : Color.clear)
                        }
                        if file.truncated == true {
                            Text("…").font(MiloTheme.Text.mono).foregroundStyle(MiloTheme.mutedStrong)
                        }
                    }
                }
            }
            .padding(MiloTheme.Space.three)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .miloGlassCard(radius: MiloTheme.Radius.md)
        .marksSidewaysDrag()
        .padding(.leading, 22)
    }

    /// The call's input and output share one full-width transcript, with the output quiet.
    private func toolDetailBody(input: String?, output: String?) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            if let input, !input.isEmpty {
                Text(isShellCommand ? "$ \(input)" : input)
                    .foregroundStyle(MiloTheme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let output, !output.isEmpty {
                Text(output)
                    .foregroundStyle(MiloTheme.mutedStrong)
                    .fixedSize(horizontal: false, vertical: true)
            } else if running {
                Text("Tool is still running.")
                    .foregroundStyle(MiloTheme.mutedStrong)
            } else if input == nil || input?.isEmpty == true {
                Text("No output is available.")
                    .foregroundStyle(MiloTheme.mutedStrong)
            }
        }
        .font(MiloTheme.Text.mono)
        .textSelection(.enabled)
        .padding(MiloTheme.Space.three)
        .frame(maxWidth: .infinity, alignment: .leading)
        .miloGlassCard(radius: MiloTheme.Radius.md)
        .marksSidewaysDrag()
    }

    private var isShellCommand: Bool { tool.name == "shell_command" }

    private func readInputField(_ key: String) -> String? {
        guard let input = tool.input, !input.isEmpty else { return nil }
        for line in input.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("\(key):") {
                let value = trimmed.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces)
                if !value.isEmpty { return value }
            }
        }
        return nil
    }

    private func resolveTaskBot(id explicitId: String?, name rawName: String) -> (avatar: CrewAvatarModel, name: String) {
        let trimmedId = explicitId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = (trimmedId?.isEmpty == false) ? trimmedId : nil
        if let id, let matched = model.crewBots.first(where: { $0.id == id }) {
            return (CrewAvatarModel.resolved(wire: matched.avatar, id: matched.id, name: matched.name), matched.name)
        }
        let target = rawName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedHandle = target.hasPrefix("@") ? String(target.drop(while: { $0 == "@" })) : target
        if let matched = model.crewBots.first(where: {
            $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == target
        }) ?? model.crewBots.first(where: {
            guard let handle = $0.handle else { return false }
            return handle.lowercased() == normalizedHandle
        }) {
            return (CrewAvatarModel.resolved(wire: matched.avatar, id: matched.id, name: matched.name), matched.name)
        }
        return (.fromSeed(id: id ?? rawName, name: rawName), rawName)
    }

    private var taskBotInfo: (avatar: CrewAvatarModel, name: String)? {
        guard tool.name == "task" else { return nil }
        let inputBotId = readInputField("botId")
        if let result = tool.result, result.hasPrefix("Crew bot ") {
            let rest = String(result.dropFirst(9))
            let header = rest.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? rest
            for suffix in [":", " was stopped."] {
                if let range = header.range(of: suffix, options: .backwards) ?? (header.hasSuffix(" was stopped") ? header.range(of: " was stopped", options: .backwards) : nil) {
                    let prefix = String(header[..<range.lowerBound])
                    if let open = prefix.lastIndex(of: "("),
                       let close = prefix.lastIndex(of: ")"),
                       open < close,
                       close == prefix.index(before: prefix.endIndex) {
                        let botName = String(prefix[..<open]).trimmingCharacters(in: .whitespaces)
                        let botId = String(prefix[prefix.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
                        if !botName.isEmpty { return resolveTaskBot(id: botId.isEmpty ? inputBotId : botId, name: botName) }
                    }
                    let botName = prefix.trimmingCharacters(in: .whitespaces)
                    if !botName.isEmpty { return resolveTaskBot(id: inputBotId, name: botName) }
                }
            }
        }
        if let inputName = readInputField("name") {
            return resolveTaskBot(id: inputBotId, name: inputName)
        }
        let stripped = tool.text.replacingOccurrences(of: "^Task\\s+", with: "", options: .regularExpression)
        let botName = stripped.components(separatedBy: " · ").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return botName.isEmpty ? nil : resolveTaskBot(id: inputBotId, name: botName)
    }

    private func taskSubtitle(botName: String) -> String {
        let stripped = tool.text
            .replacingOccurrences(of: "^Task\\s+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let separator = stripped.range(of: " · ") {
            let after = String(stripped[separator.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !after.isEmpty { return after }
        }
        if !stripped.isEmpty, stripped.caseInsensitiveCompare(botName) != .orderedSame {
            return stripped
        }
        return readInputField("goal") ?? readInputField("task") ?? ""
    }

    /// Whether there is anything under the call to open: the lines it changed, or what it
    /// came back with. A call that wrote draws the change, because the sentence the tool
    /// returned about it says less than the lines do.
    private var hasDetail: Bool {
        if let input = tool.input, !input.isEmpty { return true }
        if let change = tool.change, !change.isEmpty { return true }
        if tool.preview != nil { return true }
        return !(tool.result?.isEmpty ?? true)
    }

    /// A running call can be opened before its result arrives; keep it open afterward
    /// so the result replaces the running message in place.
    private var canOpen: Bool { hasDetail || running || showingResult }

    private var detailLabel: String {
        tool.change?.isEmpty == false ? "Show the change" : "Show the tool result"
    }

    private var detailHiddenLabel: String {
        tool.change?.isEmpty == false ? "Hide the change" : "Hide the tool result"
    }

    private var totals: (additions: Int, deletions: Int) {
        var additions = 0
        var deletions = 0
        for file in tool.change ?? [] {
            additions += file.additions
            deletions += file.deletions
        }
        return (additions, deletions)
    }

    /// The whole line, for the sweep to travel along: the name and its value in one
    /// string, as the server drew it.
    private var wholeLine: String { tool.text.isEmpty ? ToolIcons.label(tool.name) : tool.text }

    /// The line the server drew is the display label and its value in one string;
    /// splitting on the display label keeps the verb intact when a long path truncates.
    private var name: String {
        let display = ToolIcons.label(tool.name)
        if tool.text.isEmpty { return display }
        if isShellCommand && tool.text != display { return tool.text }
        if tool.text == display || tool.text.hasPrefix("\(display) ") { return display }
        return tool.text
    }

    private var value: String {
        let display = ToolIcons.label(tool.name)
        if isShellCommand && tool.text != display { return "" }
        guard tool.text.hasPrefix("\(display) ") else { return "" }
        return String(tool.text.dropFirst(display.count + 1)).trimmingCharacters(in: .whitespaces)
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

/// Detail drawer for a delegated Crew bot/subagent task opened from a `ToolRow` card.
private struct TaskBotDetailSheet: View {
    let tool: ToolMark
    let botAvatar: CrewAvatarModel
    let botName: String
    let subtitle: String
    @Environment(\.dismiss) private var dismiss

    private var running: Bool { tool.state == "running" }
    private var failed: Bool { tool.state == "failed" }

    var body: some View {
        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
                HStack(alignment: .center, spacing: MiloTheme.Space.three) {
                    CrewBotAvatar(avatar: botAvatar, state: tool.state, size: 44, animated: running)
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text(botName)
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                        statusBadge
                    }
                    Spacer(minLength: MiloTheme.Space.two)
                    MiloIconButton(systemName: "xmark", size: 15, span: 38, glass: true) {
                        dismiss()
                    }
                    .accessibilityLabel("Close")
                }

                if let parsed = parsedInput {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        Text("Task")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.muted)
                            .padding(.horizontal, MiloTheme.Space.one)

                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            if let title = parsed.title {
                                Text(title)
                                    .font(MiloTheme.Text.body.weight(.semibold))
                                    .foregroundStyle(MiloTheme.foreground)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let prompt = parsed.prompt {
                                Prose(text: prompt)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if !parsed.extras.isEmpty {
                                VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                                    ForEach(Array(parsed.extras.enumerated()), id: \.offset) { _, extra in
                                        HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                                            Text(extra.key)
                                                .font(MiloTheme.Text.small.weight(.medium))
                                                .foregroundStyle(MiloTheme.muted)
                                            Text(extra.value)
                                                .font(MiloTheme.Text.small)
                                                .foregroundStyle(MiloTheme.mutedStrong)
                                                .textSelection(.enabled)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MiloTheme.Space.four)
                        .miloGlassCard(radius: MiloTheme.Radius.xl)
                    }
                } else if let taskPrompt = displayedTaskText {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        Text("Task")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.muted)
                            .padding(.horizontal, MiloTheme.Space.one)

                        Prose(text: taskPrompt)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(MiloTheme.Space.four)
                            .miloGlassCard(radius: MiloTheme.Radius.xl)
                    }
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    Text("Response")
                        .font(MiloTheme.Text.small.weight(.semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .padding(.horizontal, MiloTheme.Space.one)

                    Group {
                        if let output = cleanedOutput, !output.isEmpty {
                            Prose(text: output)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else if running {
                            Glare(text: "Working on this task…", font: MiloTheme.Text.body, tone: MiloTheme.mutedStrong)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("No output is available.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(MiloTheme.Space.four)
                    .miloGlassCard(radius: MiloTheme.Radius.xl)
                }

                if let preview = tool.preview {
                    ToolPreviewView(preview: preview, callId: tool.callId)
                }
            }
        }
    }

    private var statusBadge: some View {
        let tone = failed ? MiloTheme.danger : (running ? MiloTheme.accent : MiloTheme.success)
        let label = failed ? "Failed" : (running ? "Running" : "Completed")
        return HStack(spacing: MiloTheme.Space.one) {
            Circle()
                .fill(tone)
                .frame(width: 7, height: 7)
            Text(label)
                .font(MiloTheme.Text.small.weight(.semibold))
                .foregroundStyle(tone)
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.one)
        .background(tone.opacity(0.14), in: Capsule())
    }

    private struct ParsedTaskInput {
        var title: String?
        var prompt: String?
        var extras: [(key: String, value: String)]
    }

    private var parsedInput: ParsedTaskInput? {
        Self.parseTaskInput(tool.input, fallbackTitle: subtitle)
    }

    private static func parseTaskInput(_ raw: String?, fallbackTitle: String) -> ParsedTaskInput? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        var entries: [(key: String, value: String)] = []
        var currentKey: String?
        var currentLines: [String] = []

        func flush() {
            guard let key = currentKey else { return }
            let joined = currentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                entries.append((key: key, value: joined))
            }
            currentKey = nil
            currentLines = []
        }

        for line in raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let isIndented = line.hasPrefix(" ") || line.hasPrefix("\t")
            if !isIndented, let colon = line.firstIndex(of: ":") {
                let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
                let afterColon = String(line[line.index(after: colon)...])
                let validKey = !key.isEmpty && !key.contains(where: \.isWhitespace)
                let validValueSeparator = afterColon.isEmpty || afterColon.hasPrefix(" ")
                if validKey && validValueSeparator {
                    flush()
                    currentKey = key
                    let inlineValue = afterColon.trimmingCharacters(in: .whitespaces)
                    if !inlineValue.isEmpty {
                        currentLines.append(inlineValue)
                    }
                    continue
                }
            }
            if currentKey != nil {
                if line.hasPrefix("  ") {
                    currentLines.append(String(line.dropFirst(2)))
                } else {
                    currentLines.append(line)
                }
            }
        }
        flush()

        guard !entries.isEmpty else { return nil }
        let knownTaskKeys: Set<String> = ["name", "botId", "description", "prompt", "goal", "task"]
        guard entries.contains(where: { knownTaskKeys.contains($0.key) }) else {
            return nil
        }

        var map: [String: String] = [:]
        for entry in entries where map[entry.key] == nil {
            map[entry.key] = entry.value
        }

        let trimmedFallback = fallbackTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = map["description"] ?? (trimmedFallback.isEmpty ? nil : trimmedFallback)
        let prompt = map["prompt"] ?? map["goal"] ?? map["task"]
        let finalPrompt = (prompt != nil && prompt == title) ? nil : prompt
        let extras = entries.filter { !knownTaskKeys.contains($0.key) }
        if title == nil && finalPrompt == nil && extras.isEmpty {
            return nil
        }
        return ParsedTaskInput(title: title, prompt: finalPrompt, extras: extras)
    }

    private var displayedTaskText: String? {
        let rawInput = tool.input?.trimmingCharacters(in: .whitespacesAndNewlines)
        if !subtitle.isEmpty {
            if let rawInput, !rawInput.isEmpty, rawInput != subtitle, rawInput.count > subtitle.count {
                return rawInput
            }
            return subtitle
        }
        return rawInput?.isEmpty == false ? rawInput : nil
    }

    private var cleanedOutput: String? {
        guard let result = tool.result?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty else {
            return nil
        }
        // Strip the server's `Crew bot <Name> (<id>):` header line since the sheet header already identifies the bot.
        if result.hasPrefix("Crew bot "), let newline = result.firstIndex(of: "\n") {
            let firstLine = String(result[..<newline])
            if firstLine.hasSuffix(":") {
                let rest = String(result[result.index(after: newline)...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !rest.isEmpty { return rest }
            }
        }
        return result
    }
}

/// The project's checks, after a turn that wrote. One filled block, the verdict's
/// colour on the words — the same block the browser draws.
struct VerificationRow: View {
    let text: String
    let ok: Bool

    var body: some View {
        Text(text)
            .font(MiloTheme.Text.small)
            .foregroundStyle(ok ? MiloTheme.muted : MiloTheme.danger)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(MiloTheme.Space.four)
            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }
}

struct TodoRow: View {
    let items: [TodoItem]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let animate = !reduceMotion && scenePhase == .active
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                    Image(systemName: symbol(item.status))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(mark(item.status))
                        .symbolEffect(.rotate, options: .repeating, isActive: animate && item.status == "in_progress")
                    Text(item.content)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(item.status == "completed" ? MiloTheme.mutedStrong : MiloTheme.foreground)
                        .strikethrough(item.status == "completed", color: MiloTheme.mutedStrong)
                }
            }
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.vertical, MiloTheme.Space.three)
        .frame(maxWidth: .infinity, alignment: .leading)
        .miloGlassCard(radius: MiloTheme.Radius.lg)
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
        default: return MiloTheme.mutedStrong
        }
    }
}

/// Fetches an ephemeral desktop screenshot thumbnail only while its tool row is expanded.
private struct ToolPreviewView: View {
    let preview: ToolPreviewRef
    let callId: String?

    @Environment(AppModel.self) private var model
    @State private var state: LoadState = .loading

    private enum LoadState {
        case loading
        case ready(UIImage)
        case expired
        case decodeFailed
        case failed
    }

    var body: some View {
        Group {
            switch state {
            case .ready(let image):
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            case .expired:
                Text("Preview expired.")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            case .decodeFailed:
                Text("Could not decode preview image.")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            case .failed:
                Text("Preview unavailable.")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            case .loading:
                Text("Loading preview…")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            }
        }
        .task(id: preview.id) {
            await load()
        }
    }

    private func load() async {
        guard let callId, !callId.isEmpty else {
            state = .failed
            return
        }
        let result = await model.fetchToolPreview(id: preview.id, callId: callId)
        switch result {
        case .image(let data):
            if let image = UIImage(data: data) {
                state = .ready(image)
            } else {
                state = .decodeFailed
            }
        case .expired:
            state = .expired
        case .unavailable:
            state = .failed
        }
    }
}
