import Foundation

/**
 Where the app is pointed, and what proves it is allowed there. The token is the
 secret and lives in the keychain; the address and the conversation id are not,
 so they ride in defaults, where pairing again can change them without ceremony.
 */
struct Account: Equatable {
    var host: String
    var port: Int
    var token: String
    var conversationId: String

    var display: String { "\(host):\(port)" }

    private var hostInURL: String { host.contains(":") ? "[\(host)]" : host }

    func url(_ path: String) -> URL? {
        URL(string: "http://\(hostInURL):\(port)\(path)")
    }

    /// The socket the chat runs on, with the token in the query — a WebSocket
    /// cannot set a header, which is why the token is accepted there at all.
    var socketURL: URL? {
        var components = URLComponents()
        components.scheme = "ws"
        components.host = host
        components.port = port
        components.path = "/ws"
        components.queryItems = [URLQueryItem(name: "t", value: token)]
        return components.url
    }
}

/**
 Reads an address the way it is written: `name`, `name:7717`, `host:port`, or a
 full `http://…` pasted from the daemon's boot line. The port defaults to the one
 `milo serve` uses, so the common case is typing the host alone.
 */
func parseAddress(_ raw: String, defaultPort: Int = 7717) -> (host: String, port: Int)? {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    if let scheme = text.range(of: "://") {
        text = String(text[scheme.upperBound...])
    }
    if text.hasSuffix("/") { text.removeLast() }
    guard !text.isEmpty else { return nil }

    // An IPv6 literal, in brackets, with or without a port.
    if text.hasPrefix("[") {
        guard let close = text.firstIndex(of: "]") else { return nil }
        let host = String(text[text.index(after: text.startIndex)..<close])
        let rest = text[text.index(after: close)...]
        let port = rest.hasPrefix(":") ? Int(rest.dropFirst()) : defaultPort
        guard let port, (1...65535).contains(port) else { return nil }
        return (host, port)
    }

    let parts = text.split(separator: ":", omittingEmptySubsequences: false)
    switch parts.count {
    case 1:
        return (String(parts[0]), defaultPort)
    case 2:
        guard let port = Int(parts[1]), (1...65535).contains(port) else { return nil }
        return (String(parts[0]), port)
    default:
        // A bare IPv6 address, or something that is not an address at all.
        return text.contains(":") && text.filter { $0 == ":" }.count > 1 ? (text, defaultPort) : nil
    }
}

enum AccountStore {
    private static let hostKey = "milo.host"
    private static let portKey = "milo.port"
    private static let conversationKey = "milo.conversation"
    private static let tokenKey = "milo.token"
    /// The conversation survives unpairing: pairing again should reopen the same
    /// chat rather than start a second one beside it.
    static var conversationId: String {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: conversationKey), !existing.isEmpty { return existing }
        let made = UUID().uuidString.lowercased()
        defaults.set(made, forKey: conversationKey)
        return made
    }

    /**
     A conversation id for a session opened from here, not yet saved. The browser mints
     one per session it opens — its `conversationId` is that session's scope, never a
     fixed address — and the phone does the same: a scope the daemon is already bound
     to is left alone (and one with a turn running is not swapped underneath), so
     opening a session on a **new** scope is what makes the switch land. Saved with the
     account only once the daemon has taken it.
     */
    static func freshConversationId() -> String {
        UUID().uuidString.lowercased()
    }

    static func load() -> Account? {
        let defaults = UserDefaults.standard
        guard let token = Keychain.get(tokenKey),
              let host = defaults.string(forKey: hostKey) else { return nil }
        let port = defaults.integer(forKey: portKey)
        guard port > 0 else { return nil }
        return Account(host: host, port: port, token: token, conversationId: conversationId)
    }

    static func save(_ account: Account) {
        Keychain.set(account.token, for: tokenKey)
        let defaults = UserDefaults.standard
        defaults.set(account.host, forKey: hostKey)
        defaults.set(account.port, forKey: portKey)
        defaults.set(account.conversationId, forKey: conversationKey)
    }

    static func clear() {
        Keychain.delete(tokenKey)
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: hostKey)
        defaults.removeObject(forKey: portKey)
    }
}

/**
 The link `milo pair` draws as a QR: the address, the port and the code in one.
 Scanning it fills both fields, which is the whole point — the address is the part
 nobody wants to type. A malformed link is refused rather than half-read.
 */
struct PairingLink {
    let host: String
    let port: Int
    let code: String

    init?(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else { return nil }
        self.init(url: url)
    }

    init?(url: URL) {
        guard url.scheme == "milo", url.host == "pair" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespaces)
        }
        guard let host = value("host"), !host.isEmpty,
              let code = value("code"), code.count >= 6 else { return nil }
        let declared = value("port").flatMap(Int.init) ?? 7717
        self.host = host
        self.port = (1...65535).contains(declared) ? declared : 7717
        self.code = code
    }
}
