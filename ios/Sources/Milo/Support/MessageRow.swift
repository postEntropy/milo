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
    @Environment(AppModel.self) private var model

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
    static func pieceCount(of message: AppModel.Message) -> Int { drawn(of: message).count }

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
                if case .calls(let earlier)? = out.last {
                    out[out.count - 1] = .calls(earlier + [call])
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
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.vertical, MiloTheme.Space.three)
                .background(MiloTheme.accent, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            }
            .contextMenu { menu }
        } else {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
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
                    // The wait for the model's next output, wherever it falls: the line
                    // belongs to the turn's own state, not to the gap before its first
                    // words — so a turn thinking about a tool's result says so instead of
                    // going quiet. A widget being drawn is the work showing itself, which
                    // is why the browser leaves its own line off while one is.
                    if foot, message.waiting, !drawingADraft {
                        WaitLine()
                    }
                    if foot, let status = message.status {
                        Text(status)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    // The controls the browser draws under an answer. A turn still being
                    // written has nothing to act on yet, and a message with no words has
                    // nothing to copy. A routine's delivery is not a turn: there is
                    // nothing here to quote, fork or ask again.
                    if foot, !message.streaming, !message.prose.isEmpty, message.routine == nil {
                        MessageToolbar(message: message, turn: turn, regenerate: regenerate, onQuote: onQuote, readOnly: readOnly)
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
    /// A message read back rather than answered: only Copy is offered.
    var readOnly = false
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
            if !readOnly {
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
    @State private var showingResult = false

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            if canOpen {
                Button {
                    withAnimation(.easeInOut(duration: 0.22)) { showingResult.toggle() }
                } label: {
                    line
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel(showingResult ? detailHiddenLabel : detailLabel)

                if showingResult {
                    if let change = tool.change, !change.isEmpty {
                        changeBody(change)
                    } else if let result = tool.result, !result.isEmpty {
                        resultBody(result)
                    } else {
                        Text(running ? "Tool is still running." : "No output is available.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .padding(.leading, 22)
                            .accessibilityAddTraits(.isStaticText)
                    }
                }
            } else {
                line
            }
        }
        // A call changing state — running to kept, or to failed — is drawn as a change and not
        // a swap: the mark's colour, and the sweep handing over to the settled line.
        .animation(.easeInOut(duration: 0.22), value: tool.state)
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
                                .foregroundStyle(MiloTheme.muted)
                        }
                        ForEach(Array(file.lines.enumerated()), id: \.offset) { _, line in
                            HStack(spacing: MiloTheme.Space.two) {
                                Text(line.old.map(String.init) ?? "")
                                    .frame(width: 26, alignment: .trailing)
                                    .foregroundStyle(MiloTheme.muted)
                                Text(line.new.map(String.init) ?? "")
                                    .frame(width: 26, alignment: .trailing)
                                    .foregroundStyle(MiloTheme.muted)
                                Text(line.kind == "add" ? "+" : line.kind == "remove" ? "−" : " ")
                                    .foregroundStyle(line.kind == "add"
                                        ? MiloTheme.success
                                        : line.kind == "remove" ? MiloTheme.danger : MiloTheme.muted)
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
                            Text("…").font(MiloTheme.Text.mono).foregroundStyle(MiloTheme.muted)
                        }
                    }
                }
            }
            .padding(MiloTheme.Space.three)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .marksSidewaysDrag()
        .padding(.leading, 22)
    }

    /// What the call came back with, whole, once the call is pressed: set past the mark's
    /// own column so it lines up with the name it belongs to rather than with the mark.
    /// Capped on the server, so the whole record still lives in the turn's Copy raw.
    private func resultBody(_ result: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(result)
                .font(MiloTheme.Text.mono)
                .foregroundStyle(MiloTheme.foreground2)
                .textSelection(.enabled)
                .padding(MiloTheme.Space.three)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .marksSidewaysDrag()
        .padding(.leading, 22)
    }

    /// Whether there is anything under the call to open: the lines it changed, or what it
    /// came back with. A call that wrote draws the change, because the sentence the tool
    /// returned about it says less than the lines do.
    private var hasDetail: Bool {
        if let change = tool.change, !change.isEmpty { return true }
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
