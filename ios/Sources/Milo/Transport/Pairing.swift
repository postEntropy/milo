import Foundation
import MiloConnection

/// What the daemon hands back for a redeemed code: the device's own token.
struct PairedDevice: Decodable {
    let deviceId: String
    let token: String
    let name: String
    let protocolVersion: Int
}

enum PairingError: LocalizedError {
    case refused(String)
    case unreachable(String)

    var errorDescription: String? {
        switch self {
        case .refused(let message), .unreachable(let message): message
        }
    }
}

/**
 Redeems a code at the daemon's `/pair/claim` — the one route that answers without
 a token — and keeps the device token that comes back. Nothing else in the app
 ever presents the install's own token: this device's is its own, and can be taken
 back on its own.
 */
enum Pairing {
    static func claim(host: String, port: Int, code: String, deviceName: String) async throws -> PairedDevice {
        let hostInURL = host.contains(":") ? "[\(host)]" : host
        guard let url = URL(string: "http://\(hostInURL):\(port)/pair/claim") else {
            throw PairingError.unreachable("That is not an address a phone can open.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "code": code,
            "name": deviceName,
            "platform": "ios",
        ])
        // A phone that cannot see the daemon should hear so, rather than wait.
        request.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw PairingError.unreachable(
                "Could not reach \(host):\(port). Is `milo serve` running, and is the address reachable from this phone?"
            )
        }
        guard let http = response as? HTTPURLResponse else {
            throw PairingError.unreachable("The daemon answered with something that was not HTTP.")
        }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw PairingError.refused(message ?? "The daemon refused the pairing (HTTP \(http.statusCode)).")
        }
        do {
            return try JSONDecoder().decode(PairedDevice.self, from: data)
        } catch {
            throw PairingError.refused("The daemon's answer could not be read.")
        }
    }

    /**
     Opens the socket the chat runs on, with the token the claim just minted, and reads
     the first thing the daemon says.

     Redeeming a code proves only the HTTP route that mints the token. The socket is a
     second upgrade, and it can fail where the claim went through — a path in front that
     forwards plain HTTP but not the WebSocket `Upgrade`, an address `/ws` does not
     answer on. The verdict is what lets the app bar a pair that cannot connect, where
     the person is standing, instead of leaving a chat that reads "Connecting…" forever.

     The socket is a throwaway: it is torn down whatever the answer, and the chat opens
     its own on the way in.
     */
    @MainActor
    static func probe(_ account: Account, timeout: TimeInterval = 8) async -> PairProbe {
        guard let url = account.socketURL,
              let hello = try? JSONSerialization.data(
                  withJSONObject: ClientFrame.hello(chatId: account.chatId).json
              )
        else { return .noSocket }
        return await PairProber(url: url, hello: hello, timeout: timeout).run()
    }
}

/**
 One throwaway socket, opened for the probe and closed on the way out. It is a class so
 the deadline and the first frame can race to the same single answer — the arm that
 loses does nothing, which is what keeps the continuation from being resumed twice.
 */
@MainActor
private final class PairProber {
    private let task: URLSessionWebSocketTask
    private let hello: Data
    private let timeout: TimeInterval
    private var continuation: CheckedContinuation<PairProbe, Never>?
    private var deadline: Task<Void, Never>?

    init(url: URL, hello: Data, timeout: TimeInterval) {
        self.task = URLSession.shared.webSocketTask(with: url)
        self.hello = hello
        self.timeout = timeout
    }

    func run() async -> PairProbe {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            task.resume()
            // The chat's own hello, byte for byte: pairing must prove the socket the
            // chat will actually open, not a look-alike.
            task.send(.data(hello)) { _ in }
            let wait = timeout
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled else { return }
                self?.expire()
            }
            receive()
        }
    }

    private func receive() {
        task.receive { [weak self] result in
            Task { @MainActor in self?.landed(result) }
        }
    }

    private func landed(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        switch result {
        case .success(let message):
            guard let data = PairProber.bytes(of: message),
                  let frame = try? JSONDecoder().decode(ServerFrame.self, from: data)
            else { finish(.noSocket); return }
            // An `error` before any other frame is the daemon turning this device away:
            // an answer, not an outage, so its own words are the verdict.
            if case .error(let message) = frame { finish(.refused(message)) } else { finish(.online) }
        case .failure(let error):
            finish(
                PairProbe.decide(
                    everOnline: false,
                    refusal: nil,
                    httpStatus: (task.response as? HTTPURLResponse)?.statusCode,
                    urlError: (error as? URLError)?.code
                )
            )
        }
    }

    private func expire() {
        finish(.noSocket)
    }

    private func finish(_ verdict: PairProbe) {
        guard let continuation else { return }
        self.continuation = nil
        deadline?.cancel()
        deadline = nil
        task.cancel(with: .goingAway, reason: nil)
        continuation.resume(returning: verdict)
    }

    private static func bytes(of message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .string(let text): return text.data(using: .utf8)
        case .data(let data): return data
        @unknown default: return nil
        }
    }
}
