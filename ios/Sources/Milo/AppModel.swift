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
    }

    private(set) var phase: Phase = .pairing
    private(set) var messages: [Message] = []
    private(set) var busy = false
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
    private(set) var pending: (id: String, request: PermissionRequest)?

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

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        messages.append(Message(isUser: true, parts: [.text(trimmed)], attachments: [], streaming: false))
        busy = true
        if !client.send(.send(text: trimmed)) { unsent() }
    }

    /// Said the same way wherever a message fails to leave, so the two paths cannot
    /// describe one failure differently.
    private func unsent() {
        note = "That did not reach the daemon. Check the connection and try again."
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
                    thought: nil
                )
            }
            modelName = ready.model
            providerId = ready.provider
            sessionId = ready.sessionId
            note = nil
            pending = nil
            turnStarted = nil
        case .turnStart:
            busy = true
            answerBegan += 1
            turnStarted = Date()
            messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil))
        case .event(_, let event):
            apply(event)
        case .permission(let id, let request, _):
            pending = (id, request)
        case .permissionResult(let id, _):
            if pending?.id == id { pending = nil }
        case .turnEnd(_, let status):
            busy = false
            answerEnded += 1
            if let index = messages.lastIndex(where: { $0.streaming }) {
                messages[index].streaming = false
                messages[index].thought = turnStarted.map { Date().timeIntervalSince($0) }
            }
            turnStarted = nil
            if status == "error" { note = "That turn ended in an error." }
        case .commandResult(let result):
            messages.append(
                Message(isUser: false, parts: [.text(result.reply)], attachments: [], streaming: false, thought: nil)
            )
        case .state(let isBusy, _):
            busy = isBusy
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
        case .toolStart(_, let name):
            mutateLast { $0.append(.tool(ToolMark(name: name, text: name, state: "running"))) }
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
        case .error(let message):
            note = message
        case .waiting, .done, .aborted, .other:
            break
        }
    }

    private func append(_ delta: String, reasoning: Bool) {
        mutateLast { parts in
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
}
