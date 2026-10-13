import Foundation

/**
 The protocol this app speaks. It must match `PROTOCOL_VERSION` in
 `src/gateways/web/protocol.ts`; the server refuses any other number aloud, so a
 drift between the two is a refusal rather than a mis-drawn chat.
 */
let miloProtocolVersion = 9

// MARK: - What the app sends

enum ClientFrame {
    enum Intent: String { case steer, queue }
    enum Control: String { case stop, allow, deny }

    case hello(conversationId: String)
    case send(text: String, intent: Intent? = nil)
    case control(Control, id: String? = nil)
    case command(text: String)

    /// A flat object per frame, so the encoder is `JSONSerialization` and there is
    /// no second spelling of the wire to keep in step with the server's.
    var json: [String: Any] {
        switch self {
        case .hello(let conversationId):
            // The phone draws a generated interface, so it says so: without it the
            // daemon never teaches the model to draw one and no `ui` event is ever sent.
            // It names itself too: this app and the browser reach the daemon through the
            // same web gateway, and that is what lets it hold the turn for a phone —
            // shorter answers, spoken to a small screen.
            return ["type": "hello", "version": miloProtocolVersion, "conversationId": conversationId, "genui": true, "client": "ios"]
        case .send(let text, let intent):
            guard let intent else { return ["type": "send", "text": text] }
            return ["type": "send", "text": text, "intent": intent.rawValue]
        case .control(let action, let id):
            guard let id else { return ["type": "control", "action": action.rawValue] }
            return ["type": "control", "action": action.rawValue, "id": id]
        case .command(let text):
            return ["type": "command", "text": text]
        }
    }
}

// MARK: - Shapes a turn is drawn from

struct TodoItem: Decodable, Hashable {
    let content: String
    let status: String

    var mark: String {
        switch status {
        case "completed": return "[x]"
        case "in_progress": return "[>]"
        default: return "[ ]"
        }
    }
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
    /// The widget the turn drew beside its words. It used to decode as `other` and
    /// vanish without a word, which is the one thing a drawn thing may not do.
    /// `draft` is a widget still being written, drawn in place as it grows — a stored
    /// session is read back as it ended, so its parts are never drafts.
    case ui(GenUi, draft: Bool)
    case other

    private enum CodingKeys: String, CodingKey { case kind, text, tool, items, render, draft }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "text": self = .text(try container.decode(String.self, forKey: .text))
        case "reasoning": self = .reasoning(try container.decode(String.self, forKey: .text))
        case "tool": self = .tool(try container.decode(ToolMark.self, forKey: .tool))
        case "todo": self = .todo(try container.decode([TodoItem].self, forKey: .items))
        case "ui":
            self = .ui(
                (try? container.decode(GenUi.self, forKey: .render)) ?? .unreadable,
                draft: (try? container.decodeIfPresent(Bool.self, forKey: .draft)) ?? false
            )
        default: self = .other
        }
    }
}

struct WireMessage: Decodable {
    let role: String
    let parts: [WirePart]
    let attachments: [FrameAttachment]?
    let at: Double?
    let raw: String?
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

struct Idea: Decodable, Hashable {
    let title: String
    let prompt: String
}

struct CommandResult: Decodable {
    let reply: String
    let markdown: String?
    let sessionId: String?
    let cards: [SessionCardItem]?
    /// Files delivered with the reply — a routine's answer, or a `send_file` — shown
    /// the way a message's own attachments are.
    let attachments: [FrameAttachment]?
}

/// The pieces of a streaming turn the chat actually draws. Every kind is read
/// tolerantly — a shape this build does not know is `other` and draws nothing,
/// rather than taking the frame down with it.
enum AgentEvent: Decodable {
    case textDelta(String)
    case reasoningDelta(String)
    case toolStart(id: String, name: String, text: String?)
    case toolEnd(id: String, name: String, isError: Bool)
    case todo([TodoItem])
    /// A widget as the model writes it: the same tree at longer and longer prefixes,
    /// `draft` while the block is still open. It is drawn in place as it grows.
    case ui(GenUi, draft: Bool)
    case usage(inputTokens: Int, outputTokens: Int)
    case compacted(ms: Int)
    case rebased(added: Int, removed: Int, compacted: Bool)
    case waiting
    case waited(ms: Int)
    case steer(String)
    case done(finishReason: String)
    case aborted
    case error(String)
    case other

    private enum CodingKeys: String, CodingKey {
        case type, delta, id, name, isError, items, message, render, draft, text, finishReason
        case inputTokens, outputTokens, ms, added, removed, compacted
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
                isError: read(.isError, false)
            )
        case "todo": self = .todo(read(.items, []))
        case "ui":
            self = .ui((try? container.decode(GenUi.self, forKey: .render)) ?? .unreadable, draft: read(.draft, false))
        case "usage":
            self = .usage(inputTokens: read(.inputTokens, 0), outputTokens: read(.outputTokens, 0))
        case "compacted": self = .compacted(ms: read(.ms, 0))
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
}

// MARK: - What the server sends

enum ServerFrame: Decodable {
    case ready(Ready)
    case turnStart(id: String, text: String)
    case event(turnId: String, event: AgentEvent)
    case permission(id: String, request: PermissionRequest, expiresAt: Double)
    case permissionResult(id: String, allowed: Bool)
    case turnEnd(id: String, status: String, raw: String?)
    case commandResult(CommandResult)
    case state(busy: Bool, queued: Int)
    case jobs([JobView])
    case suggestions([Idea])
    case routinesChanged
    case error(String)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, id, text, turnId, event, request, expiresAt, allowed, status, raw
        case busy, queued, jobs, items, message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "turn-start":
            self = .turnStart(
                id: try container.decode(String.self, forKey: .id),
                text: try container.decode(String.self, forKey: .text)
            )
        case "event":
            self = .event(
                turnId: try container.decode(String.self, forKey: .turnId),
                event: try container.decode(AgentEvent.self, forKey: .event)
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
                raw: try container.decodeIfPresent(String.self, forKey: .raw)
            )
        case "command-result": self = .commandResult(try CommandResult(from: decoder))
        case "state":
            self = .state(
                busy: try container.decode(Bool.self, forKey: .busy),
                queued: try container.decode(Int.self, forKey: .queued)
            )
        case "jobs": self = .jobs(try container.decode([JobView].self, forKey: .jobs))
        case "suggestions": self = .suggestions(try container.decode([Idea].self, forKey: .items))
        case "routines-changed": self = .routinesChanged
        case "error": self = .error(try container.decode(String.self, forKey: .message))
        default: self = .unknown
        }
    }
}
