import SwiftUI

/// One line of a panel: the mark it wears, its words, and what a press does.
struct MenuRow: Identifiable {
    let title: String
    let symbol: String
    var action: () -> Void = {}

    var id: String { title }
}

/**
 The bloom that raises and puts away a `MenuPanel` from the corner of the control that
 asked for it — scaling and unblurring out of that corner rather than fading in across the
 whole screen.
 */
struct MenuBloom: Transition {
    let anchor: UnitPoint

    func body(content: Content, phase: TransitionPhase) -> some View {
        content
            .scaleEffect(phase.isIdentity ? 1 : 0.22, anchor: anchor)
            .offset(y: phase.isIdentity ? 0 : 14)
            .blur(radius: phase.isIdentity ? 0 : 8)
            .opacity(phase.isIdentity ? 1 : 0)
    }
}

/**
 The panel a running turn's composer control raises.

 Drawn over the composer in the platform's own glass, with each line's mark in a filled
 disc and the layer the chat raises under it ready to put it away on a tap outside.
 */
struct MenuPanel: View {
    let rows: [MenuRow]

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
            ForEach(rows) { row in
                line(row)
            }
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.vertical, MiloTheme.Space.two)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl + MiloTheme.Space.five))
    }

    /// A line: its mark in the disc and its words. Filled, as everything pressed here is —
    /// nothing on this panel wears a border.
    private func line(_ row: MenuRow) -> some View {
        Button(action: row.action) {
            HStack(spacing: MiloTheme.Space.four) {
                Image(systemName: row.symbol)
                    .font(.system(size: 19, weight: .regular))
                    .foregroundStyle(MiloTheme.foreground)
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(0.10), in: Circle())
                Text(row.title)
                    .font(MiloTheme.Text.body.weight(.medium))
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
            }
            .padding(.horizontal, MiloTheme.Space.two)
            .padding(.vertical, MiloTheme.Space.two)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }
}
