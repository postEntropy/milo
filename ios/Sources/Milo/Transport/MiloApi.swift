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
    /// Whether a turn holds this session right now — anywhere in the install, the
    /// daemon or a terminal. A row draws its running mark from this.
    let running: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, title, createdAt, updatedAt, messageCount, preview, recap, running
    }

    /// Read leniently, and only `id` as the one thing it cannot do without: a row
    /// the daemon describes differently costs that row's detail, never the whole
    /// list — an empty drawer would say nothing about why it is empty.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        recap = try container.decodeIfPresent(String.self, forKey: .recap)
        running = try container.decodeIfPresent(Bool.self, forKey: .running)
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

    /**
     Cuts the session at a turn: the daemon makes the copy and binds this conversation
     to it, so everything after that point is said afresh from the fork. The session
     it was cut from keeps its place in the drawer — the browser forks into a
     conversation of its own, and this app holds one, so the old one is left behind
     rather than deleted.
     */
    static func forkSession(_ account: Account, id: String, upToTurn: Int) async throws {
        _ = try await call(
            "fork-session",
            ["conversationId": account.conversationId, "sessionId": id, "upToTurn": upToTurn],
            account: account,
            as: Ack.self
        )
    }

    static func renameSession(_ account: Account, id: String, title: String) async throws {
        _ = try await call("session-rename", ["id": id, "title": title], account: account, as: Ack.self)
    }

    static func deleteSession(_ account: Account, id: String) async throws {
        _ = try await call("session-delete", ["id": id], account: account, as: Ack.self)
    }

    /**
     Writes the session out on the machine hosting Milo — the log it was read from,
     as markdown, in the daemon's exports directory — and hands back where it landed.
     Null when there is no log to write, which the daemon says by answering `null`.
     */
    static func exportSession(_ account: Account, id: String) async throws -> String? {
        let written = try await call("export", ["id": id, "format": "md"], account: account, as: Written?.self)
        return written?.path
    }

    private struct Written: Decodable { let path: String }

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

    // MARK: - Routines

    /// Every routine the install has, as its own screen draws them.
    static func routines(_ account: Account) async throws -> [RoutineSummary] {
        try await call("routines", account: account, as: [RoutineSummary].self)
    }

    /// Fires one now and answers with what it said. It does not deliver — the chat it
    /// is bound to would get it twice — so the run is opened to read.
    static func runRoutine(_ account: Account, id: String) async throws -> RoutineRunResult {
        try await call("routine-run", ["id": id], account: account, as: RoutineRunResult.self)
    }

    static func setRoutineEnabled(_ account: Account, id: String, enabled: Bool) async throws {
        _ = try await call("routine-enable", ["id": id, "enabled": enabled], account: account, as: Ack.self)
    }

    static func removeRoutine(_ account: Account, id: String) async throws {
        _ = try await call("routine-remove", ["id": id], account: account, as: Ack.self)
    }

    /// What a routine has produced, newest first, a page at a time.
    static func routineRuns(_ account: Account, id: String, offset: Int, limit: Int) async throws -> RoutineRuns {
        try await call("routine-runs", ["id": id, "offset": offset, "limit": limit], account: account, as: RoutineRuns.self)
    }

    /// One run read back whole: the same transcript a conversation draws. Read-only,
    /// so opening a past run never takes the conversation over.
    static func routineTranscript(_ account: Account, id: String) async throws -> [WireMessage] {
        try await call("run-transcript", ["id": id], account: account, as: [WireMessage].self)
    }

    /// The most recent runs across every routine, newest first.
    static func routineFeed(_ account: Account) async throws -> [RoutineFeedEntry] {
        try await call("routine-feed", account: account, as: [RoutineFeedEntry].self)
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

/// A scheduled routine, as the Routines screen lists it. Read leniently, like a session
/// row: the daemon's own labels are drawn rather than recomputed here, so a shape this
/// build does not know costs that field, never the list.
struct RoutineSummary: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let prompt: String
    /// The schedule and the destination, said by the daemon's own describers.
    let whenLabel: String
    let targetLabel: String
    let nextRunAt: Double?
    /// The next few fire times, for the reminders. Absent from an older daemon, which
    /// then carries only `nextRunAt`.
    let nextRuns: [Double]
    let enabled: Bool
    /// Whether its own ceiling stopped it, which is not the person pausing it. Absent
    /// from an older daemon, which only knows paused.
    let finished: Bool
    /// The tools it may use unattended, approved when it was made.
    let allow: [String]
    let lastRunAt: Double?
    let lastResult: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, prompt, whenLabel, targetLabel, nextRunAt, nextRuns, enabled, allow, lastRunAt, lastResult
        case finished
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        whenLabel = try container.decodeIfPresent(String.self, forKey: .whenLabel) ?? ""
        targetLabel = try container.decodeIfPresent(String.self, forKey: .targetLabel) ?? ""
        nextRunAt = try container.decodeIfPresent(Double.self, forKey: .nextRunAt)
        nextRuns = try container.decodeIfPresent([Double].self, forKey: .nextRuns) ?? []
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        finished = try container.decodeIfPresent(Bool.self, forKey: .finished) ?? false
        allow = try container.decodeIfPresent([String].self, forKey: .allow) ?? []
        lastRunAt = try container.decodeIfPresent(Double.self, forKey: .lastRunAt)
        lastResult = try container.decodeIfPresent(String.self, forKey: .lastResult)
    }

    /// What the row says: the name it was given, or the words it opened with.
    var label: String {
        let named = (name ?? "").trimmingCharacters(in: .whitespaces)
        if !named.isEmpty { return named }
        let opening = prompt.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
        return opening.isEmpty ? "Routine" : String(opening.prefix(70))
    }

    /// When it will fire, from the schedule itself: the projected list, or the one time
    /// an older daemon sends. Empty while it is paused.
    var upcoming: [Double] {
        nextRuns.isEmpty ? (nextRunAt.map { [$0] } ?? []) : nextRuns
    }

    var failed: Bool { lastResult == "error" }
}

/// One run of a routine, as the history lists it.
struct RoutineRun: Decodable, Identifiable, Hashable {
    let id: String
    let at: Double
}

/// A page of a routine's runs, with the count behind it so the list knows when to stop.
struct RoutineRuns: Decodable {
    let total: Int
    let runs: [RoutineRun]

    private enum CodingKeys: String, CodingKey { case total, runs }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        total = try container.decodeIfPresent(Int.self, forKey: .total) ?? 0
        runs = try container.decodeIfPresent([RoutineRun].self, forKey: .runs) ?? []
    }
}

/// What firing a routine now answered, and the id of the run it made.
struct RoutineRunResult: Decodable {
    let runId: String?
    let answer: String
    let failure: String?

    private enum CodingKeys: String, CodingKey { case runId, answer, failure }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        answer = try container.decodeIfPresent(String.self, forKey: .answer) ?? ""
        failure = try container.decodeIfPresent(String.self, forKey: .failure)
    }
}

/// One run as the front page's timeline lists it, across every routine.
struct RoutineFeedEntry: Decodable, Identifiable, Hashable {
    /// The routine the run belongs to — the id a tap opens its page by.
    let routineId: String
    let runId: String
    /// The routine's name, or the words it opened with.
    let routine: String
    let at: Double
    let answer: String

    /// The run is the row, so it is what a list keys on — a routine's page is reached
    /// through `routineId` on a tap, not by the row's identity.
    var id: String { runId }

    private enum CodingKeys: String, CodingKey {
        case routineId = "id"
        case runId, routine, at, answer
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        routineId = try container.decode(String.self, forKey: .routineId)
        runId = try container.decodeIfPresent(String.self, forKey: .runId) ?? routineId
        routine = try container.decodeIfPresent(String.self, forKey: .routine) ?? ""
        at = try container.decodeIfPresent(Double.self, forKey: .at) ?? 0
        answer = try container.decodeIfPresent(String.self, forKey: .answer) ?? ""
    }
}
