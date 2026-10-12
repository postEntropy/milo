import Foundation

/// What the daemon answers for one action, or the reason it refused.
enum ApiError: LocalizedError {
    case badAddress
    case refused(String)
    case badAnswer

    var errorDescription: String? {
        switch self {
        case .badAddress: return "The address this device was paired with is not usable."
        case .refused(let message): return message
        case .badAnswer: return "The daemon answered with something that was not JSON."
        }
    }
}

struct SessionSummary: Decodable, Identifiable, Hashable {
    let id: String
    let title: String?
    let createdAt: Double
    let updatedAt: Double
    let messageCount: Int
    let preview: String
    let recap: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, createdAt, updatedAt, messageCount, preview, recap
    }

    /// Read leniently, and only `id` as the one thing it cannot do without: a row
    /// the daemon describes differently costs that row's detail, never the whole
    /// list — an empty drawer would say nothing about why it is empty.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        recap = try container.decodeIfPresent(String.self, forKey: .recap)
        preview = try container.decodeIfPresent(String.self, forKey: .preview) ?? ""
        messageCount = try container.decodeIfPresent(Int.self, forKey: .messageCount) ?? 0
        createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try container.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
    }

    /// What the row says: the name it was given, or the words it opened with.
    var label: String {
        let named = (title ?? "").trimmingCharacters(in: .whitespaces)
        if !named.isEmpty { return named }
        let opening = preview.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
        return opening.isEmpty ? "Empty session" : String(opening.prefix(70))
    }
}

struct ProviderInfo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
}

struct ModelInfo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    /// How much the model holds, when the catalog says.
    let context: Int?
    /// The short name, projected by the daemon from the one shortening every
    /// surface shares. The phone cannot import the TypeScript, so it reads the
    /// result rather than keeping a copy that would drift.
    let label: String?
    /// The row's second line — context, vision, display name — projected too.
    let note: String?

    /// What the row says, falling back to the id against a daemon that sends no
    /// label at all.
    var title: String { label ?? id }
}

/// The daemon's `/api` surface. Every call carries this device's token; nothing
/// here needs the install's own.
enum MiloApi {
    static func call<T: Decodable>(
        _ action: String,
        _ body: [String: Any] = [:],
        account: Account,
        as type: T.Type
    ) async throws -> T {
        guard let url = account.url("/api/\(action)") else { throw ApiError.badAddress }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 25

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw ApiError.refused("Could not reach the daemon at \(account.display).")
        }
        guard let http = response as? HTTPURLResponse else { throw ApiError.badAnswer }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw ApiError.refused(message ?? "The daemon answered \(http.statusCode).")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ApiError.badAnswer
        }
    }

    /// The body an action answers nothing for.
    struct Ack: Decodable {}

    static func sessions(_ account: Account) async throws -> [SessionSummary] {
        try await call("sessions", account: account, as: [SessionSummary].self)
    }

    static func providers(_ account: Account) async throws -> [ProviderInfo] {
        try await call("providers", account: account, as: [ProviderInfo].self)
    }

    static func models(_ account: Account, provider: String) async throws -> [ModelInfo] {
        try await call("models", ["provider": provider], account: account, as: [ModelInfo].self)
    }

    static func newSession(_ account: Account, title: String? = nil) async throws {
        var body: [String: Any] = ["conversationId": account.conversationId]
        if let title { body["title"] = title }
        _ = try await call("new-session", body, account: account, as: Ack.self)
    }

    static func resumeSession(_ account: Account, id: String) async throws {
        _ = try await call(
            "resume-session",
            ["conversationId": account.conversationId, "id": id],
            account: account,
            as: Ack.self
        )
    }

    static func renameSession(_ account: Account, id: String, title: String) async throws {
        _ = try await call("session-rename", ["id": id, "title": title], account: account, as: Ack.self)
    }

    static func deleteSession(_ account: Account, id: String, current: String?) async throws {
        var body: [String: Any] = ["id": id]
        if let current { body["current"] = current }
        _ = try await call("session-delete", body, account: account, as: Ack.self)
    }

    static func setModel(_ account: Account, model: String) async throws {
        _ = try await call("set-model", ["model": model], account: account, as: Ack.self)
    }

    static func setEffort(_ account: Account, effort: String) async throws {
        _ = try await call("set-effort", ["effort": effort], account: account, as: Ack.self)
    }

    /**
     A patch, not a whole config: the daemon merges it section by section, so only
     what changed travels and the rest of the file — and its comments — is left
     alone.
     */
    static func saveConfig(_ account: Account, _ patch: [String: Any]) async throws {
        _ = try await call("save-config", ["config": patch], account: account, as: Ack.self)
    }

    /// The settings screen's one read: the config on disk, and what the runtime
    /// is actually running, which is not always the same thing.
    static func overview(_ account: Account) async throws -> SettingsOverview {
        try await call("overview", account: account, as: SettingsOverview.self)
    }
}

struct SettingsOverview: Decodable {
    struct Display: Decodable {
        let tools: String?
        let thinking: String?
    }

    struct Permissions: Decodable {
        let mode: String?
    }

    struct Config: Decodable {
        let reasoningEffort: String?
        let display: Display?
        let permissions: Permissions?
    }

    /// What the runtime holds now. Set when a chat command or another surface
    /// moved something the file does not know about yet.
    struct Live: Decodable {
        let model: String?
        let effort: String?
        let permissionMode: String?
    }

    let config: Config?
    let live: Live?
    /**
     The values a settings screen may offer, sent by the daemon so a client draws
     what the server accepts. Absent from an older daemon: the screen then offers
     only what is running, never a set of its own invention.
     */
    let options: Options?

    struct Options: Decodable {
        let permissionModes: [String]?
        let toolLevels: [String]?
        let efforts: [String]?
    }
}
