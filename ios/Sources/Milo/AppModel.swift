import Foundation
import Observation
import UIKit

/**
 The one piece of state the whole app reads: where it is (pairing or chat), the
 session on screen, and the list of the others. The transport is a `MiloClient`
 it owns; nothing here knows about URLs beyond the calls it makes.
 */
@MainActor
@Observable
final class AppModel {
    enum Phase {
        case pairing
        case chat(Account)
    }

    struct Message: Identifiable {
        let id = UUID()
        let isUser: Bool
        var parts: [WirePart]
        var attachments: [FrameAttachment]
        var streaming: Bool
        /// How long the turn thought, said once when it is over.
        var thought: Double?
        /// A line the turn leaves behind — a wait, a rebase, a stop — drawn where the
        /// reply lands.
        var status: String? = nil
        /// The turn copied whole, for "Copy raw": the model's words, its thinking and
        /// every tool call with its arguments and result.
        var raw: String? = nil
        /// What the turn cost the model, shown in the message's own menu.
        var tokens: (input: Int, output: Int)? = nil
    }

    private(set) var phase: Phase = .pairing
    private(set) var messages: [Message] = []
    private(set) var busy = false
    /// Messages stacked behind the turn running now, for the composer's queue chip.
    private(set) var queued = 0
    private(set) var note: String?
    private(set) var modelName = ""
    private(set) var providerId = ""
    private(set) var sessionId = ""

    /// The name of the session on screen, when the list knows it — the `ready`
    /// frame carries no title, so it comes from the sessions themselves.
    var title: String? {
        let named = sessions.first { $0.id == sessionId }?.title?.trimmingCharacters(in: .whitespaces) ?? ""
        return named.isEmpty ? nil : named
    }
    /// Counters, not flags: a haptic fires on an edge, so what it watches is the
    /// moment the answer begins and the moment it lands. `busy` cannot be the
    /// trigger — it goes up on the send, before the daemon has said anything.
    private(set) var answerBegan = 0
    private(set) var answerEnded = 0
    private(set) var connection: MiloClient.State = .idle
    private(set) var pending: (id: String, request: PermissionRequest, expiresAt: Double)?

    // The drawer.
    private(set) var sessions: [SessionSummary] = []
    private(set) var sessionsLoading = false

    // The model picker.
    private(set) var providers: [ProviderInfo] = []
    private(set) var models: [ModelInfo] = []
    private(set) var modelsLoading = false

    var pairingHost = ""
    var pairingCode = ""
    var pairingError: String?
    var pairing = false

    private let client = MiloClient()
    private var turnStarted: Date?

    private var account: Account? {
        if case .chat(let account) = phase { return account }
        return nil
    }

    init() {
        client.onState = { [weak self] state in self?.connection = state }
        client.onFrame = { [weak self] frame in self?.received(frame) }
        client.onSendFailed = { [weak self] in self?.unsent() }
    }

    func load() async {
        if let account = AccountStore.load() {
            phase = .chat(account)
        } else {
            phase = .pairing
        }
    }

    /// The app opens on a new session, ready to type into. The socket is opened
    /// either way: if the daemon could not start a session, the note says so and
    /// the last bound one is what the socket replays.
    func begin(at account: Account) async {
        do {
            try await MiloApi.newSession(account)
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        client.connect(to: account)
    }

    // MARK: - Pairing

    func pair() async {
        guard !pairing else { return }
        guard let address = parseAddress(pairingHost) else {
            pairingError = "That is not an address. Try 192.168.1.20 or name:7717."
            return
        }
        let code = pairingCode.trimmingCharacters(in: .whitespaces)
        guard code.count >= 6 else {
            pairingError = "The code is six digits — run `milo pair` for one."
            return
        }
        pairing = true
        pairingError = nil
        defer { pairing = false }
        do {
            let device = try await Pairing.claim(
                host: address.host,
                port: address.port,
                code: code,
                deviceName: UIDevice.current.name
            )
            guard device.protocolVersion == miloProtocolVersion else {
                pairingError = "This app speaks protocol \(miloProtocolVersion) and the daemon speaks \(device.protocolVersion)."
                return
            }
            let account = Account(
                host: address.host,
                port: address.port,
                token: device.token,
                conversationId: AccountStore.conversationId
            )
            AccountStore.save(account)
            pairingHost = ""
            pairingCode = ""
            phase = .chat(account)
        } catch {
            pairingError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Pairs from a scanned link: the address and the code arrive together.
    func pair(scanned text: String) async {
        guard let link = PairingLink(text: text) else {
            pairingError = "That is not a Milo pairing code. Scan the QR `milo pair` printed."
            return
        }
        pairingHost = "\(link.host):\(link.port)"
        pairingCode = link.code
        await pair()
    }

    func unpair() {
        client.disconnect()
        AccountStore.clear()
        messages = []
        sessions = []
        pending = nil
        note = nil
        phase = .pairing
    }

    // MARK: - The turn

    /// Sends as its own turn, or — with `intent` — steers the turn already running.
    func send(_ text: String, intent: ClientFrame.Intent? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        messages.append(Message(isUser: true, parts: [.text(trimmed)], attachments: [], streaming: false))
        busy = true
        if !client.send(.send(text: trimmed, intent: intent)) { unsent() }
    }

    /// Said the same way wherever a message fails to leave, so the two paths cannot
    /// describe one failure differently.
    private func unsent() {
        note = "That did not reach the daemon. Check the connection and try again."
    }

    /// Where a delivered file is fetched, for the image loader: the daemon serves only
    /// the id it registered, and the token rides in the query because a loader sends no
    /// header — the very request the browser builds for its own `<img>`.
    func attachmentURL(_ id: String) -> URL? {
        guard let account,
              let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let encodedToken = account.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        return account.url("/attachment/\(encodedId)?t=\(encodedToken)")
    }

    func stop() {
        client.send(.control(.stop))
    }

    func answerPermission(allowed: Bool) {
        guard let pending else { return }
        self.pending = nil
        client.send(.control(allowed ? .allow : .deny, id: pending.id))
    }

    // MARK: - Sessions

    func refreshSessions() async {
        guard let account else { return }
        sessionsLoading = true
        defer { sessionsLoading = false }
        do {
            sessions = try await MiloApi.sessions(account).sorted { $0.updatedAt > $1.updatedAt }
            note = nil
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func newSession() async {
        guard let account else { return }
        do {
            try await MiloApi.newSession(account)
            await reopen(account)
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func resume(_ id: String) async {
        guard let account else { return }
        do {
            try await MiloApi.resumeSession(account, id: id)
            await reopen(account)
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func delete(_ id: String) async {
        guard let account else { return }
        do {
            try await MiloApi.deleteSession(account, id: id, current: sessionId.isEmpty ? nil : sessionId)
            await refreshSessions()
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func rename(_ id: String, to name: String) async {
        guard let account else { return }
        do {
            try await MiloApi.renameSession(account, id: id, title: name)
            await refreshSessions()
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// After the bound session changes, the socket is reopened so the daemon
    /// replays the session that is actually bound now.
    private func reopen(_ account: Account) async {
        client.disconnect()
        messages = []
        sessionId = ""
        pending = nil
        turnStarted = nil
        busy = false
        client.connect(to: account)
    }

    // MARK: - Models

    func openPicker() async {
        guard let account else { return }
        do {
            if providers.isEmpty { providers = try await MiloApi.providers(account) }
            let wanted = providers.contains { $0.id == providerId } ? providerId : (providers.first?.id ?? "")
            await loadModels(from: wanted)
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func loadModels(from provider: String) async {
        guard let account else { return }
        modelsLoading = true
        defer { modelsLoading = false }
        do {
            models = try await MiloApi.models(account, provider: provider)
        } catch {
            models = []
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func choose(_ model: String) async {
        guard let account else { return }
        do {
            try await MiloApi.setModel(account, model: model)
            modelName = model
        } catch {
            note = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Settings

    private(set) var settingsLoading = false
    private(set) var settingsError: String?
    private(set) var effort = "medium"
    private(set) var permissionMode = "ask"
    private(set) var toolDisplay = "full"
    private(set) var showThinking = true

    // What the daemon said it accepts. Without it the control offers only what is
    // running — never a set this app made up.
    private(set) var permissionModes: [String] = []
    private(set) var toolLevels: [String] = []
    private(set) var efforts: [String] = []

    /// Reads the whole screen in one call. What the runtime is running wins over
    /// what the file says: a chat command moves the running one first.
    func loadSettings() async {
        guard let account else { return }
        settingsLoading = true
        settingsError = nil
        defer { settingsLoading = false }
        do {
            let overview = try await MiloApi.overview(account)
            effort = overview.live?.effort ?? overview.config?.reasoningEffort ?? "medium"
            permissionMode = overview.live?.permissionMode ?? overview.config?.permissions?.mode ?? "ask"
            toolDisplay = overview.config?.display?.tools ?? "full"
            showThinking = (overview.config?.display?.thinking ?? "on") == "on"
            permissionModes = overview.options?.permissionModes ?? [permissionMode]
            toolLevels = overview.options?.toolLevels ?? [toolDisplay]
            efforts = overview.options?.efforts ?? [effort]
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func setEffort(_ value: String) async {
        if await write({ try await MiloApi.setEffort($0, effort: value) }) { effort = value }
    }

    func setPermissionMode(_ value: String) async {
        guard await write({ try await MiloApi.saveConfig($0, ["permissions": ["mode": value]]) })
        else { return }
        permissionMode = value
    }

    func setToolDisplay(_ value: String) async {
        guard await write({ try await MiloApi.saveConfig($0, ["display": ["tools": value]]) })
        else { return }
        toolDisplay = value
    }

    func setShowThinking(_ value: Bool) async {
        let thinking = value ? "on" : "off"
        guard await write({ try await MiloApi.saveConfig($0, ["display": ["thinking": thinking]]) })
        else { return }
        showThinking = value
    }

    /**
     Every settings write lands the same way, and says whether the daemon agreed.
     A refusal is shown rather than swallowed, and the caller takes the value only
     on a `true` — a control that reads as moved when the write failed would be
     the screen lying about what is configured.
     */
    private func write(_ change: (Account) async throws -> Void) async -> Bool {
        guard let account else { return false }
        settingsError = nil
        do {
            try await change(account)
            return true
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }

    // MARK: - Frames

    private func received(_ frame: ServerFrame) {
        switch frame {
        case .ready(let ready):
            // The whole session, so a reconnect replaces rather than grows it.
            messages = ready.messages.map {
                Message(
                    isUser: $0.role == "user",
                    parts: $0.parts,
                    attachments: $0.attachments ?? [],
                    streaming: false,
                    thought: nil,
                    raw: $0.raw
                )
            }
            modelName = ready.model
            providerId = ready.provider
            sessionId = ready.sessionId
            note = nil
            pending = nil
            queued = 0
            turnStarted = nil
            // A turn still being written when this screen opened: its `turn-start`
            // arrived before the app was listening, so the row it is writing into is
            // opened here and the events still to come land in it. No thought time is
            // claimed — this app watched none of that thinking.
            if ready.activeTurn != nil {
                messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil))
            }
        case .turnStart:
            busy = true
            answerBegan += 1
            turnStarted = Date()
            messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil))
        case .event(_, let event):
            apply(event)
        case .permission(let id, let request, let expiresAt):
            pending = (id, request, expiresAt)
        case .permissionResult(let id, _):
            if pending?.id == id { pending = nil }
        case .turnEnd(_, let status, let raw):
            busy = false
            answerEnded += 1
            if let index = messages.lastIndex(where: { $0.streaming }) {
                messages[index].streaming = false
                messages[index].thought = turnStarted.map { Date().timeIntervalSince($0) }
                // A call left marked running never heard back from; the line stops
                // saying it is underway rather than guessing how it went.
                messages[index].parts = AppModel.settled(messages[index].parts)
                if let raw { messages[index].raw = raw }
                if status == "stopped" { messages[index].status = "Stopped · the partial reply was kept." }
            }
            turnStarted = nil
            if status == "error" { note = "That turn ended in an error." }
        case .commandResult(let result):
            messages.append(
                Message(
                    isUser: false,
                    parts: [.text(result.reply)],
                    attachments: result.attachments ?? [],
                    streaming: false,
                    thought: nil
                )
            )
        case .state(let isBusy, let count):
            busy = isBusy
            queued = count
        case .error(let message):
            note = message
        case .jobs, .suggestions, .routinesChanged, .unknown:
            break
        }
    }

    private func apply(_ event: AgentEvent) {
        switch event {
        case .textDelta(let delta):
            append(delta, reasoning: false)
        case .reasoningDelta(let delta):
            append(delta, reasoning: true)
        case .toolStart(_, let name, let text):
            // `text` is the server's own line (name and the one value worth showing),
            // the same the read-back transcript carries; the name alone is the fallback.
            mutateLast { $0.append(.tool(ToolMark(name: name, text: text ?? name, state: "running"))) }
        case .toolEnd(_, let name, let isError):
            mutateLast { parts in
                let index = parts.lastIndex { part in
                    if case .tool(let tool) = part { return tool.state == "running" && tool.name == name }
                    return false
                }
                guard let index, case .tool(var tool) = parts[index] else { return }
                tool.state = isError ? "failed" : "done"
                parts[index] = .tool(tool)
            }
        case .todo(let items):
            mutateLast { parts in
                let index = parts.lastIndex { part in
                    if case .todo = part { return true }
                    return false
                }
                if let index { parts[index] = .todo(items) } else { parts.append(.todo(items)) }
            }
        case .ui(let widget, let draft):
            // A widget arrives many times over as the model writes it: each draft takes
            // the place of the one before it, and the closed block takes the last draft's.
            mutateLast { parts in AppModel.place(widget: widget, draft: draft, in: &parts) }
        case .usage(let input, let output):
            mutatingLast { $0.tokens = (input, output) }
        case .waiting:
            mutatingLast { $0.status = "Waiting for this session to free up…" }
        case .waited(let ms):
            mutatingLast { $0.status = "Session freed after \(AppModel.formatMs(ms))." }
        case .compacted(let ms):
            mutatingLast { $0.status = "Tidying the context (\(AppModel.formatMs(ms)))." }
        case .rebased(let added, let removed, let compacted):
            mutatingLast {
                $0.status = "Session updated by another surface (\(AppModel.describeRebase(added: added, removed: removed, compacted: compacted)))."
            }
        case .steer:
            mutatingLast { $0.status = "Correction received by Milo." }
        case .done(let finishReason):
            if finishReason == "length" { mutatingLast { $0.status = "The reply hit the output limit." } }
        case .aborted:
            mutatingLast {
                $0.status = "Stopped · the partial reply was kept."
                $0.parts = AppModel.settled($0.parts)
            }
        case .error(let message):
            note = message
        case .other:
            break
        }
    }

    private func append(_ delta: String, reasoning: Bool) {
        mutateLast { parts in
            // Words arriving mean the block being written was not a widget after all —
            // its draft goes, rather than sitting above the words it is not.
            if !reasoning { parts = AppModel.droppingDraft(parts) }
            switch (reasoning, parts.last) {
            case (false, .text(let existing)?):
                parts[parts.count - 1] = .text(existing + delta)
            case (true, .reasoning(let existing)?):
                parts[parts.count - 1] = .reasoning(existing + delta)
            case (false, _):
                parts.append(.text(delta))
            case (true, _):
                parts.append(.reasoning(delta))
            }
        }
    }

    private func mutateLast(_ change: (inout [WirePart]) -> Void) {
        guard let index = messages.lastIndex(where: { $0.streaming }) else { return }
        change(&messages[index].parts)
    }

    /// The same, for the pieces a turn keeps outside its parts — its status and its cost.
    private func mutatingLast(_ change: (inout Message) -> Void) {
        guard let index = messages.lastIndex(where: { $0.streaming }) else { return }
        change(&messages[index])
    }

    // MARK: - Widget parts

    /// Where the block being written left its draft: nil when there is none. Only the
    /// last widget matters — an earlier one is a finished block, a widget of its own.
    private static func draftIndex(_ parts: [WirePart]) -> Int? {
        for index in stride(from: parts.count - 1, through: 0, by: -1) {
            if case .ui(_, let draft) = parts[index] { return draft ? index : nil }
        }
        return nil
    }

    /// A draft takes the place of the draft before it; the finished tree takes the place
    /// of the draft it grew out of. Only a block after a finished one is another widget.
    private static func place(widget: GenUi, draft: Bool, in parts: inout [WirePart]) {
        let part = WirePart.ui(widget, draft: draft)
        if let at = draftIndex(parts) {
            parts[at] = part
        } else {
            parts.append(part)
        }
    }

    private static func droppingDraft(_ parts: [WirePart]) -> [WirePart] {
        guard let at = draftIndex(parts) else { return parts }
        var kept = parts
        kept.remove(at: at)
        return kept
    }

    /// A call left marked running when the turn ended — a stop, an error, a dropped
    /// connection — never heard back from. It stops saying it is underway.
    private static func settled(_ parts: [WirePart]) -> [WirePart] {
        parts.map { part in
            guard case .tool(var tool) = part, tool.state == "running" else { return part }
            tool.state = nil
            return .tool(tool)
        }
    }

    /// A duration as the terminal says it: seconds to one decimal, or milliseconds.
    private static func formatMs(_ ms: Int) -> String {
        ms >= 1000 ? String(format: "%.1f s", Double(ms) / 1000) : "\(ms) ms"
    }

    /// What another holder of this session left in it, in one clause.
    private static func describeRebase(added: Int, removed: Int, compacted: Bool) -> String {
        var says: [String] = []
        if added > 0 { says.append("\(added) new message\(added == 1 ? "" : "s")") }
        if removed > 0 { says.append("\(removed) message\(removed == 1 ? "" : "s") dropped elsewhere") }
        if compacted { says.append("the earlier turns are summarized") }
        return says.joined(separator: " and ")
    }
}
