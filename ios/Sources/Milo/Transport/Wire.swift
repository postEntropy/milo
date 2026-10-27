import Foundation

/**
 The protocol this app speaks. It must match `PROTOCOL_VERSION` in
 `src/gateways/web/protocol.ts`; the server refuses any other number aloud, so a
 drift between the two is a refusal rather than a mis-drawn chat.
 */
let miloProtocolVersion = 13

// MARK: - What the app sends

/// Where a turn's answer goes, when it is not the chat it was asked in. Pinned on the
/// `send` frame so a routine's destination is the one the person picked rather than
/// something the sentence has to say — the browser's own `SendTarget`.
struct SendTarget: Equatable {
    enum Gateway: String {
        case telegram, discord, web, none
    }
    let gateway: Gateway
    /// The chat to post into. Required even for `none`: the server takes half a target
    /// as none at all, and the phone passes its own conversation the way the browser does.
    let chatId: String
}

enum ClientFrame {
    enum Intent: String { case steer, queue }
    enum Control: String { case stop, allow, always, deny }

    case hello(chatId: String)
    /// The files the message carries: the daemon's names for bytes this app has already
    /// posted to `/upload`, which is how a file reaches a turn — the bytes never ride the
    /// socket. Empty for every message with nothing attached.
    case send(text: String, intent: Intent? = nil, target: SendTarget? = nil, uploadIds: [String] = [])
    case control(Control, id: String? = nil)
    /// Turn the session's planning mode on or off. The state belongs to the session, so
    /// the daemon answers with a `plan` frame that every screen watching it sees.
    case setPlan(Bool)
    /// Approve the plan: the daemon leaves plan mode and starts the execution turn.
    case approvePlan
    case command(text: String)
    /// Stop a background job. Pressing the control is the confirmation.
    case jobKill(id: String)
    /**
     A press on a `command-result` control. `messageId` is this app's own message the
     control belongs to, echoed back by the daemon so the answer takes that bubble's
     place rather than opening a second one.
     */
    case action(actionId: String, messageId: String? = nil)
    /**
     A press on a panel tab: bring it to the front, or close it, named by its key. A key
     rather than a position, so a press cannot race the list shifting under it.
     */
    case panelActivate(key: String)
    case panelClose(key: String)
    /// Pointer or keyboard the person sent into the live browser.
    case panelInput(PanelInput)

    /// A flat object per frame, so the encoder is `JSONSerialization` and there is
    /// no second spelling of the wire to keep in step with the server's.
    var json: [String: Any] {
        switch self {
        case .hello(let chatId):
            // The phone draws a generated interface, so it says so: without it the
            // daemon never teaches the model to draw one and no `ui` event is ever sent.
            // It names itself too: this app and the browser reach the daemon through the
            // same web gateway, and that is what lets it hold the turn for a phone —
            // shorter answers, spoken to a small screen.
            return ["type": "hello", "version": miloProtocolVersion, "chatId": chatId, "genui": true, "client": "ios"]
        case .send(let text, let intent, let target, let uploadIds):
            var frame: [String: Any] = ["type": "send", "text": text]
            if let intent { frame["intent"] = intent.rawValue }
            if let target {
                frame["target"] = ["gateway": target.gateway.rawValue, "chatId": target.chatId]
            }
            if !uploadIds.isEmpty { frame["uploadIds"] = uploadIds }
            return frame
        case .control(let action, let id):
            guard let id else { return ["type": "control", "action": action.rawValue] }
            return ["type": "control", "action": action.rawValue, "id": id]
        case .setPlan(let on):
            return ["type": "control", "action": "plan", "plan": on]
        case .approvePlan:
            return ["type": "control", "action": "approve-plan"]
        case .command(let text):
            return ["type": "command", "text": text]
        case .jobKill(let id):
            return ["type": "job-kill", "id": id]
        case .action(let actionId, let messageId):
            guard let messageId else { return ["type": "action", "actionId": actionId] }
            return ["type": "action", "actionId": actionId, "messageId": messageId]
        case .panelActivate(let key):
            return ["type": "panel-activate", "key": key]
        case .panelClose(let key):
            return ["type": "panel-close", "key": key]
        case .panelInput(let input):
            return ["type": "panel-input", "input": input.json]
        }
    }
}

// MARK: - Shapes a turn is drawn from

struct TodoItem: Decodable, Hashable {
    let content: String
    let status: String
}

/// A tool call as a surface draws it. `text` is the server's own rendering, which
/// a stored transcript carries and a live `tool-start` does not — a live line
/// therefore shows the name alone, and gets its text when the session is read back.
struct ToolMark: Decodable, Hashable {
    let name: String
    let text: String
    /// Mutable because a live call is drawn before it has an answer: `tool-start`
    /// arrives running, and `tool-end` names how it ended.
    var state: String?
    /// What the call came back with, for the detail under the line. Absent where there is
    /// nothing to show — a call still running, or a level below `full`, where the server
    /// sends it empty. Capped on the server, so what is folded and what is opened are one
    /// reading; the whole of it is in the turn's raw copy.
    var result: String?
    /// What the call changed in the files, for the lines under the call. The server
    /// computes it where the write happens, so a `replace_all` knows every place it
    /// landed; a level below `full` withholds it with the result.
    var change: [FileChange]?
}

/// One line of a change: the number it had, the number it has, and whether it arrived,
/// left, or stayed as context.
struct ChangeLine: Decodable, Hashable {
    let kind: String
    let text: String
    let old: Int?
    let new: Int?
}

/// What one call did to one file, with the counts the line wears and the lines the fold
/// opens onto. `truncated` means the body was cut; the counts still count it whole.
struct FileChange: Decodable, Hashable {
    let path: String
    let additions: Int
    let deletions: Int
    let created: Bool?
    let deleted: Bool?
    let lines: [ChangeLine]
    let truncated: Bool?
}

struct FrameAttachment: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let mimeType: String
    let size: Int
    let image: Bool
}

/// One piece of a turn, in the order it happened. A kind this build has never heard of
/// decodes to `other` rather than failing the message.
enum WirePart: Decodable {
    case text(String)
    case reasoning(String)
    case tool(ToolMark)
    case todo([TodoItem])
    /// The project's checks after a turn that wrote: the core's own words, and
    /// whether they passed.
    case verification(text: String, ok: Bool)
    /// The widget the turn drew beside its words. It used to decode as `other` and
    /// vanish without a word, which is the one thing a drawn thing may not do.
    /// `draft` is a widget still being written, drawn in place as it grows — a stored
    /// session is read back as it ended, so its parts are never drafts.
    case ui(GenUi, draft: Bool)
    case other

    private enum CodingKeys: String, CodingKey { case kind, text, tool, items, render, draft, ok }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "text": self = .text(try container.decode(String.self, forKey: .text))
        case "reasoning": self = .reasoning(try container.decode(String.self, forKey: .text))
        case "tool": self = .tool(try container.decode(ToolMark.self, forKey: .tool))
        case "todo": self = .todo(try container.decode([TodoItem].self, forKey: .items))
        case "verification":
            self = .verification(
                text: (try? container.decodeIfPresent(String.self, forKey: .text)) ?? "",
                ok: (try? container.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
            )
        case "ui":
            self = .ui(
                (try? container.decode(GenUi.self, forKey: .render)) ?? .unreadable,
                draft: (try? container.decodeIfPresent(Bool.self, forKey: .draft)) ?? false
            )
        default: self = .other
        }
    }
}

/// A message a routine delivered on its own, when this is one: the name it signs
/// itself with and when it landed, so the chat draws a card instead of an answer
/// nobody in the conversation asked for. The name is data here rather than the
/// first line of the words, so the card never says it twice.
struct RoutineDelivery: Decodable, Hashable {
    let name: String
    /// When it landed, in ms.
    let at: Double
    /// The run ended in a failure: the words are what went wrong.
    let failed: Bool?
}

struct WireMessage: Decodable {
    let role: String
    let parts: [WirePart]
    /// A routine's delivery, when this message is one.
    let routine: RoutineDelivery?
    let attachments: [FrameAttachment]?
    let at: Double?
    /// How long the turn took to say anything, in ms — what the line over its thought
    /// reports. Absent on a turn too quick to say, and on one stored before this was kept.
    let thoughtMs: Double?
    let raw: String?
    /// The same turn with the tool results' own text left out — the path it walked.
    let rawNoOutput: String?
}

struct PermissionRequest: Decodable, Hashable {
    let tool: String
    let summary: String
}

struct JobView: Decodable, Identifiable, Hashable {
    let id: String
    let command: String
    let startedAt: Double
    let lines: [String]
}

struct SessionCardItem: Decodable, Identifiable, Hashable {
    let id: String
    let title: String?
    let messageCount: Int
    let when: String
    let summary: String
}

/// A button a `command-result` carries, for the row it belongs to: an id a press names,
/// the words, a tone, and — for a link or an inert marker like the page count — a url or
/// a disabled flag. The page's own shape, `ActionButton` in the protocol.
struct ActionButton: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let style: String?
    let url: String?
    let disabled: Bool?
}

/// One row of buttons. A row is how they sit together, so the shape is kept rather than
/// flattened into a single list.
typealias ActionRow = [ActionButton]

struct Idea: Decodable, Hashable {
    let title: String
    let prompt: String
    /// The SF Symbol the card wears, as the model chose it. Absent when it named none —
    /// the line then falls back to the standing spark.
    let symbol: String?
}

/// One command `/` offers, as the daemon lists them (`src/gateways/command-catalog.ts`).
/// The browser imports the same list; the phone is handed it in the `ready` frame, so the
/// two palettes cannot drift.
struct CommandEntry: Decodable, Identifiable, Hashable {
    let name: String
    /// What follows the name in a usage line, when the command takes one.
    let usage: String?
    let hint: String

    var id: String { name }
}

struct CommandResult: Decodable {
    let reply: String
    let markdown: String?
    let sessionId: String?
    let cards: [SessionCardItem]?
    /// The button rows a command carries, the `/sessions` pagination among them.
    let actions: [ActionRow]?
    /// Echoed back only where this client sent one: the message whose words the reply
    /// takes the place of, so pagination redraws one bubble instead of stacking a new
    /// one under it.
    let messageId: String?
    /// Files delivered with the reply — a routine's answer, or a `send_file` — shown
    /// the way a message's own attachments are.
    let attachments: [FrameAttachment]?
    /// The routine that delivered this reply, when one did: the chat signs it with
    /// the name and the time it landed.
    let routine: RoutineDelivery?
}

// MARK: - The panel beside the chat

/// What a panel tab is showing, as the daemon decides it. A kind this build has never
/// heard of is kept as `other` and drawn the way an unrenderable file is: served to the
/// person by its bytes rather than taking the frame down with it.
enum PanelKind: String, Decodable {
    case document, page, image, pdf, file, browser, other

    init(from decoder: Decoder) throws {
        let name = try decoder.singleValueContainer().decode(String.self)
        self = PanelKind(rawValue: name) ?? .other
    }
}

/// One tab: what it holds, plus the stable name a press refers to it by. The bytes never
/// ride the socket — `artifact` is a descriptor, and the file behind it is fetched from
/// `/panel/<id>` by the id it carries.
struct PanelTab: Decodable, Identifiable, Hashable {
    let key: String
    let kind: PanelKind
    /// What the tab calls it, when the daemon named it.
    let title: String?
    /// The file behind `document`, `page`, `image`, `pdf` or `file`.
    let artifact: FrameAttachment?
    /// The page the live browser is on, when it knows.
    let url: String?

    var id: String { key }
}

/// What the panel is showing: its tabs, in the order they opened, and the one in front.
/// Null on the wire means nothing is open, which is the panel being down.
struct PanelView: Decodable, Hashable {
    let tabs: [PanelTab]
    let active: Int
}

/// A pointer or a key sent into the live browser. Coordinates are normalized to the
/// viewport (0..1) so the page does not have to be told its pixel size, and a key
/// carries CDP's modifier bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8) so a shortcut is
/// not mistaken for a plain character.
enum PanelInput {
    case click(x: Double, y: Double)
    case move(x: Double, y: Double)
    case scroll(x: Double, y: Double, deltaY: Double)
    case key(String, modifiers: Int)
    case type(String)

    var json: [String: Any] {
        switch self {
        case .click(let x, let y):
            return ["kind": "click", "x": x, "y": y]
        case .move(let x, let y):
            return ["kind": "move", "x": x, "y": y]
        case .scroll(let x, let y, let deltaY):
            return ["kind": "scroll", "x": x, "y": y, "deltaY": deltaY]
        case .key(let key, let modifiers):
            return ["kind": "key", "key": key, "modifiers": modifiers]
        case .type(let text):
            return ["kind": "type", "text": text]
        }
    }
}

/// The pieces of a streaming turn the chat actually draws. Every kind is read
/// tolerantly — a shape this build does not know is `other` and draws nothing,
/// rather than taking the frame down with it.
enum AgentEvent: Decodable {
    case textDelta(String)
    case reasoningDelta(String)
    case toolStart(id: String, name: String, text: String?)
    case toolEnd(id: String, name: String, isError: Bool, drawFailure: Bool, result: String?, change: [FileChange]?)
    case todo([TodoItem])
    /// The project's checks after a turn that wrote. The words are the core's, so
    /// the phone says what the browser and the terminal say.
    case verification(text: String, ok: Bool)
    /// A widget as the model writes it: the same tree at longer and longer prefixes,
    /// `draft` while the block is still open. It is drawn in place as it grows.
    case ui(GenUi, draft: Bool)
    case usage(inputTokens: Int, outputTokens: Int)
    /// The oldest turns are being folded into the summary right now: a model call of
    /// its own, said before it starts so the quiet has a name.
    case compacting
    /// The fold is done, and what it came to — the turns, the tokens they were worth,
    /// whether a summary was written in their place, and how long the call took.
    case compacted(ms: Int, folded: Int, tokens: Int, summarized: Bool)
    case rebased(added: Int, removed: Int, compacted: Bool)
    case waiting
    case waited(ms: Int)
    case steer(String)
    case done(finishReason: String)
    case aborted
    case error(String)
    case other

    private enum CodingKeys: String, CodingKey {
        case type, delta, id, name, isError, drawFailure, items, message, render, draft, text, finishReason, result, ok, change
        case inputTokens, outputTokens, ms, added, removed, compacted
        case folded, tokens, summarized
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        func read<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            (try? container.decode(T.self, forKey: key)) ?? fallback
        }
        func readText(_ key: CodingKeys) -> String? {
            (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil
        }

        switch (try? container.decode(String.self, forKey: .type)) ?? "" {
        case "text-delta": self = .textDelta(read(.delta, ""))
        case "reasoning-delta": self = .reasoningDelta(read(.delta, ""))
        case "tool-start":
            // `text` is the line the server already drew — the phone cannot import
            // the formatter, so it reads the result rather than keeping a copy.
            self = .toolStart(id: read(.id, ""), name: read(.name, ""), text: readText(.text))
        case "tool-end":
            self = .toolEnd(
                id: read(.id, ""),
                name: read(.name, ""),
                isError: read(.isError, false),
                drawFailure: read(.drawFailure, false),
                result: readText(.result),
                change: (try? container.decodeIfPresent([FileChange].self, forKey: .change)) ?? nil
            )
        case "todo": self = .todo(read(.items, []))
        case "verification": self = .verification(text: readText(.text) ?? "", ok: read(.ok, false))
        case "ui":
            self = .ui((try? container.decode(GenUi.self, forKey: .render)) ?? .unreadable, draft: read(.draft, false))
        case "usage":
            self = .usage(inputTokens: read(.inputTokens, 0), outputTokens: read(.outputTokens, 0))
        case "compacting": self = .compacting
        case "compacted":
            self = .compacted(
                ms: read(.ms, 0),
                folded: read(.folded, 0),
                tokens: read(.tokens, 0),
                summarized: read(.summarized, false)
            )
        case "rebased":
            self = .rebased(
                added: read(.added, 0),
                removed: read(.removed, 0),
                compacted: read(.compacted, false)
            )
        case "waiting": self = .waiting
        case "waited": self = .waited(ms: read(.ms, 0))
        case "steer": self = .steer(readText(.text) ?? "")
        case "done": self = .done(finishReason: readText(.finishReason) ?? "")
        case "aborted": self = .aborted
        case "error": self = .error(read(.message, ""))
        default: self = .other
        }
    }
}

/**
 A turn that is still being written when this screen opens. Its `turn-start` went
 out before the app was listening, and the daemon writes a session a step at a
 time, so the middle of an answer sits in neither the transcript nor a frame this
 app ever saw — the events it has already said follow, in order, right after the
 `ready`. This is what says a row has to be open for them to land in; `id` names it
 for the surfaces that key a row on one.
 */
struct ActiveTurn: Decodable {
    let id: String
}

struct Ready: Decodable {
    let version: Int
    let sessionId: String
    let messages: [WireMessage]
    let thinking: String
    let provider: String
    let providerName: String
    let model: String
    let effort: String?
    let activeTurn: ActiveTurn?
    /// The background jobs still running when this screen opened, so the strip is drawn
    /// without waiting for the next change broadcast.
    let jobs: [JobView]?
    /// The panel this conversation was left showing, so a screen that opens onto one has
    /// its tabs without waiting for the next time the model shows something.
    let panel: PanelView?
    /// The project this session works in, when it works in one — with the reason it cannot
    /// be worked in, when the folder has gone. Set on a session that has said nothing yet
    /// too: which folder the work happens in is a fact of the session, not of its words.
    let project: Project?
    /// Whether this session's turns are planning turns. Kept on the session, so a screen
    /// that arrives mid-plan opens with the switch already on.
    let plan: Bool?
    /// What `/` offers, from the daemon's own catalog.
    let commands: [CommandEntry]?
    /// Whether the rest of this session's transcript follows in `history` frames. The
    /// daemon hands a long session over in pieces because this phone's websocket refuses
    /// a message over 1 MiB; the rows arrive here in the order they happened.
    let continues: Bool?
}

// MARK: - What the server sends

enum ServerFrame: Decodable {
    case ready(Ready)
    /// The rest of a session whose transcript did not fit in the `ready`, whole rows in
    /// the order they happened.
    case history([WireMessage])
    case turnStart(id: String, text: String)
    case event(turnId: String, event: AgentEvent, says: String?)
    case permission(id: String, request: PermissionRequest, expiresAt: Double)
    case permissionResult(id: String, allowed: Bool)
    case turnEnd(id: String, status: String, raw: String?, rawNoOutput: String?, says: String?)
    case commandResult(CommandResult)
    case state(busy: Bool, queued: Int)
    /// The session's planning turn went on or off, for every screen watching it.
    case plan(Bool)
    case jobs([JobView])
    case suggestions([Idea])
    case routinesChanged
    /// A session's turn began or ended somewhere in the install: re-read the list that
    /// shows it running.
    case sessionsChanged
    /// A step may have changed what is on disk somewhere in the install: re-read the folder
    /// being drawn. Not the same news as `sessionsChanged`, which is about which session is
    /// running — this one is about the files, and arrives while a turn is still going.
    case workChanged
    /// The panel beside the chat changed; null takes it down.
    case panel(PanelView?)
    case error(String)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, id, text, turnId, event, request, expiresAt, allowed, status, raw, rawNoOutput, says
        case busy, queued, plan, jobs, items, message, panel, messages
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "history":
            self = .history(try container.decode([WireMessage].self, forKey: .messages))
        case "turn-start":
            self = .turnStart(
                id: try container.decode(String.self, forKey: .id),
                text: try container.decode(String.self, forKey: .text)
            )
        case "event":
            self = .event(
                turnId: try container.decode(String.self, forKey: .turnId),
                event: try container.decode(AgentEvent.self, forKey: .event),
                // What the turn's row says about this step, in the daemon's words: the
                // phone cannot import the function that writes it, so it reads it here
                // rather than keeping a copy that drifts.
                says: try container.decodeIfPresent(String.self, forKey: .says)
            )
        case "permission":
            self = .permission(
                id: try container.decode(String.self, forKey: .id),
                request: try container.decode(PermissionRequest.self, forKey: .request),
                expiresAt: try container.decode(Double.self, forKey: .expiresAt)
            )
        case "permission-result":
            self = .permissionResult(
                id: try container.decode(String.self, forKey: .id),
                allowed: try container.decode(Bool.self, forKey: .allowed)
            )
        case "turn-end":
            self = .turnEnd(
                id: try container.decode(String.self, forKey: .id),
                status: try container.decode(String.self, forKey: .status),
                raw: try container.decodeIfPresent(String.self, forKey: .raw),
                rawNoOutput: try container.decodeIfPresent(String.self, forKey: .rawNoOutput),
                says: try container.decodeIfPresent(String.self, forKey: .says)
            )
        case "command-result": self = .commandResult(try CommandResult(from: decoder))
        case "state":
            self = .state(
                busy: try container.decode(Bool.self, forKey: .busy),
                queued: try container.decode(Int.self, forKey: .queued)
            )
        case "plan": self = .plan(try container.decode(Bool.self, forKey: .plan))
        case "jobs": self = .jobs(try container.decode([JobView].self, forKey: .jobs))
        case "suggestions": self = .suggestions(try container.decode([Idea].self, forKey: .items))
        case "routines-changed": self = .routinesChanged
        case "sessions-changed": self = .sessionsChanged
        case "work-changed": self = .workChanged
        // Absent and null are the same thing here: nothing is open, which is the panel
        // being down rather than a frame that failed to read.
        case "panel": self = .panel(try container.decodeIfPresent(PanelView.self, forKey: .panel))
        case "error": self = .error(try container.decode(String.self, forKey: .message))
        default: self = .unknown
        }
    }
}
