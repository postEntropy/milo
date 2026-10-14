@preconcurrency import ActivityKit
import Foundation

/// The state shared by Milo and its Live Activity widget.
public struct MiloActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public enum Phase: String, Codable, Hashable, Sendable {
            case thinking
            case replying
            case complete
        }

        public let phase: Phase

        public init(phase: Phase) {
            self.phase = phase
        }
    }

    public let sessionID: String

    public init(sessionID: String) {
        self.sessionID = sessionID
    }
}
