import Foundation
import Observation
import SwiftUI
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
        /// The files the person picked themselves, still in hand: drawn from their own bytes
        /// while the daemon is given them, and left on the bubble after — what was attached
        /// is what the message is, whether or not the upload landed. A received file, and a
        /// reload of this one, come through `attachments` instead.
        var drafts: [AttachmentDraft] = []
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
    /// Bumped when a thread kept from the session being left is replaced by the one the
    /// handshake brought. The screen cross-fades the two on this, rather than swapping
    /// the old words for the new under the card.
    private(set) var threadHandover = 0
    private(set) var busy = false
    /// Whether this session's turns are proposing rather than working. Kept on the
    /// session, so a screen that reconnects mid-plan opens with the switch already on.
    private(set) var planMode = false
    /// Whether a turn has run under the plan. Approval belongs to the proposal that
    /// turn made, not to whatever the thread said before plan mode went on.
    private(set) var planProposed = false
    /// Messages stacked behind the turn running now, for the composer's queue chip.
    private(set) var queued = 0
    /// The background jobs still running in this session, for the strip above the
    /// composer. The daemon scopes them to the chat, so the strip never draws another
    /// conversation's work.
    private(set) var jobs: [JobView] = []
    /// What `/` offers, sent with the handshake: the same list the browser draws.
    private(set) var commands: [CommandEntry] = []
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
    /// Whether the thread is the screen in front — kept by `ChatView`, which knows when a
    /// page is over it or the sessions are up. A reply that lands while this is false is
    /// unread: it arrived after the person left the chat.
    var threadOnScreen = true

    /// The running model without its vendor prefix, from the catalog's projected
    /// label when loaded or after the last `/` before the picker has been opened.
    var modelLabel: String {
        if let label = models.first(where: { $0.id == modelName })?.label {
            return label
        }
        guard let slash = modelName.lastIndex(of: "/") else { return modelName }
        return String(modelName[modelName.index(after: slash)...])
    }

    /// Counters, not flags: a haptic fires on an edge, so what it watches is the
    /// moment the answer begins and the moment it lands. `busy` cannot be the
    /// trigger — it goes up on the send — and neither can `turn-start`, which the
    /// daemon sends on acknowledging the send, still the person's own thumb. The
    /// beginning is the turn's first output, whenever that arrives.
    private(set) var answerBegan = 0
    private(set) var answerEnded = 0
    /**
     How many times the daemon said to re-read a folder: a session anywhere in the install
     beginning or ending a turn, or a step in one that may have changed what is on disk. The
     Work screen re-reads a folder's tree, changes and rules on it — the same signal that
     moves the running dot beside a session.
     */
    private(set) var workMoved = 0
    private(set) var connection: MiloClient.State = .idle
    /**
     Whether the socket is worth a line yet. Held back for a moment: leaving the app
     drops the socket and coming back dials again in a second or two, and a line that
     appears and clears inside that is a flicker about a wait that was over before it
     could be read. The hold starts when the socket goes down and not at each state on
     the way back — passing through `offline` and `connecting` is one wait, not two. A
     refusal is not a wait: the daemon answered, so it is said at once, the way it
     always was.
     */
    private var connectionSaid = false
    /**
     What the chat draws about the socket, or nothing when there is nothing worth
     saying. Read off the state rather than copied out of it when the line is earned, so
     the words always name the socket as it is now — a wait moving from `offline` to
     `connecting` says the one it is in, not the one the hold began on. An outage is
     what waits; a state the daemon itself gave — a refusal, a frame this app cannot
     read — is an answer, and answers are not held back.
     */
    var connectionLine: String? {
        switch connection {
        case .online, .idle:
            return nil
        case .refused(let reason):
            return reason
        case .unreadable:
            return connection.wording
        case .connecting, .offline:
            return connectionSaid ? connection.wording : nil
        }
    }
    private(set) var pending: (id: String, request: PermissionRequest, expiresAt: Double)?

    // The drawer.
    private(set) var sessions: [SessionSummary] = []
    private(set) var sessionsLoading = false

    // The routines, and the reminders the phone schedules from them.
    private(set) var routines: [RoutineSummary] = []
    private(set) var routinesLoading = false
    /// Why the routines could not be read, or why an action on one was refused — the
    /// Routines screen draws this where the note would land.
    private(set) var routinesError: String?
    /// A routine a tapped reminder asked to open; the Routines screen reads it, then
    /// clears it.
    var pendingRoutine: String?

    // The task lists shared across sessions.
    private(set) var taskLists: [TaskList] = []
    private(set) var taskListsLoading = false
    private(set) var taskListsSaving = false
    /// Why the task lists could not be read, or why an action on one was refused.
    private(set) var taskListsError: String?

    /// The project the open session works in, as the handshake resolved it — nil on an
    /// ordinary chat, which is what tells the two composers apart.
    private(set) var sessionProject: Project?

    // The folders a session can work in, and the sessions that ran in one.
    private(set) var projects: [Project] = []
    private(set) var projectsLoading = false
    private(set) var projectsSaving = false
    /// Bumped per read and per action, so a read already on its way — asked before a write
    /// landed — cannot overwrite the list the write answered with.
    private var projectsSeq = 0
    /// How many reads are in the air, so the spinner lasts until the last of them answers.
    private var projectsReads = 0
    /// Why the projects could not be read, or why an action on one was refused — the
    /// Work screen draws this; a change that went through is drawn by the list itself.
    private(set) var projectsError: String?
    /// Whether a read of the projects has answered at least once. Before that, a session
    /// naming a project is treated as work rather than shown under the chats: the id may
    /// still be one of them, and the wrong roof is worse than a beat of nothing.
    private(set) var projectsRead = false
    /// The session each world was last in, so the drawer's switch goes back to it: a work
    /// session cannot become a chat, so leaving one is going back to the chat last read.
    private(set) var lastChatSession: String?
    private(set) var lastWorkSession: String?
    /// A session a tapped reply notice asked to open; the chat reads it, then clears it.
    var pendingSession: String?
    /// Whether the session now opening came from such a tap. Taken back by the chat once it
    /// has landed there, so a session opened any other way still starts where it always did.
    var openedFromNotice = false
    private let notifications = PhoneNotifications.shared
    /// The system's own hold on a running turn, which is the longer one — see the type.
    private let continuedTurn = ContinuedTurn.shared

    /// The ideas the model drew from what Milo knows, for the welcome screen. Empty
    /// until the daemon draws them; the standing four stand in meanwhile.
    private(set) var ideas: [Idea] = []

    /// The lines the welcome screen draws, from what is actually here — the browser's
    /// own builder, over the session list and the ideas.
    var suggestions: [Suggestion] {
        // The chats, as the drawer lists them: a work session belongs to Work, so the
        // welcome does not offer one to pick up here. A session whose project was removed is
        // a chat like the drawer treats it, and is offered again rather than lost.
        buildSuggestions(
            sessions: sessions.filter {
                !isWorkSession($0, projects: projects, read: projectsRead)
            },
            ideas: ideas,
            currentId: sessionId
        )
    }

    // The panel beside the chat.
    /**
     What the daemon says is on the panel: its tabs, in the order they opened, and the one
     in front. Held here rather than in the view, so the frame that opens a tab and the
     screen that draws it cannot disagree about what is up — and so switching sessions
     drops it in the one place every switch goes through.
     */
    private(set) var panel: PanelView?
    /**
     Whether the panel is showing. The phone's own preference, kept the way the appearance
     and the folded tools are, and the reason is the browser's: a panel the model revealed
     is not the person's own choice about what their screen looks like. What the handshake
     brings back is the tabs; whether they are covered comes from here.
     */
    var panelOpen = UserDefaults.standard.object(forKey: AppModel.panelOpenKey) as? Bool ?? false {
        didSet { UserDefaults.standard.set(panelOpen, forKey: Self.panelOpenKey) }
    }
    private static let panelOpenKey = "panel-open"

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
    /// The words a fork or an early send on a fresh session owes: sent once the socket is
    /// speaking to the new session, together with the names of whatever files it carried —
    /// the bytes are already with the daemon, so the ids are what is left to hand over.
    private var owed: String?
    private var owedIntent: ClientFrame.Intent?
    private var owedUploads: [String] = []
    private var reopening = false
    /// Whether the thread on screen is the one being left, kept until the socket hands
    /// over the session being opened. It tells the handshake's own "the person already
    /// spoke in this fresh session" rule that these words are not that session's.
    private var threadKept = false

    private var account: Account? {
        if case .chat(let account) = phase { return account }
        return nil
    }

    init() {
        client.onState = { [weak self] state in self?.moved(to: state) }
        client.onFrame = { [weak self] frame in self?.received(frame) }
        client.onSendFailed = { [weak self] in self?.unsent() }
        // A tapped notice names something to open: the routine a reminder was about, or the
        // session a reply's answer is in. A tap that came to launch the app can arrive
        // before this model is listening — the notice keeps it, and it is claimed here.
        notifications.onTap = { [weak self] tapped in self?.opened(tapped) }
        if let waited = notifications.takePendingTap() { opened(waited) }
    }

    /// A tapped notice names what to open; this is the one place that reading is made.
    private func opened(_ tapped: PhoneNotifications.Tapped) {
        switch tapped {
        case .routine(let id): pendingRoutine = id
        case .session(let id): pendingSession = id
        }
    }

    func load() async {
        if let account = AccountStore.load() {
            phase = .chat(account)
            // The list the daemon last answered with, so a launch while it is down still
            // names the sessions that were there. The refresh below replaces it.
            restoreSessions()
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
        case .online:
            clearHold()
            Task { await refreshTaskLists() }
            Task { await refreshProjects() }
            Task { await refreshRoutines() }
        case .idle:
            clearHold()
        case .refused, .unreadable:
            // The daemon spoke, so this is an answer rather than an outage: it is said at
            // once, and `connectionLine` reads its words — a reason it gave, or this app's
            // own account of a frame it could not make out — straight off the state.
            clearHold()
            if reopening {
                reopening = false
                if owed != nil {
                    owed = nil
                    owedIntent = nil
                    owedUploads = []
                    busy = false
                    unsent()
                }
            }
        case .connecting, .offline:
            // Already holding: this is the same outage passing through another state,
            // and the line reads whatever the socket is doing when the hold expires.
            guard lineWork == nil else { return }
            lineWork = Task { [weak self] in
                try? await Task.sleep(for: Self.lineDelay)
                guard !Task.isCancelled, let self else { return }
                self.lineWork = nil
                self.connectionSaid = true
            }
        }
    }

    private func clearHold() {
        lineWork?.cancel()
        lineWork = nil
        connectionSaid = false
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
        // Opened on a fresh conversation, like every other session this app opens: the
        // app starts on a new session, and a conversation the daemon is still bound to
        // — one with a turn that outlived the app running on it — would otherwise
        // replay that session instead of a new one.
        reopening = true
        var next = account
        next.chatId = AccountStore.freshChatId()
        do {
            try await MiloApi.newSession(next)
            AccountStore.save(next)
            phase = .chat(next)
        } catch {
            failed(error)
            // The socket is opened either way: a daemon that could not start a session
            // leaves the conversation it does know for the socket to replay.
            next = account
        }
        client.connect(to: next)
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
                chatId: AccountStore.chatId
            )
            // Pairing a code proves only the HTTP route that mints the token. The socket
            // the chat runs on is a second upgrade and can fail where the claim went
            // through, so it is opened here: a pair that cannot connect is barred on this
            // screen, with the reason, rather than left as a chat that never comes up.
            switch await Pairing.probe(account) {
            case .online:
                AccountStore.save(account)
                pairingHost = ""
                pairingCode = ""
                phase = .chat(account)
            case .refused(let reason):
                pairingError = reason
            case .noSocket:
                pairingError = "Reached \(account.display) and got a token, but the socket at /ws never opened. A tunnel or proxy in front must forward WebSocket Upgrade, and `milo serve` must be running."
            }
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
        threadKept = false
        sessions = []
        UserDefaults.standard.removeObject(forKey: Self.sessionsCacheKey)
        ideas = []
        jobs = []
        routines = []
        taskLists = []
        taskListsError = nil
        projects = []
        projectsError = nil
        projectsRead = false
        lastChatSession = nil
        lastWorkSession = nil
        panel = nil
        pending = nil
        note = nil
        phase = .pairing
        // Nothing is running for this phone any more, so the system's hold on the turn goes
        // with the install rather than keeping the phone awake for a daemon it has left.
        continuedTurn.end()
        // The reminders belonged to the install just left; an empty sync takes them off
        // the system without touching anything else the app may hold.
        Task { await notifications.sync([]) }
    }

    // MARK: - The turn

    /// Sends as its own turn, or — with `intent` — steers the turn already running.
    ///
    /// A file the person attached goes to the daemon first, and the name it answers with is
    /// what the turn carries: the bytes ride over HTTP and only the id goes over the socket,
    /// the same two-step the browser makes. The bubble is drawn with the file at once, so
    /// the picture is the feedback while the upload is in flight rather than a wait with
    /// nothing on it. A file the daemon never got stays on the bubble and the note says so —
    /// what was attached is what the message is, even when it did not land.
    func send(_ text: String, intent: ClientFrame.Intent? = nil, drafts: [AttachmentDraft] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !drafts.isEmpty else { return }
        // The chat exists only inside a bound install, so this is the account the upload
        // goes to rather than a second source for one.
        guard let account else { return }
        // Words typed into the session being opened are the first thing said there: the
        // thread kept from the one being left goes at once, and the empty id makes this
        // bubble the thing the handshake leaves alone — the fresh-session path exactly.
        if threadKept {
            messages = []
            sessionId = ""
            threadKept = false
        }
        messages.append(
            Message(
                isUser: true,
                parts: trimmed.isEmpty ? [] : [.text(trimmed)],
                attachments: [],
                drafts: drafts,
                streaming: false
            )
        )
        guard !drafts.isEmpty else {
            deliver(trimmed, intent: intent, uploadIds: [])
            return
        }
        busy = true
        askToStayOn()
        Task {
            do {
                var ids: [String] = []
                for draft in drafts {
                    ids.append(
                        try await MiloApi.upload(draft.data, name: draft.name, mimeType: draft.mimeType, account: account)
                    )
                }
                deliver(trimmed, intent: intent, uploadIds: ids)
            } catch {
                busy = false
                failed(error)
            }
        }
    }

    /**
     Hands the message to the socket once whatever it carried has a name. Held while a fresh
     session is still completing its bind or socket handshake, so the bubble stays in place
     and the words leave as soon as the socket opens.
     */
    private func deliver(_ text: String, intent: ClientFrame.Intent?, uploadIds: [String]) {
        if reopening {
            owed = text
            owedIntent = intent
            owedUploads = uploadIds
            if !text.hasPrefix("/") || !uploadIds.isEmpty {
                busy = true
                askToStayOn()
            }
            return
        }
        // A slash command goes as its own frame, never as a turn the model answers: the
        // daemon runs it out of band and replies with a `command-result`. Sent as a turn
        // it would be handled inside the turn body and leave an empty row beside the
        // answer. No `busy` either — a command finishes at once, the daemon's own `state`
        // frame says whether anything is running. The browser's own rule. A message with a
        // file is never a command: a file has no way into one, so it goes as the turn it was
        // typed into — the same rule the browser keeps.
        if text.hasPrefix("/") && uploadIds.isEmpty {
            if !client.send(.command(text: text)) { unsent() }
            return
        }
        busy = true
        askToStayOn()
        if !client.send(.send(text: text, intent: intent, uploadIds: uploadIds)) { unsent() }
    }

    /// Sends a turn whose destination is pinned on it — how the Routines screen makes
    /// one for a chat that is not this one. Same path as any send, so the answer lands
    /// in the thread like everything else.
    func send(_ text: String, target: SendTarget) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        messages.append(Message(isUser: true, parts: [.text(trimmed)], attachments: [], streaming: false))
        busy = true
        askToStayOn()
        if !client.send(.send(text: trimmed, target: target)) { unsent() }
    }

    /**
     Asks the system to keep the phone on this turn once the screen goes, which is what the
     reply notice needs to have anything to say. Asked on the send and only there: the
     system takes a continued task from the foreground, and only for a person's own action
     — a send is exactly that.
     */
    private func askToStayOn() {
        guard notifications.replyNoticeOn else { return }
        continuedTurn.begin()
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

    // MARK: - The panel

    /// Where a panel artifact's bytes are fetched: the same inline request the browser makes,
    /// with the token in the query — a `WKWebView`, a `PDFView` and an image loader all send
    /// no header of ours.
    func panelURL(_ id: String) -> URL? {
        guard let account,
              let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let encodedToken = account.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        return account.url("/panel/\(encodedId)?t=\(encodedToken)")
    }

    /// The live browser's own stream: one request that never ends, the daemon writing a JPEG
    /// per frame and stopping when the last watcher lets go of it.
    var browserFramesURL: URL? {
        guard let account,
              let encodedToken = account.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        return account.url("/browser/frames?t=\(encodedToken)")
    }

    /// How much of a document is read before it stops. The browser's own ceiling, so a file
    /// far too big to read is cut off in the same place on both surfaces rather than each
    /// choosing a size of its own.
    private static let documentCap = 512 * 1024

    /// A document's words, for the tab that draws them. Over HTTP rather than the wire: the
    /// bytes never ride the socket, and the file is read as it is now — which is what lets
    /// an edit on the machine show the next time the tab is drawn, without reopening it.
    func panelText(_ id: String) async throws -> (text: String, truncated: Bool) {
        let data = try await panelData(id)
        let truncated = data.count > Self.documentCap
        return (String(decoding: data.prefix(Self.documentCap), as: UTF8.self), truncated)
    }

    /// A panel artifact's bytes. One request for every kind that is fetched rather than
    /// streamed, so the address, the token and what a refusal says cannot drift apart.
    func panelData(_ id: String) async throws -> Data {
        guard let url = panelURL(id) else { throw ApiError.badAddress }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else {
            throw ApiError.refused("That file could not be read from the daemon.")
        }
        return data
    }

    /// Brings a panel tab to the front. It travels to the daemon, which redraws the panel and
    /// sends it back: two screens watching one chat cannot then disagree about which tab is in
    /// front — the browser's own round trip.
    func activatePanelTab(_ key: String) {
        client.send(.panelActivate(key: key))
    }

    /// Closes a tab by key. Closing the last one takes the panel down, which is the daemon's
    /// answer to draw rather than a guess made here.
    func closePanelTab(_ key: String) {
        client.send(.panelClose(key: key))
    }

    /// A pointer or a key the person sent into the live browser. Their own act, so nothing is
    /// confirmed; where it failed, the daemon says.
    func sendPanelInput(_ input: PanelInput) {
        if !client.send(.panelInput(input)) { unsent() }
    }

    func stop() {
        client.send(.control(.stop))
    }

    /// Turns the session into a planning turn, or back. The daemon owns the state: the
    /// `plan` frame is what moves the switch, so a sibling screen agrees with this one.
    func setPlan(_ on: Bool) {
        // A switch moved now says nothing about the turn that already ran; the next
        // turn under the plan is what earns approval.
        planProposed = false
        if !client.send(.setPlan(on)) { unsent() }
    }

    /// Approves the plan. The daemon leaves plan mode and starts the execution turn, so
    /// there is no second message for the person to write.
    func approvePlan() {
        if !client.send(.approvePlan) { unsent() }
    }

    func answerPermission(allowed: Bool, remember: Bool = false) {
        guard let pending else { return }
        self.pending = nil
        client.send(.control(remember ? .always : (allowed ? .allow : .deny), id: pending.id))
    }

    // MARK: - Sessions

    /// The drawer as the daemon last described it, kept on the phone so a launch while
    /// the daemon is down still names the sessions that were there. The address it came
    /// from is part of what is kept: a list written by one install is never drawn as
    /// another's, and unpairing takes it away with the install it described.
    private struct SessionsCache: Codable {
        let daemon: String
        let sessions: [SessionSummary]
    }

    private static let sessionsCacheKey = "sessions-cache"

    func refreshSessions() async {
        guard let account else { return }
        sessionsLoading = true
        defer { sessionsLoading = false }
        do {
            let next = try await MiloApi.sessions(account).sorted { $0.updatedAt > $1.updatedAt }
            // The thread on screen is being read: a list that still calls it unread is
            // behind that look, so the mark is not drawn on the session the person is in.
            let shown = threadOnScreen ? next.map { $0.id == sessionId ? $0.looked : $0 } : next
            // The drawer is re-read whenever it opens, and a read that says exactly
            // what is already there has nothing to tell the screens: publishing it
            // again would rebuild the list under whatever is happening on screen.
            // Only a list that moved is handed over.
            if shown != sessions { sessions = shown }
            cacheSessions(account)
            note = nil
        } catch {
            failed(error)
        }
    }

    /// The session is in front of the person: the daemon records the look, and the row
    /// loses its mark here in the same move — the watermark is the install's, so the
    /// browser is cleared with it. A mark that could not be written stays where it was:
    /// reading it as seen would claim a look the daemon never recorded, and the next
    /// read of the list tells the truth.
    private func markSeen(_ id: String) async {
        guard let account, !id.isEmpty else { return }
        do {
            try await MiloApi.markSessionSeen(account, id: id)
        } catch {
            return
        }
        sessions = sessions.map { $0.id == id ? $0.looked : $0 }
        cacheSessions(account)
    }

    /// Writes down the list just read, so the next launch has it before the daemon
    /// answers — or when it cannot.
    private func cacheSessions(_ account: Account) {
        guard let data = try? JSONEncoder().encode(SessionsCache(daemon: account.display, sessions: sessions)) else {
            return
        }
        UserDefaults.standard.set(data, forKey: Self.sessionsCacheKey)
    }

    /// Brings back the list the daemon last answered with, when it was this install's.
    /// The running mark is dropped on the way in: it described a turn that may be over,
    /// and a row read from disk has no way to know.
    private func restoreSessions() {
        guard let account,
              let data = UserDefaults.standard.data(forKey: Self.sessionsCacheKey),
              let cached = try? JSONDecoder().decode(SessionsCache.self, from: data),
              cached.daemon == account.display else { return }
        sessions = cached.sessions.map(\.settled).sorted { $0.updatedAt > $1.updatedAt }
    }

    func newSession() async {
        guard let account else { return }
        // Clear the screen in the same frame the person pressed New session, so the old
        // thread does not linger while the drawer closes and the keyboard rises.
        reopening = true
        owed = nil
        owedIntent = nil
        owedUploads = []
        resetSessionState()
        let opened = await openFresh(account) { try await MiloApi.newSession($0) }
        if !opened {
            reopening = false
            owed = nil
            owedIntent = nil
            owedUploads = []
            client.connect(to: account)
        }
    }

    @discardableResult
    func resume(_ id: String) async -> Bool {
        guard let account else { return false }
        return await openFresh(account) { try await MiloApi.resumeSession($0, id: id) }
    }

    /**
     Where a session left off, for the card a long press lifts. A read: it does not open
     the session, move the chat or touch the daemon's own state, so looking at a session
     is not a visit to it. Throws, and the card says the reason rather than nothing — a
     card that went quiet would read as a session with nothing in it.
     */
    func peek(_ id: String) async throws -> [PeekLine] {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.sessionPeek(account, id: id)
    }

    /**
     Opens the session a tapped reply notice named, if one is waiting, and answers whether
     it did. A notice is about one answer in one session, so the app goes to that session
     rather than starting the fresh one it otherwise opens with — the chat calls this where
     it would have begun a new session, and again when a tap arrives with the app already
     up. The answer is also what the person came to read, so the open is marked as one of
     these and the chat lands on the end of the thread for it.
     */
    func openPendingSession() async -> Bool {
        guard let id = pendingSession else { return false }
        pendingSession = nil
        openedFromNotice = true
        let opened = await resume(id)
        // Marked only where it is true: a session that could not be opened leaves the chat
        // where it was, and the next one it opens is that person's own doing.
        if !opened { openedFromNotice = false }
        return opened
    }

    /**
     Opens a session on a conversation the daemon has not seen. The browser mints a
     conversation id for each session it opens, and the phone must too: the daemon
     leaves a scope it is already bound to alone — and will not swap the session of one
     with a turn running underneath it — so a switch, or a new session, has to be a new
     scope with the session bound to it. The account is saved only once the daemon has
     taken it, so a call that fails leaves the phone where it was — and answers whether it
     opened, which is what tells a caller the phone moved at all.
     */
    @discardableResult
    private func openFresh(_ account: Account, bind: (Account) async throws -> Void) async -> Bool {
        var next = account
        next.chatId = AccountStore.freshChatId()
        do {
            try await bind(next)
            AccountStore.save(next)
            phase = .chat(next)
            await reopen(next)
            return true
        } catch {
            failed(error)
            return false
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
                // Onto a fresh conversation, so the move lands even while a turn runs
                // on the session being left.
                var next = account
                next.chatId = AccountStore.freshChatId()
                try await MiloApi.newSession(next)
                AccountStore.save(next)
                phase = .chat(next)
                await reopen(next)
            }
            try await MiloApi.deleteSession(account, id: id)
            await refreshSessions()
        } catch {
            failed(error)
        }
    }

    /// Forgets what was said in this chat, keeping the session itself — `/clear`'s own
    /// act, offered from the session's menu. The socket is reopened so the thread is drawn
    /// from the record the daemon just emptied, never from what the app still holds.
    func clear() async {
        guard let account else { return }
        do {
            try await MiloApi.clearSession(account)
            await reopen(account)
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

    /// Taking the line back off the screen. A notice says what just happened and then gets
    /// out of the way — by the tap on its own way out, or when its own life runs out — so an
    /// action does not leave a sentence standing over the composer after it. The browser's
    /// notice keeps the same life.
    func dismissNote() {
        note = nil
    }

    /// A line the app has to say, raised from a screen: a file the daemon could not take is
    /// refused where it was chosen, rather than left to fail later where the person is not
    /// looking. A failure, like nearly every line the note carries.
    func showNote(_ text: String) {
        note = Note(text)
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
        let from = sessionId
        owed = prompt
        owedIntent = nil
        owedUploads = []
        var next = account
        next.chatId = AccountStore.freshChatId()
        do {
            try await MiloApi.forkSession(next, id: from, upToTurn: turn)
            AccountStore.save(next)
            phase = .chat(next)
            await reopen(next)
        } catch {
            owed = nil
            owedUploads = []
            failed(error)
        }
    }

    /// Clears the visible state of the session being left before opening the next one.
    /// `keepingThread` leaves the words on screen until the handshake brings the session
    /// being opened: a switch that cleared here would slide the card over an empty chat
    /// and fill it in a moment later, which reads as a flash. A fresh session clears at
    /// once instead — there is nothing of it to wait for.
    private func resetSessionState(keepingThread: Bool = false) {
        client.disconnect()
        threadKept = keepingThread
        if !keepingThread {
            messages = []
            // An empty id is the socket forgetting its session before the next one
            // answers. A kept thread keeps it too: the screen is still that session
            // until the handshake names the next, and an id going out and back in
            // would make the thread jump to its top under the card.
            sessionId = ""
        }
        pending = nil
        turnStarted = nil
        began = false
        busy = false
        planMode = false
        planProposed = false
        // The turn being left is not what this phone waits on any more: the system is let go
        // of it rather than held open for an answer this chat no longer draws.
        continuedTurn.end()
        // The ideas belonged to the session being left; the daemon draws new ones for
        // the one the socket is about to replay.
        ideas = []
        // The jobs belonged to that session too, and the handshake that follows brings
        // the new one's own — so the strip never stands showing the strip of the chat
        // that was left.
        jobs = []
        // And the panel: its tabs are the ones the session being left had open, and the
        // handshake brings the new session's own. The preference is left alone — it says
        // what this person wants, not what that session was showing.
        panel = nil
        // And the project: it belongs to the session being left, and the handshake that
        // follows says the one being opened's. A bar naming the old folder over a new chat
        // would be naming work that is not happening.
        sessionProject = nil
    }

    /// After the bound session changes, the socket is reopened so the daemon
    /// replays the session that is actually bound now.
    private func reopen(_ account: Account) async {
        if !reopening {
            reopening = true
            resetSessionState(keepingThread: true)
        }
        client.connect(to: account)
    }

    // MARK: - Routines

    /// Re-reads the routines and re-schedules the phone's reminders from what came back.
    /// The one place a reminder is written, so a routine that is paused or removed takes
    /// its reminders with it.
    func refreshRoutines() async {
        guard let account else { return }
        routinesLoading = true
        defer { routinesLoading = false }
        do {
            routines = try await MiloApi.routines(account)
            routinesError = nil
            await notifications.sync(routines)
        } catch {
            routinesError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /**
     Whether the phone may raise a notification at all: nil until the person has been
     asked. Kept here rather than read off the notifier because the screens that draw it
     — the routines list's own line, the reply notice's footer — watch this model, and a
     permission that moved behind their back would leave them saying the wrong thing.
     */
    private(set) var notificationsAllowed: Bool?

    /// Asks for the permission the reminders need, once, when that screen first opens,
    /// then schedules from the routines already read.
    func askToRemind() async {
        notificationsAllowed = await notifications.requestAuthorization()
        await notifications.sync(routines)
    }

    /// The same ask, from the control that turns the reply notice on: a switch that
    /// promises a banner is where to ask for what one needs, and the answer is taken
    /// either way so the switch can say when the phone has refused.
    func askToNotify() async {
        notificationsAllowed = await notifications.requestAuthorization()
    }

    /// The system's own reading, without prompting — what opening the settings screen
    /// reads, so a switch left on from an earlier run is not promising a banner in
    /// silence.
    func readNotificationPermission() async {
        notificationsAllowed = await notifications.authorization()
    }

    /// Fires one now and re-reads the list, so the caller can open the run it made.
    func runRoutine(_ id: String) async -> RoutineRunResult? {
        guard let account else { return nil }
        do {
            let result = try await MiloApi.runRoutine(account, id: id)
            await refreshRoutines()
            return result
        } catch {
            routinesError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    func setRoutineEnabled(_ id: String, enabled: Bool) async {
        guard let account else { return }
        do {
            try await MiloApi.setRoutineEnabled(account, id: id, enabled: enabled)
            await refreshRoutines()
        } catch {
            routinesError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func removeRoutine(_ id: String) async {
        guard let account else { return }
        do {
            try await MiloApi.removeRoutine(account, id: id)
            await refreshRoutines()
        } catch {
            routinesError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// One routine's run history and a run read back whole. Throwing rather than noted:
    /// the surface that asked keeps its own error, so a failed page never replaces the
    /// list that is already there.
    func routineRuns(_ id: String, offset: Int, limit: Int) async throws -> RoutineRuns {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.routineRuns(account, id: id, offset: offset, limit: limit)
    }

    func routineTranscript(_ id: String) async throws -> [WireMessage] {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.routineTranscript(account, id: id)
    }

    func routineFeed() async throws -> [RoutineFeedEntry] {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.routineFeed(account)
    }

    // MARK: - Task lists

    func refreshTaskLists() async {
        guard let account else { return }
        taskListsLoading = true
        defer { taskListsLoading = false }
        do {
            taskLists = try await MiloApi.taskLists(account)
            taskListsError = nil
        } catch is URLError {
            // The socket's own glass pill already speaks for a connection that is down or
            // reconnecting; saying it a second time in the list would draw two different
            // notices for one outage.
            connectionSaid = true
            taskListsError = nil
        } catch {
            taskListsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    @discardableResult
    func createTaskList(name: String) async -> Bool {
        await actOnTaskLists(["action": "create", "name": name])
    }

    @discardableResult
    func renameTaskList(name: String, newName: String) async -> Bool {
        await actOnTaskLists(["action": "rename", "name": name, "newName": newName])
    }

    @discardableResult
    func deleteTaskList(name: String) async -> Bool {
        await actOnTaskLists(["action": "delete", "name": name])
    }

    @discardableResult
    func addTaskItem(listName: String, item: String) async -> Bool {
        await actOnTaskLists(["action": "add", "name": listName, "item": item])
    }

    @discardableResult
    func completeTaskItem(listName: String, itemId: String) async -> Bool {
        await actOnTaskLists(["action": "complete", "name": listName, "itemId": itemId])
    }

    @discardableResult
    func removeTaskItem(listName: String, itemId: String) async -> Bool {
        await actOnTaskLists(["action": "remove", "name": listName, "itemId": itemId])
    }

    /// One action, the whole set back: the daemon's store is the one that decides.
    private func actOnTaskLists(_ body: [String: String]) async -> Bool {
        guard let account else { return false }
        taskListsSaving = true
        taskListsError = nil
        defer { taskListsSaving = false }
        do {
            let outcome = try await MiloApi.taskListAction(account, body)
            taskLists = outcome.lists
            return true
        } catch is URLError {
            connectionSaid = true
            return false
        } catch {
            taskListsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }

    // MARK: - Projects

    func refreshProjects() async {
        guard let account else { return }
        projectsSeq += 1
        let mine = projectsSeq
        projectsReads += 1
        projectsLoading = true
        defer {
            projectsReads -= 1
            projectsLoading = projectsReads > 0
        }
        do {
            let next = try await MiloApi.projects(account)
            // A read asked before a create, rename or remove has the older answer; the
            // write already drew the list it answered with.
            guard mine == projectsSeq else { return }
            projects = next
            projectsError = nil
            projectsRead = true
        } catch is URLError {
            guard mine == projectsSeq else { return }
            // The socket's own glass pill already speaks for a connection that is down or
            // reconnecting; saying it again in the list would draw two notices for one outage.
            connectionSaid = true
            projectsError = nil
        } catch {
            guard mine == projectsSeq else { return }
            projectsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Creating one, renaming one, and dropping one all answer the daemon's own
    /// sentence, so the screen shows what the store said instead of a wording of its own.
    @discardableResult
    func createProject(folder: String) async -> String? {
        await actOnProjects(["action": "add", "path": folder])
    }

    @discardableResult
    func renameProject(id: String, name: String) async -> String? {
        await actOnProjects(["action": "update", "id": id, "name": name])
    }

    @discardableResult
    func setProjectIcon(id: String, icon: String) async -> String? {
        await actOnProjects(["action": "update", "id": id, "icon": icon])
    }

    @discardableResult
    func removeProject(id: String) async -> String? {
        await actOnProjects(["action": "remove", "id": id])
    }

    /// One action, the whole list back: the daemon's store is the one that decides. What
    /// it answered is returned, and a refusal is left in `projectsError`.
    private func actOnProjects(_ body: [String: String]) async -> String? {
        guard let account else {
            projectsError = "This phone is not paired with a daemon — pair it again to work with projects."
            return nil
        }
        // Anything a read was already bringing back was asked before this write; its
        // answer is the older one, and drawing it would make the write look undone.
        projectsSeq += 1
        projectsSaving = true
        projectsError = nil
        defer { projectsSaving = false }
        do {
            let outcome = try await MiloApi.projectAction(account, body)
            projects = outcome.projects
            projectsRead = true
            return outcome.result
        } catch is URLError {
            connectionSaid = true
            // The pill says the connection is down; this says what it meant for the act
            // the person just took, which the pill cannot.
            projectsError = "The connection dropped before the change was saved."
            return nil
        } catch {
            projectsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    /// One level of the daemon's own folders, for the picker a project is chosen with.
    /// Throws, so the sheet that asked says the reason inside itself.
    func browseFolders(_ path: String?) async throws -> FolderListing {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.browseFolders(account, path: path)
    }

    /// A project's folder as a tree, for the Work screen. Throws, so the page that asked
    /// says the reason inside itself rather than drawing an empty folder.
    func projectTree(_ id: String) async throws -> WorkTree {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.projectTree(account, id: id)
    }

    /// A folder made in a project's folder. Throws, so the section that asked says the
    /// reason; what comes back is the whole tree, drawn without a second read.
    func projectFolder(_ id: String, parent: String, name: String) async throws -> WorkTree {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.projectFolder(account, id: id, parent: parent, name: name)
    }

    /// A folder made while choosing one, answered with the listing inside it.
    func createFolder(_ parent: String, name: String) async throws -> FolderListing {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.createFolder(account, parent: parent, name: name)
    }

    /// One page of a project's file. `offset` continues a longer file; where the page
    /// stopped and how much is left are the daemon's own numbers.
    func projectFile(_ id: String, path: String, offset: Int? = nil) async throws -> WorkFilePage {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.projectFile(account, id: id, path: path, offset: offset)
    }

    /// What a project's folder has changed, read from its own repository. Throws, so
    /// the page that asked says the reason inside itself.
    func projectDiff(_ id: String) async throws -> WorkDiff {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.projectDiff(account, id: id)
    }

    /// Whether a project's folder carries rules of its own, and the words that ask for them.
    /// Throws, so the page that asked says the reason inside itself.
    func projectRules(_ id: String) async throws -> ProjectRules {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.projectRules(account, id: id)
    }

    /// Recording what a project's folder holds now as its first state — the person's own
    /// act on their own folder, so nothing asks. Throws, and the page says the reason
    /// inside itself.
    func startTracking(_ id: String) async throws -> WorkDiff {
        guard let account else { throw ApiError.badAddress }
        return try await MiloApi.projectTrack(account, id: id)
    }

    /**
     Opens a work session in a project: `newSession`'s move, with the folder the session
     works in. The daemon binds this conversation to that project, so the chat that comes
     back to is the ordinary one, working there.
     */
    @discardableResult
    func startWorkSession(project: String, plan: Bool = false) async -> Bool {
        guard let account else { return false }
        reopening = true
        owed = nil
        owedIntent = nil
        owedUploads = []
        resetSessionState()
        let opened = await openFresh(account) { try await MiloApi.newSession($0, project: project, plan: plan) }
        if !opened {
            reopening = false
            owed = nil
            owedIntent = nil
            owedUploads = []
            client.connect(to: account)
        }
        return opened
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
    private(set) var thinking = "expanded"
    private(set) var genui = true

    // Memory
    private(set) var memoryRecallLimit: Int?
    private(set) var memoryDerive = true
    private(set) var memoryEmbedding: SettingsOverview.Embedding?
    private(set) var memoryStats: MemoryStats?
    private(set) var memoryNotes: [MemoryNote]?

    // Tools
    private(set) var searchProvider = "off"
    private(set) var googleEnabled = false
    private(set) var googleReport: GoogleReport?
    private(set) var browserEnabled = false
    private(set) var browserHeadless = false
    private(set) var browserChromePath: String?
    private(set) var browserProfileDir: String?
    private(set) var browserCdpUrl: String?
    private(set) var browserKeepSnapshots = 3
    private(set) var detectedBrowsers: [DetectedBrowser]?
    private(set) var detectedProfiles: [DetectedProfile]?
    private(set) var mcpReport: McpReport?

    // Skills
    private(set) var installedSkills: [InstalledSkill] = []
    private(set) var popularSkills: [PopularSkill] = []
    private(set) var popularSkillsLoading = false
    private(set) var skillChoices: [String]?

    // Long-running setup job (embeddings, browser download, profile copy, MCP check)
    private(set) var setupJob: SetupJobStatus?

    // What the daemon said it accepts. Without it the control offers only what is
    // running — never a set this app made up.
    private(set) var permissionModes: [String] = []
    private(set) var toolLevels: [String] = []
    private(set) var thinkingLevels: [String] = []
    private(set) var efforts: [String] = []
    private(set) var searchProviders: [String] = []

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
            thinking = overview.config?.display?.thinking ?? "expanded"
            genui = overview.config?.display?.genui ?? true

            memoryRecallLimit = overview.config?.memory?.recallLimit
            memoryDerive = overview.config?.memory?.derive ?? true
            memoryEmbedding = overview.config?.memory?.embedding
            memoryStats = overview.memoryStats

            searchProvider = overview.config?.search?.provider ?? "off"
            googleEnabled = overview.config?.google?.enabled ?? false
            googleReport = overview.google

            browserEnabled = overview.config?.browser?.enabled ?? false
            browserHeadless = overview.config?.browser?.headless ?? false
            browserChromePath = overview.config?.browser?.chromePath
            browserProfileDir = overview.config?.browser?.profileDir
            browserCdpUrl = overview.config?.browser?.cdpUrl
            browserKeepSnapshots = overview.config?.browser?.keepSnapshots ?? 3
            mcpReport = overview.mcp

            installedSkills = overview.skills ?? []

            permissionModes = overview.options?.permissionModes ?? [permissionMode]
            toolLevels = overview.options?.toolLevels ?? [toolDisplay]
            thinkingLevels = overview.options?.thinkingLevels ?? [thinking]
            efforts = overview.options?.efforts ?? [effort]
            searchProviders = overview.options?.searchProviders ?? [searchProvider]
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

    func setThinking(_ value: String) async {
        guard await write({ try await MiloApi.saveConfig($0, ["display": ["thinking": value]]) })
        else { return }
        thinking = value
    }

    func setGenui(_ value: Bool) async {
        guard await write({ try await MiloApi.saveConfig($0, ["display": ["genui": value]]) })
        else { return }
        genui = value
    }

    func setMemoryRecallLimit(_ value: Int?) async {
        let payload: Any = value ?? NSNull()
        guard await write({ try await MiloApi.saveConfig($0, ["memory": ["recallLimit": payload]]) })
        else { return }
        memoryRecallLimit = value
    }

    func setMemoryDerive(_ value: Bool) async {
        guard await write({ try await MiloApi.saveConfig($0, ["memory": ["derive": value]]) })
        else { return }
        memoryDerive = value
    }

    func setMemoryEmbeddingOpenRouter() async {
        guard await write({ try await MiloApi.saveConfig($0, ["memory": ["embedding": ["provider": "openrouter"]]]) })
        else { return }
        memoryEmbedding = SettingsOverview.Embedding(provider: "openrouter", model: nil, url: nil)
    }

    func clearMemoryEmbedding() async {
        guard await write({ try await MiloApi.saveConfig($0, ["memory": ["embedding": NSNull()]]) })
        else { return }
        memoryEmbedding = nil
    }

    func loadMemoryNotes() async {
        guard let account else { return }
        do {
            memoryNotes = try await MiloApi.memoryNotes(account)
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func forgetMemoryNote(_ id: String) async {
        guard await write({ try await MiloApi.forgetNote($0, id: id) }) else { return }
        memoryNotes?.removeAll { $0.id == id }
        await loadSettings()
    }

    func setSearchProvider(_ value: String) async {
        let payload: Any = value == "off" ? NSNull() : ["provider": value]
        guard await write({ try await MiloApi.saveConfig($0, ["search": payload]) })
        else { return }
        searchProvider = value
    }

    func setGoogleEnabled(_ value: Bool) async {
        guard await write({ try await MiloApi.saveConfig($0, ["google": ["enabled": value]]) })
        else { return }
        googleEnabled = value
    }

    func setBrowserEnabled(_ value: Bool) async {
        guard await write({ try await MiloApi.saveConfig($0, ["browser": ["enabled": value]]) })
        else { return }
        browserEnabled = value
    }

    func setBrowserHeadless(_ value: Bool) async {
        guard await write({ try await MiloApi.saveConfig($0, ["browser": ["headless": value]]) })
        else { return }
        browserHeadless = value
    }

    func setBrowserChromePath(_ value: String?) async {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let next: String? = trimmed.isEmpty ? nil : trimmed
        let payload: Any = next ?? NSNull()
        guard await write({ try await MiloApi.saveConfig($0, ["browser": ["chromePath": payload]]) })
        else { return }
        browserChromePath = next
    }

    func setBrowserProfileDir(_ value: String?) async {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let next: String? = trimmed.isEmpty ? nil : trimmed
        let payload: Any = next ?? NSNull()
        guard await write({ try await MiloApi.saveConfig($0, ["browser": ["profileDir": payload]]) })
        else { return }
        browserProfileDir = next
    }

    func setBrowserCdpUrl(_ value: String?) async {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let next: String? = trimmed.isEmpty ? nil : trimmed
        let payload: Any = next ?? NSNull()
        guard await write({ try await MiloApi.saveConfig($0, ["browser": ["cdpUrl": payload]]) })
        else { return }
        browserCdpUrl = next
    }

    func setBrowserKeepSnapshots(_ value: Int) async {
        let clamped = max(0, value)
        guard await write({ try await MiloApi.saveConfig($0, ["browser": ["keepSnapshots": clamped]]) })
        else { return }
        browserKeepSnapshots = clamped
    }

    func findBrowsers() async {
        guard let account else { return }
        settingsError = nil
        do {
            detectedBrowsers = try await MiloApi.browsers(account)
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func findProfiles() async {
        guard let account else { return }
        settingsError = nil
        do {
            detectedProfiles = try await MiloApi.profiles(account)
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func reloadMcp() async {
        guard let account else { return }
        settingsError = nil
        do {
            mcpReport = try await MiloApi.mcpReload(account)
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func toggleMcpServer(_ name: String, enabled: Bool) async {
        guard let account else { return }
        settingsError = nil
        do {
            mcpReport = try await MiloApi.mcpToggle(account, name: name, enabled: enabled)
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func loadPopularSkills() async {
        guard let account, popularSkills.isEmpty, !popularSkillsLoading else { return }
        popularSkillsLoading = true
        defer { popularSkillsLoading = false }
        if let list = try? await MiloApi.popularSkills(account) {
            popularSkills = list
        }
    }

    func clearSkillChoices() {
        skillChoices = nil
    }

    func installSkill(source: String, skill: String? = nil) async -> Bool {
        guard let account else { return false }
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        settingsError = nil
        do {
            let outcome = try await MiloApi.installSkill(account, source: trimmed, skill: skill)
            if let choices = outcome.needChoice, !choices.isEmpty {
                skillChoices = choices
                return false
            }
            skillChoices = nil
            await loadSettings()
            return true
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }

    func removeSkill(_ name: String) async {
        guard await write({ try await MiloApi.removeSkill($0, name: name) }) else { return }
        installedSkills.removeAll { $0.name == name }
        await loadSettings()
    }

    func dismissSetupJob() {
        setupJob = nil
    }

    func runSetupJob(kind: String, extra: [String: String] = [:]) async {
        guard let account else { return }
        settingsError = nil
        do {
            let jobId = try await MiloApi.startJob(account, kind: kind, extra: extra)
            while !Task.isCancelled {
                let status = try await MiloApi.jobStatus(account, id: jobId)
                setupJob = status
                if status.status != "running" {
                    if status.status == "done" {
                        await loadSettings()
                    }
                    break
                }
                try? await Task.sleep(for: .milliseconds(450))
            }
        } catch {
            settingsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
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

    // MARK: - The phone's own notice

    /**
     The reply, said on the phone when the person is not looking at the chat. Only where
     there are words to read: a banner that says Milo replied and carries nothing would not
     be the thing it names. Nothing is raised while the chat is on screen — the words are
     already in front of them. It names the session the answer is in, so a tap opens onto
     that answer rather than the fresh session this app otherwise starts on.
     */
    private func announceReply(_ words: String, session: String) async {
        guard notifications.replyNoticeOn else { return }
        guard UIApplication.shared.applicationState != .active else { return }
        await notifications.notifyReply(words, session: session)
    }

    /**
     The stretch of time iOS gives an app that has left the screen, held open while a turn
     is running so its answer can still arrive and be said: without it the app is suspended
     within seconds of leaving, the socket goes with it, and the notice could never be
     raised at all. Held for that and nothing else, so it is let go the moment the turn
     ends or the app is in front again, and the system takes it back itself.

     This is the floor rather than the whole of it: a turn that came from the person's own
     send carries a continued task, which the system can keep alive for minutes
     (`ContinuedTurn`), and one of those in hand is what this plain hold would only be a
     shorter version of.
     */
    private var backgroundHold: UIBackgroundTaskIdentifier = .invalid

    /// The app left the screen.
    func enteredBackground() {
        guard notifications.replyNoticeOn, busy, !continuedTurn.holds, backgroundHold == .invalid
        else { return }
        backgroundHold = UIApplication.shared.beginBackgroundTask(withName: "reply notice") { [weak self] in
            // Let go right here, and not on a task of its own: the system calls this handler
            // synchronously on the main thread — it blocks the app's suspension for exactly
            // this moment — and a hold still open when it returns is one the app is
            // terminated for.
            MainActor.assumeIsolated { self?.releaseBackgroundHold() }
        }
    }

    /// The app is in front again: whatever the hold was kept for is on the screen now.
    func becameActive() {
        releaseBackgroundHold()
        // The system's own device is the *background*, and a person standing in the app is
        // exactly when it takes its task back. Letting go here means that happens on the
        // app's own terms — reported as complete — rather than being surprised by a
        // cancellation, and the interface it draws goes away with it.
        continuedTurn.end()
    }

    private func releaseBackgroundHold() {
        guard backgroundHold != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundHold)
        backgroundHold = .invalid
    }

    // MARK: - Frames

    private func received(_ frame: ServerFrame) {
        switch frame {
        case .ready(let ready):
            let keptThread = threadKept
            let waitingForFirstSend = reopening && !keptThread && owed != nil && ready.messages.isEmpty && !messages.isEmpty
            threadKept = false
            reopening = false
            sessionProject = ready.project
            // Where each world was left, for the drawer's switch: a chat is a chat, and a
            // session working in a project belongs to Work.
            if ready.project == nil {
                lastChatSession = ready.sessionId
            } else {
                lastWorkSession = ready.sessionId
            }
            planMode = ready.plan ?? false
            // A reload joins the plan where it stands; a new proposal is what earns approval.
            planProposed = false
            if !waitingForFirstSend, (!messages.isEmpty || !ready.messages.isEmpty) {
                // The whole session, so a reconnect replaces rather than grows it.
                messages = ready.messages.map {
                    Message(
                        isUser: $0.role == "user",
                        parts: $0.parts,
                        attachments: $0.attachments ?? [],
                        streaming: false,
                        // The turn's own wait, read back with the words: a session opened
                        // later says how long it thought, the same line a live one drew.
                        thought: $0.thoughtMs.map { $0 / 1000 },
                        raw: $0.raw,
                        rawNoOutput: $0.rawNoOutput
                    )
                }
                // The words kept from the session being left give way to these ones as one
                // move: the screen cross-fades the two, so a session opened from the drawer
                // lands rather than appearing whole under the card.
                if keptThread {
                    withAnimation(.smooth(duration: 0.3)) { threadHandover += 1 }
                }
            }
            modelName = ready.model
            providerId = ready.provider
            // How hard the running model thinks, when this session was opened with one:
            // the handshake says so, so the composer's own control is on the right line
            // before the settings screen has ever been read.
            if let running = ready.effort { effort = running }
            sessionId = ready.sessionId
            // It is on the screen now, wherever it was opened from.
            Task { await markSeen(ready.sessionId) }
            note = nil
            pending = nil
            queued = 0
            // The jobs running when this screen opened: the strip is drawn from the
            // handshake rather than waiting for the next change to reach it.
            jobs = ready.jobs ?? []
            commands = ready.commands ?? []
            // The panel this conversation was left showing, if it was: the handshake hands
            // the tabs back, and whether they are covered comes from the preference. A
            // reload therefore brings a panel back the way it was left, never opening one
            // nobody asked for — the browser's own rule, for the browser's own reason.
            panel = ready.panel
            turnStarted = nil
            began = false
            // A turn still being written when this screen opened: its `turn-start`
            // arrived before the app was listening, so the row it is writing into is
            // opened here and the events still to come land in it. No thought time is
            // claimed — this app watched none of that thinking.
            if ready.activeTurn != nil {
                messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil, waiting: true))
            }
            // The words a fork or an early send owes go out now that the socket is ready,
            // with the names of whatever files it carried.
            if let owed {
                let intent = owedIntent
                let uploads = owedUploads
                self.owed = nil
                self.owedIntent = nil
                self.owedUploads = []
                // The bubble is already on screen when this screen holds the thread, and
                // also when the files waited here with the ids they had already earned — a
                // file cannot be picked a second time, so the words go out on the bubble
                // rather than being sent again as a copy.
                if waitingForFirstSend || !uploads.isEmpty {
                    if owed.hasPrefix("/") && uploads.isEmpty {
                        if !client.send(.command(text: owed)) { unsent() }
                    } else {
                        busy = true
                        if !client.send(.send(text: owed, intent: intent, uploadIds: uploads)) { unsent() }
                    }
                } else {
                    send(owed, intent: intent)
                }
            }
            // The routines are read at connect, so the reminders are scheduled from what
            // is actually there before the screen is ever opened.
            Task { await refreshRoutines() }
        case .turnStart:
            busy = true
            began = false
            turnStarted = Date()
            withAnimation(SettlesIn.motion) {
                messages.append(Message(isUser: false, parts: [], attachments: [], streaming: true, thought: nil, waiting: true))
            }
        case .event(_, let event):
            apply(event)
        case .permission(let id, let request, let expiresAt):
            pending = (id, request, expiresAt)
        case .permissionResult(let id, _):
            if pending?.id == id { pending = nil }
        case .turnEnd(_, let status, let raw, let rawNoOutput):
            busy = false
            // A plan turn has something to approve only when it actually put words on
            // the screen: a turn that ended in tool calls alone proposed nothing.
            if planMode, messages.last(where: { !$0.isUser })?.parts.contains(where: {
                if case .text(let text) = $0 {
                    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }
                return false
            }) == true {
                planProposed = true
            }
            answerEnded += 1
            // The answer is read only if the thread is what the screen shows, with the app
            // in front. A reply that landed after the person left the chat is exactly what
            // the unread mark is for — which is why the daemon does not mark a web turn's
            // end on its own.
            if threadOnScreen, UIApplication.shared.applicationState == .active {
                Task { await markSeen(sessionId) }
            }
            // The answer's own words, taken as the turn settles: what the phone says when
            // the chat is not what is on screen.
            var answered: String?
            /// Whether the row already carries the words the daemon gave for the failure.
            var saidWhy = false
            if let index = messages.lastIndex(where: { $0.streaming }) {
                messages[index].streaming = false
                messages[index].waiting = false
                // A call left marked running never heard back from; the line stops
                // saying it is underway rather than guessing how it went.
                messages[index].parts = AppModel.settled(messages[index].parts)
                if let raw { messages[index].raw = raw }
                if let rawNoOutput { messages[index].rawNoOutput = rawNoOutput }
                if status == "stopped" { messages[index].status = "Stopped · the partial reply was kept." }
                saidWhy = messages[index].status != nil
                answered = messages[index].prose
            }
            turnStarted = nil
            // The row keeps the provider's reason; a generic toast over it would be
            // the screen saying less than the message behind it.
            if status == "error", !saidWhy { note = Note("That turn ended in an error.") }
            // Whatever the phone was kept awake for is over. The holds are let go here —
            // after the notice, where there is one to hand over — because the app is
            // suspended soon after they end, and a post still in flight when that happens
            // is a banner nobody ever sees.
            let said = answered.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            let answeredIn = sessionId
            Task {
                if let said, !said.isEmpty { await announceReply(said, session: answeredIn) }
                releaseBackgroundHold()
                continuedTurn.end()
            }
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
            // A delivery lands in the chat that is open — a routine's answer, a
            // finished job's notice — and it is in front of the person only while that
            // chat is the screen showing.
            let seen = result.sessionId ?? sessionId
            if threadOnScreen, UIApplication.shared.applicationState == .active {
                Task { await markSeen(seen) }
            }
        case .state(let isBusy, let count):
            busy = isBusy
            queued = count
        case .plan(let on):
            planMode = on
            if !on { planProposed = false }
        case .error(let message):
            note = Note(message)
        case .suggestions(let items):
            ideas = items
        case .jobs(let running):
            jobs = running
        case .routinesChanged:
            // The daemon says a routine ran; the list and the reminders are re-read from
            // what it left rather than from the frame, which carries nothing.
            Task { await refreshRoutines() }
        case .sessionsChanged:
            // A session started or stopped a turn anywhere in the install: re-read the
            // list, which carries the running flag, rather than guess it here — and say so
            // to the screens that draw a folder's own contents.
            workMoved += 1
            Task { await refreshSessions() }
        case .workChanged:
            // A step somewhere may have changed what is on disk, with the turn still
            // running. Only the screens drawing a folder act on it: the rest re-read a
            // signal that is not about them.
            workMoved += 1
        case .panel(let view):
            // The model showed something, so it comes to the front the way it does in the
            // browser: what the surface beside the chat is for is being looked at. A null
            // frame is the panel being taken down, and it leaves the preference alone — the
            // daemon ended the tabs, not the person's own choice about their screen.
            panel = view
            if view != nil { panelOpen = true }
        case .unknown:
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
        // How long the turn waited to say anything, written the moment it does: it is
        // what the line over its thought reports, and it is the same wait a session read
        // back carries — the whole turn's own length is a different, longer number.
        if let waited = turnStarted.map({ Date().timeIntervalSince($0) }),
           let index = messages.lastIndex(where: { $0.streaming }) {
            messages[index].thought = waited
        }
    }

    private func apply(_ event: AgentEvent) {
        // Every event is a step, whether or not it draws anything: what keeps the system's
        // hold on the turn is that the work is moving, not what moved.
        continuedTurn.advance()
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
        case .verification(let text, let ok):
            beganSpeaking()
            mutatingLast { $0.parts.append(.verification(text: text, ok: ok)) }
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
        case .compacting:
            mutatingLast { $0.status = "Tidying the context…" }
        case .compacted(let ms, let folded, let tokens, let summarized):
            mutatingLast {
                $0.status = AppModel.describeCompaction(
                    folded: folded,
                    tokens: tokens,
                    ms: ms,
                    summarized: summarized
                )
            }
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
            // The turn's own row keeps the reason, not only the toast: a failure that
            // lives for nine seconds and leaves a blank bubble is a failure that looks
            // like nothing happened. The daemon writes the same words down, so a
            // reopened conversation still says it.
            mutatingLast { $0.status = "Error: \(message)" }
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

    /// What a fold came to, in the words the other surfaces use for it. Mirrors
    /// `describeCompaction` in `src/core/sessions/format.ts`, which the CLI, the bots
    /// and the browser draw from: the phone cannot import it, so the sentence is kept
    /// here beside `describeRebase` rather than made up again. The duration is this
    /// screen's own spelling of a span (`formatMs`), as `waited` already is.
    private static func describeCompaction(folded: Int, tokens: Int, ms: Int, summarized: Bool) -> String {
        let turns = "\(folded) turn\(folded == 1 ? "" : "s")"
        let took = formatMs(ms)
        return summarized
            ? "🗜 Compacted: \(turns) (~\(tokens) tokens) folded into the summary in \(took)."
            : "🗜 Compacted: \(turns) (~\(tokens) tokens) dropped — the summary call failed, so nothing was written in their place. In \(took)."
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
