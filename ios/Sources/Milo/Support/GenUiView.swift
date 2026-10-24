import Foundation
import MiloGenUi
import SwiftUI

/// A widget a turn drew, in this surface's own components. The server sends a tree of
/// primitives and not code, which is what lets the phone draw it natively instead of
/// hosting a page — and what keeps the two surfaces saying the same thing.
///
/// The inputs hold their values here, in one map keyed by `id`, and every `text` and
/// `stat` reads from it — so moving a slider updates the numbers beside it without a
/// call to anyone. A `button` is the only way out of the widget: pressing it asks the
/// conversation to send, which is the single door back to the model.
///
/// Nothing here scrolls sideways. A table that would not fit stacks its rows; a row of
/// tabs wraps; the chart takes the width it is given and reads its points by drag.
struct GenUiView: View {
    let widget: GenUi
    let onSend: (String) -> Void

    @State private var values: GenUiValues
    /// Values the person has changed. Streaming drafts may update defaults, but never
    /// overwrite a control after it has been touched.
    @State private var touched: Set<String> = []
    /// What is typed into a `number` field, before it parses — so a half-typed value
    /// does not have to be a number for the field to hold it.
    @State private var typing: [String: String] = [:]
    @State private var attemptedForms: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(widget: GenUi, onSend: @escaping (String) -> Void) {
        self.widget = widget
        self.onSend = onSend
        _values = State(initialValue: GenUiView.initialValues(widget.tree))
    }

    var body: some View {
        let defaults = Self.initialValues(widget.tree)
        return VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            if let title = widget.title {
                GenUiInline(text: title, values: values)
                    .font(.headline)
                    .foregroundStyle(MiloTheme.foreground)
            }
            node(widget.tree)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.four)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .onChange(of: defaults) { _, next in
            for (id, value) in next where !touched.contains(id) {
                values[id] = value
            }
        }
    }

    /// The recursion is why this returns `AnyView`: a `some View` that reaches itself
    /// through another such function has no type the compiler can name. A widget is a
    /// handful of nodes, so erasing the type costs nothing worth measuring.
    private func node(_ node: GenUiNode) -> AnyView {
        switch node {
        case .unknown:
            return AnyView(EmptyView())
        case .title(let text, let size):
            return AnyView(GenUiInline(text: text, values: values).font(heading(size)).foregroundStyle(MiloTheme.foreground))
        case .text(let text):
            return AnyView(GenUiInline(text: text, values: values).font(.body).foregroundStyle(MiloTheme.foreground))
        case .divider:
            return AnyView(Rectangle().fill(MiloTheme.borderSoft).frame(height: 1))
        case .callout(let callout):
            return AnyView(calloutView(callout))
        case .badge(let badge):
            return AnyView(badgeView(badge))
        case .chart(let chart):
            // The chart reads a drag across itself; that drag is the chart's, not the drawer's.
            return AnyView(GenUiChartView(chart: chart).marksSidewaysDrag())
        case .box(let direction, let gap, let padding, let align, let wrap, let children):
            return AnyView(box(direction: direction, gap: gap, padding: padding, align: align, wrap: wrap, children: children))
        case .section(let title, let description, let children):
            return AnyView(section(title: title, description: description, children: children))
        case .timeline(let entries):
            return AnyView(timeline(entries))
        case .choiceCards(let field):
            return AnyView(choiceCards(field))
        case .textInput(let field):
            return AnyView(textInput(field))
        case .form(let children, let submit):
            return AnyView(form(children: children, submit: submit))
        case .list(let items):
            return AnyView(list(items))
        case .steps(let title, let entries):
            return AnyView(steps(title: title, entries: entries))
        case .facts(let title, let entries):
            return AnyView(facts(title: title, entries: entries))
        case .code(let code):
            return AnyView(codeView(code))
        case .table(let columns, let rows, let align):
            return AnyView(table(columns: columns, rows: rows, align: align))
        case .stat(let stat):
            return AnyView(statView(stat))
        case .progress(let progress):
            return AnyView(progressView(progress))
        case .slider(let field):
            return AnyView(sliderView(field))
        case .number(let field):
            return AnyView(numberView(field))
        case .checkbox(let field):
            return AnyView(checkboxView(field))
        case .select(let field):
            return AnyView(selectView(field))
        case .multiselect(let field):
            return AnyView(
                GenUiMultiSelectView(
                    id: field.id,
                    label: field.label,
                    options: field.options,
                    selected: choiceValue(field.id, fallback: field.values),
                    set: { setValue($1, for: $0) }
                )
            )
        case .date(let field):
            return AnyView(dateView(field))
        case .dateRange(let field):
            return AnyView(
                GenUiDateRangeView(
                    id: field.id,
                    label: field.label,
                    minDay: field.min,
                    maxDay: field.max,
                    from: dateRangeValue(field.id, fallback: (field.from, field.to)).0,
                    to: dateRangeValue(field.id, fallback: (field.from, field.to)).1,
                    set: { setValue($1, for: $0) }
                )
            )
        case .tabs(let tabs):
            return AnyView(GenUiTabsView(tabs: tabs.tabs, render: { self.node($0) }))
        case .accordion(let accordion):
            return AnyView(GenUiAccordionView(items: accordion.items, render: { self.node($0) }))
        case .button(let button):
            return AnyView(actionView(button))
        }
    }

    /// A row or a column, on the catalog's own 4px steps — the same scale the rest of
    /// the interface is built on, so a generated box lines up with everything else.
    /// A row that may wrap uses a flow instead of an `HStack`, which is what keeps a
    /// strip of stats on the screen instead of off its edge.
    private func box(direction: String?, gap: Int?, padding: Int?, align: String?, wrap: Bool, children: [GenUiNode]) -> AnyView {
        let spacing = MiloTheme.Space.one * CGFloat(step(gap))
        let content: AnyView
        if direction == "row" && wrap {
            content = AnyView(
                GenUiFlow(spacing: spacing) {
                    ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                        node(child)
                    }
                }
            )
        } else if direction == "row" {
            let alignment: VerticalAlignment = align == "center" ? .center : align == "end" ? .bottom : .top
            content = AnyView(
                HStack(alignment: alignment, spacing: spacing) {
                    ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                        node(child)
                    }
                }
            )
        } else {
            let leading: HorizontalAlignment = align == "center" ? .center : align == "end" ? .trailing : .leading
            content = AnyView(
                VStack(alignment: leading, spacing: spacing) {
                    ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                        node(child)
                    }
                }
            )
        }
        return AnyView(content.padding(MiloTheme.Space.one * CGFloat(step(padding ?? 0))))
    }

    private func list(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                    Text("•").foregroundStyle(MiloTheme.muted)
                    GenUiInline(text: item, values: values)
                        .font(.body)
                        .foregroundStyle(MiloTheme.foreground)
                }
            }
        }
    }

    private func section(title: String, description: String?, children: [GenUiNode]) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                Text(title).font(.headline).foregroundStyle(MiloTheme.foreground)
                if let description { Text(description).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted) }
            }
            ForEach(Array(children.enumerated()), id: \.offset) { _, child in node(child) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.four)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .accessibilityElement(children: .contain)
    }

    private func timeline(_ entries: [GenUiNode.TimelineEntry]) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                    Circle().fill(tone(entry.tone)).frame(width: 8, height: 8).padding(.top, 4)
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text(entry.when).font(MiloTheme.Text.meta.monospacedDigit()).foregroundStyle(MiloTheme.muted)
                        Text(entry.title).font(MiloTheme.Text.base.weight(.medium)).foregroundStyle(MiloTheme.foreground)
                        if let detail = entry.detail { Text(detail).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .topLeading) {
                    if index < entries.count - 1 {
                        GeometryReader { proxy in
                            Path { path in
                                path.move(to: CGPoint(x: 4, y: 8))
                                path.addLine(to: CGPoint(x: 4, y: proxy.size.height + MiloTheme.Space.three + 4))
                            }
                            .stroke(MiloTheme.borderSoft, lineWidth: 1)
                        }
                        .frame(width: 8)
                        .allowsHitTesting(false)
                    }
                }
            }
        }
    }

    private func choiceCards(_ field: GenUiNode.ChoiceCards) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(field.label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
            ForEach(field.options, id: \.value) { option in
                let selected = textValue(field.id, field.value ?? "") == option.value
                Button { setValue(.text(option.value), for: field.id) } label: {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text(option.title).font(MiloTheme.Text.base.weight(.medium)).foregroundStyle(MiloTheme.foreground)
                        if let detail = option.detail { Text(detail).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.three)
                    .background(selected ? MiloTheme.surfaceWarm : MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                }
                .buttonStyle(PressableStyle())
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private func textInput(_ field: GenUiNode.TextInput) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.one) {
                Text(field.label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
                if field.required { Text("*").font(MiloTheme.Text.small).foregroundStyle(MiloTheme.danger) }
            }
            Group {
                if field.multiline {
                    TextField(field.placeholder ?? "", text: limitedTextBinding(field.id, fallback: field.value ?? "", maxLength: field.maxLength), axis: .vertical).lineLimit(3...6)
                } else {
                    TextField(field.placeholder ?? "", text: limitedTextBinding(field.id, fallback: field.value ?? "", maxLength: field.maxLength))
                }
            }
            .font(MiloTheme.Text.base).foregroundStyle(MiloTheme.foreground)
            .padding(.horizontal, MiloTheme.Space.three).padding(.vertical, MiloTheme.Space.two)
            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            .overlay(RoundedRectangle(cornerRadius: MiloTheme.Radius.md).stroke(MiloTheme.borderSoft, lineWidth: 1))
        }
    }

    private func form(children: [GenUiNode], submit: GenUiNode.FormSubmit) -> some View {
        let key = submit.label + children.map { String(describing: $0) }.joined()
        let missing = requiredInputs(children).filter { textValue($0.id, $0.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            ForEach(Array(children.enumerated()), id: \.offset) { _, child in node(child) }
            if attemptedForms.contains(key), !missing.isEmpty {
                Text("Complete the required fields: \(missing.map(\.label).joined(separator: ", ")).")
                    .font(MiloTheme.Text.small).foregroundStyle(MiloTheme.danger).accessibilityAddTraits(.isStaticText)
            }
            Button {
                attemptedForms.insert(key)
                guard missing.isEmpty else { return }
                onSend(interpolate(submit.send, values))
            } label: {
                Text(submit.label).font(MiloTheme.Text.base.weight(.medium)).foregroundStyle(MiloTheme.accentOn)
                    .padding(.horizontal, MiloTheme.Space.five).frame(height: 44)
                    .background(MiloTheme.accent, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            }.buttonStyle(PressableStyle())
        }
    }

    private func requiredInputs(_ nodes: [GenUiNode]) -> [GenUiNode.TextInput] {
        nodes.flatMap { child -> [GenUiNode.TextInput] in
            switch child {
            case .textInput(let field): return field.required ? [field] : []
            case .box(_, _, _, _, _, let nested), .section(_, _, let nested), .form(let nested, _): return requiredInputs(nested)
            case .tabs(let tabs): return tabs.tabs.flatMap { requiredInputs($0.children) }
            case .accordion(let accordion): return accordion.items.flatMap { requiredInputs($0.children) }
            default: return []
            }
        }
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
                        GenUiInline(text: entry.title, values: values)
                            .font(.body)
                            .foregroundStyle(MiloTheme.foreground)
                        if let detail = entry.detail {
                            GenUiInline(text: detail, values: values)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                    if let when = entry.when {
                        Spacer(minLength: MiloTheme.Space.two)
                        Text(when)
                            .font(MiloTheme.Text.meta.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
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
                    GenUiInline(text: entry.label, values: values)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                    Spacer(minLength: MiloTheme.Space.three)
                    GenUiInline(text: entry.value, values: values)
                        .font(MiloTheme.Text.base.weight(.semibold))
                        .foregroundStyle(entry.tone.map(tone) ?? MiloTheme.foreground)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// A table is as wide as the column it was given. It never asks for a sideways
    /// scroll: three short columns fit as a grid, and anything wider (or with a cell
    /// that needs a line) becomes a stack of rows, each with its column's name.
    private func table(columns: [String], rows: [[String]], align: [String]) -> some View {
        let stacked = columns.count > 3 || rows.contains { $0.contains { $0.count > 24 } }
        return Group {
            if stacked {
                stackedTable(columns: columns, rows: rows)
            } else {
                gridTable(columns: columns, rows: rows, align: align)
            }
        }
    }

    private func gridTable(columns: [String], rows: [[String]], align: [String]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: MiloTheme.Space.four, verticalSpacing: MiloTheme.Space.two) {
            GridRow {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    Text(column)
                        .font(MiloTheme.Text.small.weight(.semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                        let end = endsAligned(align, index, cell)
                        GenUiInline(text: cell, values: values)
                            .font(MiloTheme.Text.base)
                            .foregroundStyle(MiloTheme.foreground)
                            .multilineTextAlignment(end ? .trailing : .leading)
                            .frame(maxWidth: .infinity, alignment: end ? .trailing : .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func stackedTable(columns: [String], rows: [[String]]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    if let first = row.first, !first.isEmpty {
                        GenUiInline(text: first, values: values)
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                    }
                    ForEach(Array(columns.enumerated()), id: \.offset) { index, name in
                        if index > 0 || row.first == nil {
                            HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.three) {
                                if !name.isEmpty {
                                    Text(name)
                                        .font(MiloTheme.Text.small)
                                        .foregroundStyle(MiloTheme.muted)
                                }
                                Spacer(minLength: MiloTheme.Space.three)
                                GenUiInline(text: row.indices.contains(index) ? row[index] : "", values: values)
                                    .font(MiloTheme.Text.base)
                                    .foregroundStyle(MiloTheme.foreground)
                                    .multilineTextAlignment(.trailing)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, MiloTheme.Space.three)
                if rowIndex < rows.count - 1 {
                    Rectangle().fill(MiloTheme.borderSoft).frame(height: 1)
                }
            }
        }
    }

    private func calloutView(_ callout: GenUiNode.Callout) -> some View {
        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
            Text(calloutMark(callout.tone))
                .font(MiloTheme.Text.meta.weight(.bold))
                .foregroundStyle(tone(callout.tone))
                .frame(width: 18, height: 18)
                .background(tone(callout.tone).opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                if let title = callout.title {
                    GenUiInline(text: title, values: values)
                        .font(MiloTheme.Text.base.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                }
                GenUiInline(text: callout.text, values: values)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground2)
            }
        }
        .padding(MiloTheme.Space.four)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }

    private func badgeView(_ badge: GenUiNode.Badge) -> some View {
        Text(badge.label)
            .font(MiloTheme.Text.meta.weight(.semibold))
            .foregroundStyle(tone(badge.tone))
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.one)
            .background(tone(badge.tone).opacity(0.14), in: Capsule())
    }

    private func codeView(_ code: GenUiNode.Code) -> some View {
        Text(coloured(code.text, language: code.language))
            .font(MiloTheme.Text.mono)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(MiloTheme.Space.four)
            .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
    }

    // MARK: - The controls

    /// A derived number, recomputed from the inputs on every move. A formula that does
    /// not evaluate is a dash, never a wrong number.
    private func statView(_ stat: GenUiNode.Stat) -> some View {
        let value = evaluateFormula(stat.formula, values)
        let shown = value.map {
            "\(stat.prefix ?? "")\(formatNumber($0, decimals: stat.decimals))\(stat.suffix ?? "")"
        } ?? "—"
        let delta = stat.delta.flatMap { evaluateFormula($0, values) }
        return VStack(alignment: .leading, spacing: 2) {
            Text(shown)
                .font(.title3.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : SettlesIn.motion, value: shown)
            Text(stat.label)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
            if let delta {
                Text("\(delta > 0 ? "+" : delta < 0 ? "−" : "")\(formatNumber(abs(delta)))\(stat.deltaSuffix ?? "")")
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .foregroundStyle(deltaTone(stat.deltaTone))
                    .contentTransition(.numericText())
                    .animation(reduceMotion ? nil : SettlesIn.motion, value: delta)
            }
            if let trend = stat.trend, trend.count > 1 {
                GenUiSparkline(values: trend, tone: stat.deltaTone)
            }
        }
    }

    private func progressView(_ progress: GenUiNode.Progress) -> some View {
        let value = evaluateFormula(progress.formula, values)
        let maximum = progress.max ?? 100
        let ratio = value.map { min(1, max(0, $0 / maximum)) } ?? 0
        return VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack {
                if let label = progress.label {
                    Text(label)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground2)
                }
                Spacer(minLength: MiloTheme.Space.two)
                Text(value.map { "\(formatNumber($0))\(progress.suffix ?? "")" } ?? "—")
                    .font(MiloTheme.Text.base.weight(.semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(MiloTheme.surfaceWarm)
                    Capsule()
                        .fill(progressColor(progress.tone))
                        .frame(width: geometry.size.width * ratio)
                }
            }
            .frame(height: 8)
            .animation(reduceMotion ? nil : SettlesIn.motion, value: ratio)
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
                // Dragging the knob sideways must move the value, never the sessions drawer.
                .marksSidewaysDrag()
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
        .marksSidewaysDrag()
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

    private func dateView(_ field: GenUiNode.DateField) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(field.label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
            DatePicker(
                "",
                selection: dayBinding(field.id, fallback: field.value),
                in: dayRange(field.min, field.max),
                displayedComponents: .date
            )
            .labelsHidden()
            .datePickerStyle(.compact)
            .tint(MiloTheme.accent)
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
                .foregroundStyle(button.tone == "neutral" ? MiloTheme.foreground : MiloTheme.accentOn)
                .padding(.horizontal, MiloTheme.Space.five)
                .frame(height: 44)
                .background(actionFill(button.tone), in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
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
            set: { setValue(.number($0), for: id) }
        )
    }

    private func numberText(_ id: String, fallback: Double) -> Binding<String> {
        Binding(
            get: { typing[id] ?? formatNumber(currentNumber(id, fallback)) },
            set: { raw in
                touched.insert(id)
                typing[id] = raw
                if let parsed = parseNumber(raw) { values[id] = .number(parsed) }
            }
        )
    }

    private func textBinding(_ id: String, fallback: String) -> Binding<String> {
        Binding(
            get: { if case .text(let value)? = values[id] { return value }; return fallback },
            set: { setValue(.text($0), for: id) }
        )
    }

    private func limitedTextBinding(_ id: String, fallback: String, maxLength: Int?) -> Binding<String> {
        Binding(get: { textValue(id, fallback) }, set: { raw in
            let value = maxLength.map { String(raw.prefix($0)) } ?? raw
            setValue(.text(value), for: id)
        })
    }

    private func flagBinding(_ id: String, fallback: Bool?) -> Binding<Bool> {
        Binding(
            get: { if case .flag(let value)? = values[id] { return value }; return fallback ?? false },
            set: { setValue(.flag($0), for: id) }
        )
    }

    private func textValue(_ id: String, _ fallback: String) -> String {
        if case .text(let value)? = values[id] { return value }
        return fallback
    }

    private func dayBinding(_ id: String, fallback: String) -> Binding<Date> {
        Binding(
            get: { parseDay(textValue(id, fallback)) ?? Date() },
            set: { setValue(.text(formatDay($0)), for: id) }
        )
    }

    private func choiceValue(_ id: String, fallback: [String]) -> [String] {
        if case .choices(let selected)? = values[id] { return selected }
        return fallback
    }

    private func dateRangeValue(_ id: String, fallback: (String, String)) -> (String, String) {
        if case .dateRange(let from, let to)? = values[id] { return (from, to) }
        return fallback
    }

    private func setValue(_ value: GenUiValue, for id: String) {
        touched.insert(id)
        values[id] = value
    }

    private func dayRange(_ from: String?, _ to: String?) -> ClosedRange<Date> {
        let low = from.flatMap(parseDay) ?? Date.distantPast
        let high = to.flatMap(parseDay) ?? Date.distantFuture
        return low <= high ? low...high : low...low
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
        case .box(_, _, _, _, _, let children):
            for child in children { collect(child, into: &values) }
        case .section(_, _, let children), .form(let children, _):
            for child in children { collect(child, into: &values) }
        case .tabs(let tabs):
            for tab in tabs.tabs { for child in tab.children { collect(child, into: &values) } }
        case .accordion(let accordion):
            for item in accordion.items { for child in item.children { collect(child, into: &values) } }
        case .slider(let field):
            values[field.id] = .number(field.value)
        case .number(let field):
            values[field.id] = .number(field.value)
        case .checkbox(let field):
            values[field.id] = .flag(field.value ?? false)
        case .select(let field):
            values[field.id] = .text(field.value)
        case .multiselect(let field):
            values[field.id] = .choices(field.values)
        case .date(let field):
            values[field.id] = .text(field.value)
        case .dateRange(let field):
            values[field.id] = .dateRange(field.from, field.to)
        case .textInput(let field):
            values[field.id] = .text(field.value ?? "")
        case .choiceCards(let field):
            values[field.id] = .text(field.value ?? "")
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

    // MARK: - Tones

    private func tone(_ name: String?) -> Color {
        switch name {
        case "ok", "good": return MiloTheme.success
        case "warn": return MiloTheme.warning
        case "danger", "bad": return MiloTheme.danger
        case "info": return MiloTheme.secondary
        default: return MiloTheme.muted
        }
    }

    private func deltaTone(_ name: String?) -> Color { tone(name) }

    private func progressColor(_ name: String?) -> Color {
        switch name {
        case "ok": return MiloTheme.success
        case "warn": return MiloTheme.warning
        case "danger": return MiloTheme.danger
        case "neutral": return MiloTheme.foreground2
        default: return MiloTheme.accent
        }
    }

    private func actionFill(_ name: String?) -> Color {
        switch name {
        case "neutral": return MiloTheme.surfaceWarm
        case "danger": return MiloTheme.danger
        default: return MiloTheme.accent
        }
    }

    private func endsAligned(_ align: [String], _ index: Int, _ cell: String) -> Bool {
        if align.indices.contains(index) { return align[index] == "end" }
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        return trimmed.range(of: #"^-?[$€£]?[\d.,]+\s*[%A-Za-z]{0,3}$"#, options: .regularExpression) != nil
    }

    private func calloutMark(_ name: String?) -> String {
        switch name {
        case "ok": return "✓"
        case "warn", "danger": return "!"
        default: return "i"
        }
    }
}

// MARK: - Pieces that carry state of their own

/// Several choices, in chips that wrap instead of running off the edge.
private struct GenUiMultiSelectView: View {
    let id: String
    let label: String
    let options: [String]
    let selected: [String]
    let set: (String, GenUiValue) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 84), spacing: MiloTheme.Space.two)],
                alignment: .leading,
                spacing: MiloTheme.Space.two
            ) {
                ForEach(options, id: \.self) { option in
                    let on = selected.contains(option)
                    Button { toggle(option) } label: {
                        Text(option)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(on ? MiloTheme.accentOn : MiloTheme.foreground2)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .frame(maxWidth: .infinity, minHeight: 32)
                            .background(on ? MiloTheme.accent : MiloTheme.surfaceWarm, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        .animation(reduceMotion ? nil : SettlesIn.motion, value: selected)
    }

    private func toggle(_ option: String) {
        let next = selected.contains(option) ? selected.filter { $0 != option } : selected + [option]
        set(id, .choices(next))
    }
}

/// Parts read one at a time, under a row of labels that wraps rather than scrolls.
private struct GenUiTabsView: View {
    let tabs: [GenUiNode.Tab]
    let render: (GenUiNode) -> AnyView

    @State private var active = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 84), spacing: MiloTheme.Space.two)],
                alignment: .leading,
                spacing: MiloTheme.Space.two
            ) {
                ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                    let on = index == active
                    Button { withAnimation(reduceMotion ? nil : SettlesIn.motion) { active = index } } label: {
                        Text(tab.label)
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(on ? MiloTheme.foreground : MiloTheme.muted)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .frame(maxWidth: .infinity, minHeight: 32)
                            .background(on ? MiloTheme.surfaceRaised : MiloTheme.surfaceWarm, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
                ForEach(Array(tabs[active].children.enumerated()), id: \.offset) { _, child in
                    render(child)
                }
            }
            .id(active)
            .transition(.opacity)
            .animation(reduceMotion ? nil : SettlesIn.motion, value: active)
        }
    }
}

/// Sections folded under their own titles. The title row is the control — no chevron,
/// no plus sign: the whole width is the affordance.
private struct GenUiAccordionView: View {
    let items: [GenUiNode.AccordionItem]
    let render: (GenUiNode) -> AnyView

    @State private var open: Set<Int>
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(items: [GenUiNode.AccordionItem], render: @escaping (GenUiNode) -> AnyView) {
        self.items = items
        self.render = render
        let asked = items.indices.filter { items[$0].open == true }
        _open = State(initialValue: Set(asked.isEmpty ? [0] : asked))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    Button {
                        withAnimation(reduceMotion ? nil : SettlesIn.motion) { toggle(index) }
                    } label: {
                        Text(item.title)
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open.contains(index) {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
                                render(child)
                            }
                        }
                        .padding(.bottom, MiloTheme.Space.three)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                .padding(.vertical, MiloTheme.Space.three)
                if index < items.count - 1 {
                    Rectangle().fill(MiloTheme.borderSoft).frame(height: 1)
                }
            }
        }
    }

    private func toggle(_ index: Int) {
        if open.contains(index) {
            open.remove(index)
        } else {
            open.insert(index)
        }
    }
}

/// A span of days: two compact pickers beside each other, and stacked when the column
/// is too narrow for both.
private struct GenUiDateRangeView: View {
    let id: String
    let label: String
    let minDay: String?
    let maxDay: String?
    let from: String
    let to: String
    let set: (String, GenUiValue) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(label).font(MiloTheme.Text.small).foregroundStyle(MiloTheme.muted)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MiloTheme.Space.two) {
                    picker(true)
                    Text("–").foregroundStyle(MiloTheme.muted)
                    picker(false)
                }
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    picker(true)
                    picker(false)
                }
            }
        }
    }

    private func picker(_ isStart: Bool) -> some View {
        let value = isStart ? from : to
        let binding = Binding<Date>(
            get: { parseDay(value) ?? Date() },
            set: { set(id, .dateRange(isStart ? formatDay($0) : from, isStart ? to : formatDay($0))) }
        )
        return DatePicker("", selection: binding, in: range, displayedComponents: .date)
            .labelsHidden()
            .datePickerStyle(.compact)
            .tint(MiloTheme.accent)
    }

    private var range: ClosedRange<Date> {
        let low = minDay.flatMap(parseDay) ?? Date.distantPast
        let high = maxDay.flatMap(parseDay) ?? Date.distantFuture
        return low <= high ? low...high : low...low
    }

}

/// A row that wraps its children onto the next line instead of running past the edge.
private struct GenUiFlow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += line + spacing
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += line + spacing
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// A day written `YYYY-MM-DD`, read on the machine's own calendar.
private func parseDay(_ text: String) -> Date? {
    let parts = text.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
}

/// A day back as `YYYY-MM-DD`, the one shape the catalog accepts.
private func formatDay(_ date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
}
