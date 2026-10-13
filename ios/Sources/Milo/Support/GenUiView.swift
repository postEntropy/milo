import SwiftUI

/// A widget a turn drew, in this surface's own components. The server sends a tree of
/// primitives and not code, which is what lets the phone draw it natively instead of
/// hosting a page — and what keeps the two surfaces saying the same thing.
///
/// The reading nodes are drawn here; the controls and the arithmetic over them are the
/// pass after, which is why a widget with a slider in it appears without the slider
/// rather than not appearing at all.
struct GenUiView: View {
    let widget: GenUi

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            if let title = widget.title {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(MiloTheme.foreground)
            }
            node(widget.tree)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.four)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }

    /// The recursion is why this returns `AnyView`: a `some View` that reaches itself
    /// through another such function has no type the compiler can name. A widget is a
    /// handful of nodes, so erasing the type costs nothing worth measuring.
    private func node(_ node: GenUiNode) -> AnyView {
        switch node {
        case .unknown:
            return AnyView(EmptyView())
        case .title(let text, let size):
            return AnyView(Text(text).font(heading(size)).foregroundStyle(MiloTheme.foreground))
        case .text(let text):
            return AnyView(Text(text).font(.body).foregroundStyle(MiloTheme.foreground))
        case .box(let direction, let gap, let padding, let children):
            return AnyView(box(direction: direction, gap: gap, padding: padding, children: children))
        case .list(let items):
            return AnyView(
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                            Text("•").foregroundStyle(MiloTheme.muted)
                            Text(item).font(.body).foregroundStyle(MiloTheme.foreground)
                        }
                    }
                }
            )
        case .steps(let title, let entries):
            return AnyView(steps(title: title, entries: entries))
        case .facts(let title, let entries):
            return AnyView(facts(title: title, entries: entries))
        case .table(let columns, let rows):
            return AnyView(table(columns: columns, rows: rows))
        }
    }

    /// A row or a column, on the catalog's own 4px steps — the same scale the rest of
    /// the interface is built on, so a generated box lines up with everything else.
    private func box(direction: String?, gap: Int?, padding: Int?, children: [GenUiNode]) -> AnyView {
        let spacing = MiloTheme.Space.one * CGFloat(step(gap))
        let layout = direction == "row"
            ? AnyLayout(HStackLayout(alignment: .top, spacing: spacing))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: spacing))
        return AnyView(
            layout {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                    node(child)
                }
            }
            .padding(MiloTheme.Space.one * CGFloat(step(padding ?? 0)))
        )
    }

    private func steps(title: String?, entries: [GenUiNode.Step]) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            if let title {
                Text(title).font(.headline).foregroundStyle(MiloTheme.foreground)
            }
            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                    Text("\(index + 1)")
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                        .frame(width: 16, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.title)
                            .font(.body)
                            .foregroundStyle(MiloTheme.foreground)
                        if let detail = entry.detail {
                            Text(detail)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                }
            }
        }
    }

    private func facts(title: String?, entries: [GenUiNode.Fact]) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            if let title {
                Text(title).font(.headline).foregroundStyle(MiloTheme.foreground)
            }
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.three) {
                    Text(entry.label)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                    Spacer(minLength: MiloTheme.Space.three)
                    Text(entry.value)
                        .font(MiloTheme.Text.base.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                }
            }
        }
    }

    /// A table is wider than a phone, so it scrolls sideways rather than squeezing its
    /// columns into a column of their own.
    private func table(columns: [String], rows: [[String]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: MiloTheme.Space.five, verticalSpacing: MiloTheme.Space.two) {
                GridRow {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        Text(column)
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell)
                                .font(MiloTheme.Text.base)
                                .foregroundStyle(MiloTheme.foreground)
                        }
                    }
                }
            }
            .padding(.vertical, MiloTheme.Space.one)
        }
    }

    /// The catalog's four heading sizes, on the platform's own ladder.
    private func heading(_ size: String?) -> Font {
        switch size {
        case "sm": return .subheadline.weight(.semibold)
        case "lg": return .title3.weight(.semibold)
        case "xl": return .title2.weight(.semibold)
        default: return .headline
        }
    }

    /// The catalog's spacing steps are 1–4 on the app's scale; anything else is held to
    /// the ends of it rather than read as a number of its own.
    private func step(_ value: Int?) -> Int {
        min(max(value ?? 0, 0), 4)
    }
}
