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

    /// How long something has been running, in the short form the browser's own
    /// `formatDuration` writes (`src/util/format.ts`): seconds under a minute, then
    /// minutes and seconds, then hours. The running counter beside a background job.
    static func elapsed(_ ms: Double) -> String {
        let total = max(0, Int((ms / 1000).rounded()))
        if total < 60 { return "\(total)s" }
        let minutes = total / 60
        let seconds = total % 60
        if minutes < 60 { return seconds > 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest > 0 ? "\(hours)h \(rest)m" : "\(hours)h"
    }
}
