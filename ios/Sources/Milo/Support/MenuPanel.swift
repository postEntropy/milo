import SwiftUI

/// One line of a panel: the mark it wears (when it has one), its words, an optional second
/// line naming what is currently set, and what a press does — either an action of its own or
/// a nested list of choices (`children`) opened in the same panel. `chosen` marks the line the
/// panel's subject is on now.
struct MenuRow: Identifiable {
    let title: String
    var subtitle: String? = nil
    var symbol: String? = nil
    var chosen = false
    var children: [MenuRow] = []
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
 The panel a composer control raises.

 The platform's own menu is not what this is: it folds the control it came from into itself
 as it opens, which on a control sitting inside the composer reads as the composer turning
 into the menu. This one is drawn over the composer instead, in the platform's own glass,
 with each top-level line's mark in a filled disc and the layer the chat raises under it ready
 to put it away on a tap outside.

 A row with `children` opens them inside the same glass card, so the panel grows in place
 rather than stacking a second card over the first.
 */
struct MenuPanel: View {
    let rows: [MenuRow]
    /// The `id` of the row whose submenu is open. Kept by id rather than by copying its
    /// children, so a choice made inside the submenu sees the live `chosen` mark move.
    @State private var submenu: String?

    private var activeParent: MenuRow? {
        guard let submenu else { return nil }
        return rows.first { $0.id == submenu && !$0.children.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            if let parent = activeParent {
                Button {
                    withAnimation(.spring(duration: 0.3, bounce: 0.14)) {
                        submenu = nil
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .semibold))
                        Text(parent.title)
                            .font(MiloTheme.Text.body)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(MiloTheme.muted)
                    .padding(.horizontal, MiloTheme.Space.one)
                    .padding(.vertical, MiloTheme.Space.one)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())

                ForEach(parent.children) { child in
                    line(child)
                }
            } else {
                ForEach(rows) { row in
                    line(row)
                }
            }
        }
        .padding(MiloTheme.Space.four)
        .frame(width: 268, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 32))
        .sensoryFeedback(.selection, trigger: submenu)
    }

    /// A line: its mark in the disc when the line carries one, its words, and either the
    /// chevron that opens its submenu or the tick on the one in use. Filled, as everything
    /// pressed here is — nothing on this panel wears a border.
    private func line(_ row: MenuRow) -> some View {
        Button {
            if !row.children.isEmpty {
                withAnimation(.spring(duration: 0.3, bounce: 0.14)) {
                    submenu = row.id
                }
            } else {
                row.action()
            }
        } label: {
            HStack(spacing: MiloTheme.Space.four) {
                if let symbol = row.symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(MiloTheme.foreground)
                        .frame(width: 42, height: 42)
                        .background(MiloTheme.surfaceWarm, in: Circle())
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.foreground)
                    if let subtitle = row.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: MiloTheme.Space.two)
                if !row.children.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .padding(.trailing, MiloTheme.Space.one)
                } else if row.chosen {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(MiloTheme.accent)
                        .padding(.trailing, MiloTheme.Space.one)
                }
            }
            .padding(.leading, row.symbol == nil ? MiloTheme.Space.one : 0)
            .padding(.vertical, row.symbol == nil ? MiloTheme.Space.two : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }
}
