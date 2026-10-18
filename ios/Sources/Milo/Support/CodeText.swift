import MiloHighlight
import SwiftUI

/**
 One piece of code, coloured: the roles the shared lexer reads out of it, painted with this
 surface's own tones.

 The one place a role becomes a colour here — a fenced block in a reply, a project's file, the
 lines of a diff all come through it — so the roles and their painting cannot drift apart. The
 browser paints the same roles from the same lexer in `src/core/highlight.ts`.
 */
func coloured(_ code: String, language: String?) -> AttributedString {
    highlight(code, language: language).reduce(into: AttributedString()) { text, run in
        var piece = AttributedString(run.text)
        piece.foregroundColor = tone(run.role)
        text.append(piece)
    }
}

/// What a role of code is drawn in.
private func tone(_ role: CodeRole) -> Color {
    switch role {
    case .comment: return MiloTheme.muted
    case .keyword: return MiloTheme.codeKeyword
    case .string: return MiloTheme.codeString
    case .number: return MiloTheme.codeNumber
    case .plain: return MiloTheme.foreground2
    }
}
