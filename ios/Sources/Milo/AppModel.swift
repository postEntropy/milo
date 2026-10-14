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
        /// Whether the turn is waiting for the model's next output — what the wait line is
        /// drawn from. Words end the wait, a call running takes the line's place, and the
        /// model thinking about a result starts it again: the browser reads the same turn
        /// the same way, so neither surface goes quiet where the other is lit.
        var waiting = false
        /// A line the turn leaves behind — a wait, a rebase, a stop — drawn where the
        /// reply lands.
        var status: String? = nil
        /// The turn copied whole, for "Copy raw": the model's words, its thinking and
        /// every tool call with its arguments and result.
        var raw: String? = nil
        /// The same turn with the tool results' own text left out — the path it walked,
        /// every call still named and a failed one still said. Absent when it would read
        /// as `raw`, so the copy control offers it only where it differs.
        var rawNoOutput: String? = nil
        /// What the turn cost the model, shown in the message's own menu.
        var tokens: (input: Int, output: Int)? = nil
        /// The button rows a command drew, under its reply.
        var actions: [ActionRow]? = nil
        /// The sessions a `/sessions` reply drew as cards, in place of its words.
        var cards: [SessionCardItem]? = nil
    }

    private(set) var phase: Phase = .pairing
    private(set) var messages: [Message] = []
    private(set) var busy = false
    /// Messages stacked behind the turn running now, for the composer's queue chip.
    private(set) var queued = 0
    /// The background jobs still running, for the strip above the composer. They belong
    /// to the process, not to this chat, so every screen is told the same list.
    private(set) var jobs: [JobView] = []
    /**
     A line the app has to say, where the reply would land, and whether it is a
     failure: a thing that went right is not said in the red a refusal wears. The
     browser draws the same pair — its notice is red only for an error.
     */
    struct Note: Equatable {
        let text: String
        var failed = true

        /// A line to say. A failure unless the caller says otherwise, because that is
        /// what nearly every line here is.
        init(_ text: String, failed: Bool = true) {
            self.text = text
            self.failed = failed
        }
    }
    private(set) var note: Note?
    private(set) var modelName = ""
    private(set) var providerId = ""
    private(set) var sessionId = ""

    /// The running model without its vendor prefix, from the catalog's projected
    /// label when loaded or after the last `/` before the picker has been opened.
    var modelLabel: String {
        if let label = models.first(where: { $0.id == modelName })?.label {
            return label
        }
        guard let slash = modelName.lastIndex(of: "/") else { return modelName }
        return String(modelName[modelName.index(after: slash)...])
    }

    /// The name of the session on screen, when the list knows it — the `ready`
    /// frame carries no title, so it comes from the sessions themselves.
    var title: String? {
        let named = sessions.first { $0.id == sessionId }?.title?.trimmingCharacters(in: .whitespaces) ?? ""
        return named.isEmpty ? nil : named
    }
    /// Counters, not flags: a haptic fires on an edge, so what it watches is the
    /// moment the answer begins and the moment it lands. `busy` cannot be the
    /// trigger — it goes up on the send — and neither can `turn-start`, which the
    /// daemon sends on acknowledging the send, still the person's own thumb. The
    /// beginning is the turn's first output, whenever that arrives.
    private(set) var answerBegan = 0
    private(set) var answerEnded = 0
    private(set) var connection: MiloClient.State = .idle
    /**
     What the chat says about the socket, when it is worth saying. Held back for a
     moment: leaving the app drops the socket and coming back dials again in a second
     or two, and a line that appears and clears inside that is a flicker about a wait
     that was over before it could be read. The hold starts when the socket goes down
     and not at each state on the way back — passing through `offline` and `connecting`
     is one wait, not two. A refusal is not a wait: the daemon answered, so it is said
     at once, the way it always was.
     */
    private(set) var connectionLine: String?
    private(set) var pending: (id: String, request: PermissionRequest, expiresAt: Double)?

    // The drawer.
    private(set) var sessions: [SessionSummary] = []
    private(set) var sessionsLoading = false

    /// The ideas the model drew from what Milo knows, for the welcome screen. Empty
    /// until the daemon draws them; the standing four stand in meanwhile.
    private(set) var ideas: [Idea] = []

    /// The lines the welcome screen draws, from what is actually here — the browser's
    /// own builder, over the session list and the ideas.
    var suggestions: [Suggestion] {
        buildSuggestions(sessions: sessions, ideas: ideas, currentId: sessionId)
    }

    // The model picker.
    private(set) var providers: [ProviderInfo] = []
    private(set) var models: [ModelInfo] = []
    private(set) var modelsLoading = false
    /**
     Why a catalog came back empty, when it did not simply come back empty: the picker
     draws this instead of the line about no models, so a refusal is never reported as
     a catalog with nothing in it. The browser keeps the same distinction.
     */
    private(set) var modelsError: String?

    var pairingHost = ""
    var pairingCode = ""
    var pairingError: String?
    var pairing = false

    private let client = MiloClient()
    private var turnStarted: Date?
    /// Whether the turn in flight has announced its first output yet, so the beginning
    /// is said once however many pieces arrive.
    private var began = false
    /// How long a wait lasts before it earns the line, and the hold itself while it
    /// is running — one hold for the whole outage.
    private static let lineDelay: Duration = .seconds(2)
    private var lineWork: Task<Void, Never>?
    /// The words a fork owes: sent once the socket is speaking to the copy, the way
    /// the browser's own regenerate does it.
    private var owed: String?

    private var account: Account? {
        if case .chat(let account) = phase { return account }
        return nil
    }

    init() {
        client.onState = { [weak self] state in self?.moved(to: state) }
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

    /**
     The socket moved. `connection` is the truth of it and is current from the moment
     it happens — the settings screen reads it as it is; the line the chat draws is
     what waits, and only for a wait.
     */
    private func moved(to state: MiloClient.State) {
        connection = state
        switch state {
        case .online, .idle:
            clearHold()
            connectionLine = nil
        case .refused(let reason):
            // The daemon spoke, so this is an answer rather than an outage.
            clearHold()
            connectionLine = reason
        case .unreadable:
            clearHold()
            connectionLine = state.wording
        case .connecting, .offline:
            // Already holding: this is the same outage passing through another state,
            // and the line reads whatever the socket is doing when the hold expires.
            guard lineWork == nil else { return }
            lineWork = Task { [weak self] in
                try? await Task.sleep(for: Self.lineDelay)
                guard !Task.isCancelled, let self else { return }
                self.lineWork = nil
                self.connectionLine = self.connection.wording
            }
        }
    }

    private func clearHold() {
        lineWork?.cancel()
        lineWork = nil
    }

    /// What a call that came back wrong has to say. One place, so every failure reads
    /// the same way — the daemon's own words when it gave a reason, the system's
    /// otherwise.
    private func failed(_ error: Error) {
        note = Note((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
    }

    /// The app opens on a new session, ready to type into. The socket is opened
    /// either way: if the daemon could not start a session, the note says so and
    /// the last bound one is what the socket replays.
    func begin(at account: Account) async {
        do {
            try await MiloApi.newSession(account)
        } catch {
            failed(error)
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
        ideas = []
        jobs = []
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
        // A slash command goes as its own frame, never as a turn the model answers: the
        // daemon runs it out of band and replies with a `command-result`. Sent as a turn
        // it would be handled inside the turn body and leave an empty row beside the
        // answer. No `busy` either — a command finishes at once, the daemon's own `state`
        // frame says whether anything is running. The browser's own rule.
        if trimmed.hasPrefix("/") {
            if !client.send(.command(text: trimmed)) { unsent() }
            return
        }
        busy = true
        if !client.send(.send(text: trimmed, intent: intent)) { unsent() }
    }

    /// Stops a background job. Pressing the control is the confirmation; the daemon
    /// answers only when there was nothing left to stop, and the redrawn strip is what
    /// takes the job away.
    func killJob(_ id: String) {
        client.send(.jobKill(id: id))
    }

    /**
     A press on a `command-result` control. The cards open the session they name — the
     web's own `resume:` convention, handled here rather than on the wire — and a button
     travels as an `action` carrying the message it belongs to, so the daemon's answer
     takes that bubble's place.
     */
    func act(_ actionId: String, messageId: String?) {
        if actionId.hasPrefix("resume:") {
            Task { await resume(String(actionId.dropFirst("resume:".count))) }
            return
        }
        client.send(.action(actionId: actionId, messageId: messageId))
    }

    /// Said the same way wherever a message fails to leave, so the two paths cannot
    /// describe one failure differently.
    private func unsent() {
        note = Note("That did not reach the daemon. Check the connection and try again.")
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
            failed(error)
        }
    }

    func newSession() async {
        guard let account else { return }
        do {
            try await MiloApi.newSession(account)
            await reopen(account)
        } catch {
            failed(error)
        }
    }

    func resume(_ id: String) async {
        guard let account else { return }
        do {
            try await MiloApi.resumeSession(account, id: id)
            await reopen(account)
        } catch {
            failed(error)
        }
    }

    func delete(_ id: String) async {
        guard let account else { return }
        do {
            // Move off it first, and only delete once that worked: the daemon refuses
            // to remove the session its conversation is bound to, and ending up on one
            // the delete removed is worse than not deleting at all — the browser's own
            // order, for the browser's own reason.
            if id == sessionId {
                try await MiloApi.newSession(account)
                await reopen(account)
            }
            try await MiloApi.deleteSession(account, id: id)
            await refreshSessions()
        } catch {
            failed(error)
        }
    }

    /// Writes the session out on the machine hosting Milo. Nothing here changes, so
    /// the one thing it has to say is where the file landed — or that there was no log
    /// to write, which is the daemon answering nothing rather than refusing.
    func export(_ id: String) async {
        guard let account else { return }
        do {
            let path = try await MiloApi.exportSession(account, id: id)
            note = path
                .map { Note("Exported to \($0)", failed: false) }
                ?? Note("Nothing to export yet — this session has no log.")
        } catch {
            failed(error)
        }
    }

    /// The id this session goes by on the machine hosting Milo — the handle to name
    /// it from a shell, or hand to another surface. It is not the words on the row, so
    /// the menu offers it by name and the app says it landed, the same line export
    /// raises; a copy the pasteboard refused would otherwise leave the reader
    /// believing the id is in hand when it never was.
    func copyId(_ id: String) {
        guard !id.isEmpty else { return }
        UIPasteboard.general.string = id
        note = Note("Session ID copied", failed: false)
    }

    func rename(_ id: String, to name: String) async {
        guard let account else { return }
        do {
            try await MiloApi.renameSession(account, id: id, title: name)
            await refreshSessions()
        } catch {
            failed(error)
        }
    }

    /**
     Forking: the session is cut at a turn and this conversation is bound to the copy,
     so the next turn is said from there instead. Nothing is lost — the session it was
     cut from keeps its place in the drawer — and nothing is deleted.
     */
    func fork(from turn: Int) async {
        await fork(from: turn, then: nil)
    }

    /// Asking again from an earlier point: the fork, and the words that asked the
    /// first time sent into it.
    func regenerate(prompt: String, upToTurn: Int) async {
        await fork(from: upToTurn, then: prompt)
    }

    private func fork(from turn: Int, then prompt: String?) async {
        guard let account, !sessionId.isEmpty else { return }
        owed = prompt
        do {
            try await MiloApi.forkSession(account, id: sessionId, upToTurn: turn)
            await reopen(account)
        } catch {
            owed = nil
            failed(error)
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
        began = false
        busy = false
        // The ideas belonged to the session being left; the daemon draws new ones for
        // the one the socket is about to replay.
        ideas = []
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
            failed(error)
        }
    }

    func loadModels(from provider: String) async {
        guard let account else { return }
        modelsLoading = true
        modelsError = nil
        defer { modelsLoading = false }
        do {
            models = try await MiloApi.models(account, provider: provider)
        } catch {
            models = []
            // Kept here as well as said in the note: the picker is a sheet over the
            // screen the note is drawn on, so the note alone says it where nobody is
            // looking.
            modelsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            failed(error)
        }
    }

    func choose(_ model: String) async {
        guard let account else { return }
        do {
            try await MiloApi.setModel(account, model: model)
            modelName = model
        } catch {
            failed(error)
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
            if modelName.isEmpty, let running = overview.live?.model, !running.isEmpty {
                modelName = running
            }
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
                    raw: $0.raw,
                    rawNoOutput: $0.rawNoOutput
                )
            }
            modelName = ready.model
            providerId = ready.provider
            // How hard the running model thinks, when this session was opened with one:
            // the handshake says so, so the composer's own control is on the right line
            // before the settings screen has ever been read.
            if let running = ready.effort { effort = running }
            sessionId = ready.sessionId
            note = nil
            pending = nil
            queued = 0
            // The jobs running when this screen opened: the strip is drawn from the
            // handshake rather than waiting for the next change to reach it.
            jobs = ready.jobs ?? []
            turnStarted = nil
            began = false
            // A turn still being written when this screen opened: its `turn-start`
            // arrived before the app was listening, so the row it is writing into is
            // opened here and the events still to come land in it. No thought time is
            // claimed — this app watched none of that thinking.
            if ready.activeTurn != nil {
                messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil, waiting: true))
            }
            // The words a fork owes go out now that the socket is speaking to the copy.
            if let owed {
                self.owed = nil
                send(owed)
            }
        case .turnStart:
            busy = true
            began = false
            turnStarted = Date()
            messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil, waiting: true))
        case .event(_, let event):
            apply(event)
        case .permission(let id, let request, let expiresAt):
            pending = (id, request, expiresAt)
        case .permissionResult(let id, _):
            if pending?.id == id { pending = nil }
        case .turnEnd(_, let status, let raw, let rawNoOutput):
            busy = false
            answerEnded += 1
            if let index = messages.lastIndex(where: { $0.streaming }) {
                messages[index].streaming = false
                messages[index].waiting = false
                messages[index].thought = turnStarted.map { Date().timeIntervalSince($0) }
                // A call left marked running never heard back from; the line stops
                // saying it is underway rather than guessing how it went.
                messages[index].parts = AppModel.settled(messages[index].parts)
                if let raw { messages[index].raw = raw }
                if let rawNoOutput { messages[index].rawNoOutput = rawNoOutput }
                if status == "stopped" { messages[index].status = "Stopped · the partial reply was kept." }
            }
            turnStarted = nil
            if status == "error" { note = Note("That turn ended in an error.") }
        case .commandResult(let result):
            // The reply as prose, preferring the markdown the daemon rendered beside the
            // plain words — the same choice the browser makes.
            let parts: [WirePart] = [.text(result.markdown ?? result.reply)]
            // A reply that names the message it answers takes that message's place: the
            // `/sessions` pagination redraws one bubble rather than stacking a new one
            // under it. The id is this app's own — see `act` — echoed back by the daemon.
            if let messageId = result.messageId,
               let index = messages.firstIndex(where: { $0.id.uuidString == messageId }) {
                messages[index].parts = parts
                messages[index].attachments = result.attachments ?? []
                messages[index].actions = result.actions
                messages[index].cards = result.cards
            } else {
                messages.append(
                    Message(
                        isUser: false,
                        parts: parts,
                        attachments: result.attachments ?? [],
                        streaming: false,
                        thought: nil,
                        actions: result.actions,
                        cards: result.cards
                    )
                )
            }
        case .state(let isBusy, let count):
            busy = isBusy
            queued = count
        case .error(let message):
            note = Note(message)
        case .suggestions(let items):
            ideas = items
        case .jobs(let running):
            jobs = running
        case .routinesChanged, .unknown:
            break
        }
    }

    /// The turn's first output. The haptic waits for this rather than the send or the
    /// daemon's `turn-start`, so the tap lands when Milo actually starts — said once,
    /// whichever piece of the answer arrives first.
    private func beganSpeaking() {
        guard !began else { return }
        began = true
        answerBegan += 1
    }

    private func apply(_ event: AgentEvent) {
        switch event {
        case .textDelta(let delta):
            beganSpeaking()
            append(delta, reasoning: false)
        case .reasoningDelta(let delta):
            beganSpeaking()
            append(delta, reasoning: true)
        case .toolStart(_, let name, let text):
            beganSpeaking()
            // `text` is the server's own line (name and the one value worth showing),
            // the same the read-back transcript carries; the name alone is the fallback.
            // The call's own line is what says the turn is working from here, so the wait
            // for the model's next output is over until the call comes back.
            mutatingLast { message in
                message.waiting = false
                message.parts.append(.tool(ToolMark(name: name, text: text ?? name, state: "running")))
            }
        case .toolEnd(_, let name, let isError, let result):
            mutateLast { parts in
                let index = parts.lastIndex { part in
                    if case .tool(let tool) = part { return tool.state == "running" && tool.name == name }
                    return false
                }
                guard let index, case .tool(var tool) = parts[index] else { return }
                tool.state = isError ? "failed" : "done"
                // Empty below `full`, where the server withholds it: an empty result draws
                // nothing, so only a real one is kept.
                if let result, !result.isEmpty { tool.result = result }
                parts[index] = .tool(tool)
            }
            // The result is in, so the model is thinking again about what to do with it:
            // the wait line comes back, which is the browser's own reading of this moment.
            mutatingLast { $0.waiting = true }
        case .todo(let items):
            beganSpeaking()
            mutateLast { parts in
                let index = parts.lastIndex { part in
                    if case .todo = part { return true }
                    return false
                }
                if let index { parts[index] = .todo(items) } else { parts.append(.todo(items)) }
            }
        case .ui(let widget, let draft):
            beganSpeaking()
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
            note = Note(message)
        case .other:
            break
        }
    }

    private func append(_ delta: String, reasoning: Bool) {
        mutatingLast { message in
            var parts = message.parts
            // Words arriving mean the block being written was not a widget after all — its
            // draft goes, rather than sitting above the words it is not — and they end the
            // wait line's wait. Thinking is what fills that wait, so a reasoning delta is
            // the same wait still running.
            if !reasoning {
                message.waiting = false
                parts = AppModel.droppingDraft(parts)
            }
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
            message.parts = parts
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

extension AppModel.Message {
    /// The words of a message, everything that is not prose left out — what Copy takes,
    /// and what asking again sends back.
    var prose: String {
        parts
            .compactMap { part in
                if case .text(let text) = part { return text }
                return nil
            }
            .joined(separator: "\n\n")
    }
}
