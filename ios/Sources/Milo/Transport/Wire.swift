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
            return ["type": "hello", "version": miloProtocolVersion, "conversationId": conversationId]
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

/// One piece of a turn, in the order it happened. The kinds the phone does not
/// draw (a generated widget) decode to `other` rather than failing the message.
enum WirePart: Decodable {
    case text(String)
    case reasoning(String)
    case tool(ToolMark)
    case todo([TodoItem])
    case other

    private enum CodingKeys: String, CodingKey { case kind, text, tool, items }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "text": self = .text(try container.decode(String.self, forKey: .text))
        case "reasoning": self = .reasoning(try container.decode(String.self, forKey: .text))
        case "tool": self = .tool(try container.decode(ToolMark.self, forKey: .tool))
        case "todo": self = .todo(try container.decode([TodoItem].self, forKey: .items))
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
}

/// The pieces of a streaming turn the chat actually draws.
enum AgentEvent: Decodable {
    case textDelta(String)
    case reasoningDelta(String)
    case toolStart(id: String, name: String)
    case toolEnd(id: String, name: String, isError: Bool)
    case todo([TodoItem])
    case waiting
    case done
    case aborted
    case error(String)
    case other

    private enum CodingKeys: String, CodingKey { case type, delta, id, name, isError, items, message }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "text-delta": self = .textDelta(try container.decode(String.self, forKey: .delta))
        case "reasoning-delta": self = .reasoningDelta(try container.decode(String.self, forKey: .delta))
        case "tool-start":
            self = .toolStart(
                id: try container.decode(String.self, forKey: .id),
                name: try container.decode(String.self, forKey: .name)
            )
        case "tool-end":
            self = .toolEnd(
                id: try container.decode(String.self, forKey: .id),
                name: try container.decode(String.self, forKey: .name),
                isError: try container.decode(Bool.self, forKey: .isError)
            )
        case "todo": self = .todo(try container.decode([TodoItem].self, forKey: .items))
        case "waiting": self = .waiting
        case "done": self = .done
        case "aborted": self = .aborted
        case "error": self = .error(try container.decode(String.self, forKey: .message))
        default: self = .other
        }
    }
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
}

// MARK: - What the server sends

enum ServerFrame: Decodable {
    case ready(Ready)
    case turnStart(id: String, text: String)
    case event(turnId: String, event: AgentEvent)
    case permission(id: String, request: PermissionRequest, expiresAt: Double)
    case permissionResult(id: String, allowed: Bool)
    case turnEnd(id: String, status: String)
    case commandResult(CommandResult)
    case state(busy: Bool, queued: Int)
    case jobs([JobView])
    case suggestions([Idea])
    case routinesChanged
    case error(String)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, id, text, turnId, event, request, expiresAt, allowed, status
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
                status: try container.decode(String.self, forKey: .status)
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
