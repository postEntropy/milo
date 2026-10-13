import Foundation

/// A line on the welcome screen: its mark, its words, and what a press does. The set
/// is the browser's own (`web/src/chat/suggestions.ts`), so the phone and the web
/// offer the same thing in the same order.
struct Suggestion: Identifiable, Hashable {
    /// What a press does: say the prompt as a message, or open the session it names.
    enum Act: Hashable {
        case send(String)
        case resume(String)
    }

    /// The marks the standing set names, kept as roles so no call site carries a table of
    /// its own. A generated idea brings its own SF Symbol instead.
    enum Mark {
        case history, spark, file, terminal, settings, mail, listCheck, `repeat`

        var symbol: String {
            switch self {
            case .history: return "clock.arrow.circlepath"
            case .spark: return "sparkles"
            case .file: return "doc.text"
            case .terminal: return "terminal"
            case .settings: return "gearshape"
            case .mail: return "envelope"
            case .listCheck: return "checklist"
            case .`repeat`: return "repeat"
            }
        }
    }

    /// The SF Symbol the line wears, by name — the standing set's own, or the one the
    /// model chose for a generated idea.
    let symbol: String
    let title: String
    let act: Act

    /// The title is what tells two lines apart, and the builder keeps them unique — so
    /// it is also the identity the list animates on.
    var id: String { title }
}

/// What stands on the welcome screen when nothing better is known — the web's own four.
let defaultSuggestions: [Suggestion] = [
    Suggestion(
        symbol: Suggestion.Mark.mail.symbol,
        title: "Triage my inbox",
        act: .send("Go through my inbox and tell me what actually needs me.")
    ),
    Suggestion(
        symbol: Suggestion.Mark.listCheck.symbol,
        title: "Plan today",
        act: .send("Look at my task lists and help me plan today.")
    ),
    Suggestion(
        symbol: Suggestion.Mark.`repeat`.symbol,
        title: "Set up a routine",
        act: .send("Help me set up a routine that runs on a schedule.")
    ),
    Suggestion(
        symbol: Suggestion.Mark.file.symbol,
        title: "Summarize a file",
        act: .send("Help me summarize a file in this project.")
    ),
]

/// The lines the welcome screen draws, from what is actually here: the last
/// conversation, opened again with one press, and the ideas the model drew from what
/// Milo knows. One recent session, not several — the rest of the drawer is a press
/// away, so the screen spends its slots on what is new rather than listing what is
/// already in front of the person. Ideas take the slots the standing four would hold,
/// and the standing four pad a shorter list, so the screen is never bare and never two
/// lines of the same thing.
func buildSuggestions(sessions: [SessionSummary], ideas: [Idea], currentId: String) -> [Suggestion] {
    var lines: [Suggestion] = []

    for session in sessions {
        if lines.count >= 1 { break }
        if session.id == currentId || session.messageCount == 0 { continue }
        lines.append(Suggestion(symbol: Suggestion.Mark.history.symbol, title: session.label, act: .resume(session.id)))
    }

    // A generated idea wears the SF Symbol the model chose for it, and the standing
    // spark when it named none.
    let drawn = ideas.map {
        Suggestion(symbol: $0.symbol ?? Suggestion.Mark.spark.symbol, title: $0.title, act: .send($0.prompt))
    }

    for fallback in drawn + defaultSuggestions {
        if lines.count >= 4 { break }
        if lines.contains(where: { $0.title == fallback.title }) { continue }
        lines.append(fallback)
    }

    return Array(lines.prefix(4))
}
