import Foundation

/**
 When a session last spoke, the way a list of them reads on this platform:
 relative and short. Deliberately local — the daemon's own `formatWhen` writes an
 absolute stamp, which is what the terminal wants, and this is a different
 presentation rather than a copy of that one.
 */
enum RelativeTime {
    static func when(_ timestamp: Double) -> String {
        let seconds = Date().timeIntervalSince1970 - timestamp / 1000
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        if seconds < 604_800 { return "\(Int(seconds / 86_400))d" }
        return "\(Int(seconds / 604_800))w"
    }
}
