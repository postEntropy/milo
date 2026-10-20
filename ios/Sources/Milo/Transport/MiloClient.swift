import Foundation
import MiloConnection

/**
 The socket to the daemon: the same `hello` / `ready` / frame exchange the browser
 runs, with a reconnect that backs off the same way. A phone that slept, or a
 daemon that restarted, must come back without being asked.
 */
@MainActor
final class MiloClient {
    enum State: Equatable {
        case idle
        case connecting
        case online
        case offline
        case refused(String)

        /// Bytes arrived and this app could not make a frame of them.
        case unreadable

        var wording: String {
            switch self {
            case .idle: return "Not connected"
            case .connecting: return "Connecting…"
            case .online: return "Connected"
            case .offline: return "Reconnecting…"
            case .refused(let reason): return reason
            case .unreadable: return "This app could not read a frame from the daemon. The app and the daemon may be different versions."
            }
        }
    }

    private(set) var state: State = .idle {
        didSet { if state != oldValue { onState?(state) } }
    }

    var onState: ((State) -> Void)?
    var onFrame: ((ServerFrame) -> Void)?
    /// A frame the transport would not take, after the fact — the case the return
    /// value of `send` cannot see.
    var onSendFailed: (() -> Void)?

    private var account: Account?
    private var socket: URLSessionWebSocketTask?
    private var retry = 0
    private var everOnline = false
    /// What the daemon said when it turned us away before we were ever online.
    private var refusal: String?
    private var reconnect: Task<Void, Never>?

    func connect(to account: Account) {
        self.account = account
        retry = 0
        everOnline = false
        refusal = nil
        open()
    }

    func disconnect() {
        reconnect?.cancel()
        reconnect = nil
        account = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        state = .idle
    }

    /**
     Sends a frame and says whether it left. A socket that is gone, or a send the
     transport refused, used to be swallowed whole — the message appeared on screen
     and nothing anywhere said it had never gone out. The boolean covers what is
     known now; `onSendFailed` covers the failure that arrives after.
     */
    @discardableResult
    func send(_ frame: ClientFrame) -> Bool {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: frame.json) else { return false }
        socket.send(.data(data)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in self?.onSendFailed?() }
        }
        return true
    }

    private func open() {
        guard let account, let url = account.socketURL,
              let hello = try? JSONSerialization.data(
                  withJSONObject: ClientFrame.hello(chatId: account.chatId).json
              )
        else { return }
        state = .connecting
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()
        task.send(.data(hello)) { [weak self] error in
            guard let error else { return }
            let outcome = MiloClient.outcome(task, error)
            Task { @MainActor in self?.dropped(outcome) }
        }
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, task === self.socket else { return }
                switch result {
                case .failure(let error):
                    self.dropped(MiloClient.outcome(task, error))
                case .success(let message):
                    self.handle(message)
                    self.receive(on: task)
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .string(let text): data = text.data(using: .utf8)
        case .data(let bytes): data = bytes
        @unknown default: data = nil
        }
        guard let data else { return }
        guard let frame = try? JSONDecoder().decode(ServerFrame.self, from: data) else {
            // A frame this app cannot read is a mismatch worth seeing. Dropping it
            // silently left a working socket reading "Connecting…" with nothing the
            // person could act on, and nothing to tell them what was wrong.
            state = .unreadable
            return
        }
        if case .error(let message) = frame, !everOnline {
            // A refusal arrives as an `error` before anything else — a protocol this
            // app does not speak, a frame the server would not take. It is an answer,
            // not an outage, so it is said at once and kept for the drop, rather than
            // held back for a close that may never come: a daemon that answers and
            // stays open left the screen reading "Connecting…" over its own words.
            refusal = message
            state = .refused(message)
        } else {
            // A frame arrived, so the socket is up — and that is true every time, not
            // only the first. Gating this on the first connection left the status line
            // reading "Connecting…" over a socket that was answering.
            everOnline = true
            retry = 0
            state = .online
        }
        onFrame?(frame)
    }

    /**
     How a dead socket reads, read off the transport and decided in `MiloConnection`,
     where it is tested — this file cannot be run here, so the deciding is not done here.
     */
    nonisolated private static func outcome(_ task: URLSessionWebSocketTask, _ error: Error?) -> Outcome {
        OutcomeDecision.decide(
            httpStatus: (task.response as? HTTPURLResponse)?.statusCode,
            urlError: (error as? URLError)?.code
        )
    }

    /**
     The socket ended. Reconnect with backoff — a daemon that restarted, or a phone
     that slept, must come back without being asked, so nothing here gives up on a
     daemon that simply was not there.
     */
    private func dropped(_ outcome: Outcome) {
        socket = nil
        guard account != nil else { return }
        if let refusal {
            // The daemon spoke: whatever it said is the answer.
            state = .refused(refusal)
            return
        }
        if case .refused(let reason) = outcome {
            state = .refused(reason)
            return
        }
        // Having been online, a close is a drop and reads as reconnecting. Before that
        // there is nothing to reconnect *to*: a daemon that was not up when the app
        // opened is still being reached for the first time, and naming it a reconnect
        // would say a connection this device never had. Appointing it a `connecting`
        // that keeps trying is the honest reading, and it is what spares the screen a
        // "Reconnecting…" over a socket that has yet to connect once.
        state = everOnline ? .offline : .connecting
        retry += 1
        let delay = min(0.5 * pow(2, Double(retry)), 8)
        reconnect?.cancel()
        reconnect = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.open()
        }
    }
}
