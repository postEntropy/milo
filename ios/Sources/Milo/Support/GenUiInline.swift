import MiloGenUi
import SwiftUI

/// A string inside a widget: `{id}` filled from the inputs, and the three inline marks
/// the teaching allows. The reading is `MiloGenUi`'s, so the phone and the browser
/// split a line the same way; only the painting is this surface's.
struct GenUiInline: View {
    let text: String
    let values: GenUiValues

    var body: some View {
        Text(styled(interpolate(text, values)))
    }

    private func styled(_ text: String) -> AttributedString {
        var result = AttributedString()
        for run in inlineRuns(text) {
            var piece = AttributedString(run.text)
            switch run.style {
            case .plain:
                break
            case .bold:
                piece.inlinePresentationIntent = .stronglyEmphasized
            case .italic:
                piece.inlinePresentationIntent = .emphasized
            case .code:
                piece.inlinePresentationIntent = .code
                piece.font = MiloTheme.Text.mono
            }
            result.append(piece)
        }
        return result
    }
}
