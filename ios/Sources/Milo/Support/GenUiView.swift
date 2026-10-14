import SwiftUI
import MiloGenUi

/// A widget a turn drew, in this surface's own components. The server sends a tree of
/// primitives and not code, which is what lets the phone draw it natively instead of
/// hosting a page — and what keeps the two surfaces saying the same thing.
///
/// The inputs hold their values here, in one map keyed by `id`, and every `text` and
/// `stat` reads from it — so moving a slider updates the numbers beside it without a
/// call to anyone. A `button` is the only way out of the widget: pressing it asks the
/// conversation to send, which is the single door back to the model.
struct GenUiView: View {
    let widget: GenUi
    let onSend: (String) -> Void

    @State private var values: GenUiValues
    /// What is typed into a `number` field, before it parses — so a half-typed value
    /// does not have to be a number for the field to hold it.
    @State private var typing: [String: String] = [:]

    init(widget: GenUi, onSend: @escaping (String) -> Void) {
        self.widget = widget
        self.onSend = onSend
        _values = State(initialValue: GenUiView.initialValues(widget.tree))
    }

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
            // Interpolated as the browser does it: a `{id}` shows the value its input
            // carries at this moment.
            return AnyView(Text(interpolate(text, values)).font(.body).foregroundStyle(MiloTheme.foreground))
        case .box(let direction, let gap, let padding, let children):
            return AnyView(box(direction: direction, gap: gap, padding: padding, children: children))
        case .list(let items):
            return AnyView(
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                            Text("•").foregroundStyle(MiloTheme.muted)
                            Text(interpolate(item, values)).font(.body).foregroundStyle(MiloTheme.foreground)
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
        case .stat(let stat):
            return AnyView(statView(stat))
        case .slider(let field):
            return AnyView(sliderView(field))
        case .number(let field):
            return AnyView(numberView(field))
        case .checkbox(let field):
            return AnyView(checkboxView(field))
        case .select(let field):
            return AnyView(selectView(field))
        case .button(let button):
            return AnyView(actionView(button))
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
        .marksScrollBox()
    }

    // MARK: - The controls

    /// A derived number, recomputed from the inputs on every move. A formula that does
    /// not evaluate is a dash, never a wrong number.
    private func statView(_ stat: GenUiNode.Stat) -> some View {
        let value = evaluateFormula(stat.formula, values)
        let shown = value.map {
            "\(stat.prefix ?? "")\(formatNumber($0, decimals: stat.decimals))\(stat.suffix ?? "")"
        } ?? "—"
        return VStack(alignment: .leading, spacing: 2) {
            Text(shown)
                .font(.title3.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Text(stat.label)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
        }
    }

    private func sliderView(_ field: GenUiNode.Slider) -> some View {
        // A range the platform will take: an equal or inverted pair would otherwise
        // trap, and a zero or negative step is not a step.
        let step = (field.step ?? 1) > 0 ? (field.step ?? 1) : 1
        let upper = field.max > field.min ? field.max : field.min + 1
        return VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack {
                Text(field.label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
                Spacer(minLength: MiloTheme.Space.two)
                Text(formatted(field.prefix, currentNumber(field.id, field.value), field.suffix))
                    .font(MiloTheme.Text.base.weight(.semibold))
                    .foregroundStyle(MiloTheme.foreground)
            }
            Slider(value: numberBinding(field.id, fallback: field.value), in: field.min...upper, step: step)
                .tint(MiloTheme.accent)
        }
    }

    private func numberView(_ field: GenUiNode.NumberField) -> some View {
        let affix = "\(field.prefix ?? "")\(field.suffix ?? "")"
        return VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(field.label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
            HStack(spacing: MiloTheme.Space.two) {
                TextField("", text: numberText(field.id, fallback: field.value))
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .padding(.horizontal, MiloTheme.Space.three)
                    .padding(.vertical, MiloTheme.Space.two)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                            .stroke(MiloTheme.borderSoft, lineWidth: 1)
                    )
                if !affix.isEmpty {
                    Text(affix).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
                }
            }
        }
    }

    private func checkboxView(_ field: GenUiNode.Checkbox) -> some View {
        Toggle(isOn: flagBinding(field.id, fallback: field.value)) {
            Text(field.label).font(MiloTheme.Text.base).foregroundStyle(MiloTheme.foreground)
        }
        .tint(MiloTheme.accent)
    }

    private func selectView(_ field: GenUiNode.Select) -> some View {
        HStack(spacing: MiloTheme.Space.two) {
            Text(field.label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
            Spacer(minLength: MiloTheme.Space.two)
            Picker("", selection: textBinding(field.id, fallback: field.value)) {
                ForEach(field.options, id: \.self) { option in
                    Text(option).tag(option)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .tint(MiloTheme.foreground)
        }
    }

    /// The one door back to the model: the message is the model's own, with the state
    /// the person set filled in. The control hugs its label, as the browser draws it —
    /// a widget with a row of buttons must not read as a stack of full-width bars.
    private func actionView(_ button: GenUiNode.Button) -> some View {
        Button {
            onSend(interpolate(button.send, values))
        } label: {
            Text(button.label)
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.accentOn)
                .padding(.horizontal, MiloTheme.Space.five)
                .frame(height: 44)
                .background(MiloTheme.accent, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        }
        .buttonStyle(PressableStyle())
    }

    // MARK: - The values the nodes read

    /// The number an input holds now, or the value it was given.
    private func currentNumber(_ id: String, _ fallback: Double) -> Double {
        if case .number(let value)? = values[id] { return value }
        return fallback
    }

    private func numberBinding(_ id: String, fallback: Double) -> Binding<Double> {
        Binding(
            get: { currentNumber(id, fallback) },
            set: { values[id] = .number($0) }
        )
    }

    private func numberText(_ id: String, fallback: Double) -> Binding<String> {
        Binding(
            get: { typing[id] ?? formatNumber(currentNumber(id, fallback)) },
            set: { raw in
                typing[id] = raw
                if let parsed = parseNumber(raw) { values[id] = .number(parsed) }
            }
        )
    }

    private func textBinding(_ id: String, fallback: String) -> Binding<String> {
        Binding(
            get: { if case .text(let value)? = values[id] { return value }; return fallback },
            set: { values[id] = .text($0) }
        )
    }

    private func flagBinding(_ id: String, fallback: Bool?) -> Binding<Bool> {
        Binding(
            get: { if case .flag(let value)? = values[id] { return value }; return fallback ?? false },
            set: { values[id] = .flag($0) }
        )
    }

    private func formatted(_ prefix: String?, _ value: Double, _ suffix: String?) -> String {
        "\(prefix ?? "")\(formatNumber(value))\(suffix ?? "")"
    }

    /// A typed value read as a number, its decimal mark either way so a keyboard that
    /// offers a comma still works.
    private func parseNumber(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }

    /// The starting values of a tree: every input's own default, by id.
    static func initialValues(_ node: GenUiNode) -> GenUiValues {
        var values: GenUiValues = [:]
        collect(node, into: &values)
        return values
    }

    private static func collect(_ node: GenUiNode, into values: inout GenUiValues) {
        switch node {
        case .box(_, _, _, let children):
            for child in children { collect(child, into: &values) }
        case .slider(let field):
            values[field.id] = .number(field.value)
        case .number(let field):
            values[field.id] = .number(field.value)
        case .checkbox(let field):
            values[field.id] = .flag(field.value ?? false)
        case .select(let field):
            values[field.id] = .text(field.value)
        default:
            break
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
