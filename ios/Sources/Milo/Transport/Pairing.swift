import Foundation

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
}
