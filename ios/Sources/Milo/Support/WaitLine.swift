import SwiftUI

/**
 The wait made visible: a steady glyph and the word, with a light sweeping along the
 letters, so a screen with nothing to show yet still says it is reading — the same
 treatment the browser draws (`web/src/ui/WaitLine.tsx`), and never a number running
 under the reader: the elapsed time is said once, settled, when the turn ends.

 The word is set a step above the browser's own line, on the ladder the rest of the app
 uses: with the turn saying nothing else yet, this line is the whole of what is on the
 screen.
 */
struct WaitLine: View {
    var label = "Thinking"

    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Image(systemName: "sparkles")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(MiloTheme.muted)
            Glare(text: label, font: MiloTheme.Text.base)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Milo is working")
    }
}

/**
 A word with a band of the foreground colour travelling across it: the letters sit in
 the quiet tone and the sweep is what says the thing is live. Driven by the clock rather
 than a repeating animation, so a rebuild of the row cannot leave it stalled or restart
 it mid-travel.

 The browser's own sweep, on both the things that wear it: the wait line, and the call
 being run — where the whole line is one string, the name and its value as the server
 drew them, lit together.
 */
struct Glare: View {
    let text: String
    var font: Font = MiloTheme.Text.small
    var tone: Color = MiloTheme.muted

    /// The sweep's period — the browser's own 1.9s.
    private static let period: Double = 1.9
    /// How much of the line the lit band covers, as a fraction of its width.
    private static let band: Double = 0.32

    var body: some View {
        TimelineView(.animation) { context in
            let cycle = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: Self.period) / Self.period
            // Travelling from just off one edge to just off the other, like the browser's
            // background position running 150% → -50%.
            let centre = (1 + 2 * Self.band) * cycle - Self.band
            Text(text)
                .font(font)
                .foregroundStyle(tone)
                .overlay { sweep(centre) }
        }
    }

    /// The lit band, drawn only while it is over the word: off either edge there is
    /// nothing to light, and a gradient with all its stops collapsed would not read as
    /// plain text.
    @ViewBuilder
    private func sweep(_ centre: Double) -> some View {
        let start = Self.clamp(centre - Self.band)
        let end = Self.clamp(centre + Self.band)
        if end > 0, start < 1 {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: start),
                    .init(color: MiloTheme.foreground, location: Self.clamp(centre)),
                    .init(color: .clear, location: end),
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
            .mask { Text(text).font(font) }
        }
    }

    private static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
}
