import Charts
import MiloGenUi
import SwiftUI

/// A series drawn as a shape, and a small line under a figure.
///
/// The chart takes the column it is given and never scrolls sideways: the phone's
/// answer to a series that does not fit is fewer axis labels and a drag that reads the
/// nearest point, not a second axis off the screen. The range is `MiloGenUi`'s, so the
/// browser scales the same bars to the same heights.
struct GenUiChartView: View {
    let chart: GenUiNode.Chart

    @State private var picked: Int?
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var bounds: ChartBounds { chartBounds(chart.series.map(\.values), zero: chart.type == "bar") }
    private var names: [String] {
        chart.series.enumerated().map { $0.element.label ?? "Series \($0.offset + 1)" }
    }
    private var colors: [Color] { [MiloTheme.accent, MiloTheme.secondary] }
    private var height: CGFloat { chart.height == "sm" ? 96 : chart.height == "lg" ? 200 : 150 }
    private var axisValues: [Double] { [bounds.min, (bounds.min + bounds.max) / 2, bounds.max] }

    /// One categorical x value per label. Bars group side by side only on a category
    /// axis — a numeric one makes Swift Charts stack them — and the zero-width space
    /// keeps two identical labels in bands of their own. The axis and the readout
    /// still show the label itself.
    private var categories: [String] {
        chart.labels.indices.map { "\(chart.labels[$0])\u{200B}\($0)" }
    }
    private var axisCategories: [String] {
        chart.labels.count > 7
            ? categories.enumerated().filter { $0.offset % 2 == 0 }.map(\.element)
            : categories
    }
    private func label(for category: String) -> String {
        categories.firstIndex(of: category).map { chart.labels[$0] } ?? category
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            readout
                .frame(height: 16, alignment: .leading)
            Chart {
                ForEach(Array(categories.enumerated()), id: \.offset) { index, category in
                    ForEach(Array(chart.series.enumerated()), id: \.offset) { seriesIndex, series in
                        let name = names[seriesIndex]
                        if chart.type == "bar" {
                            BarMark(
                                x: .value("Point", category),
                                y: .value("Value", series.values[index])
                            )
                            .foregroundStyle(by: .value("Series", name))
                            // Without this the series stack on one another; a bar chart
                            // compares them, so each one stands beside the others.
                            .position(by: .value("Series", name))
                            .cornerRadius(2)
                        } else {
                            LineMark(
                                x: .value("Point", category),
                                y: .value("Value", series.values[index])
                            )
                            .foregroundStyle(by: .value("Series", name))
                            .interpolationMethod(.monotone)
                            if chart.type == "area" {
                                AreaMark(
                                    x: .value("Point", category),
                                    y: .value("Value", series.values[index])
                                )
                                .foregroundStyle(by: .value("Series", name))
                                .opacity(0.14)
                            }
                        }
                    }
                }
                if let picked, categories.indices.contains(picked) {
                    RuleMark(x: .value("Point", categories[picked]))
                        .foregroundStyle(MiloTheme.foreground.opacity(0.28))
                        .lineStyle(StrokeStyle(lineWidth: 1))
                }
            }
            .chartYScale(domain: bounds.min...bounds.max)
            .chartForegroundStyleScale(domain: names, range: Array(colors.prefix(names.count)))
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: axisCategories) { value in
                    AxisGridLine().foregroundStyle(MiloTheme.borderSoft)
                    AxisValueLabel {
                        if let category = value.as(String.self) {
                            Text(label(for: category))
                                .font(MiloTheme.Text.meta)
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: axisValues) { value in
                    AxisGridLine().foregroundStyle(MiloTheme.borderSoft)
                    AxisValueLabel {
                        if let number = value.as(Double.self) {
                            Text(formatNumber(number, decimals: 0))
                                .font(MiloTheme.Text.meta)
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { drag in
                                    guard let frame = proxy.plotFrame else { return }
                                    let x = drag.location.x - geometry[frame].origin.x
                                    guard let category = proxy.value(atX: x, as: String.self),
                                          let index = categories.firstIndex(of: category)
                                    else { return }
                                    picked = index
                                }
                                .onEnded { _ in picked = nil }
                        )
                }
            }
            .frame(height: height)
            .opacity(appeared ? 1 : 0)
            .animation(reduceMotion ? nil : SettlesIn.motion, value: appeared)
            .animation(reduceMotion ? nil : SettlesIn.motion, value: picked)
            .onAppear { appeared = true }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(summary)
        }
    }

    /// The series' own names, and — while a point is held — that point's label and value.
    private var readout: some View {
        HStack(spacing: MiloTheme.Space.five) {
            if let picked, chart.labels.indices.contains(picked) {
                Text(chart.labels[picked])
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .foregroundStyle(MiloTheme.foreground)
            }
            ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                HStack(spacing: MiloTheme.Space.two) {
                    Circle()
                        .fill(colors[index % colors.count])
                        .frame(width: 6, height: 6)
                    if let label = series.label {
                        Text(label)
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    if let picked, chart.labels.indices.contains(picked) {
                        Text(shown(series.values[picked]))
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .monospacedDigit()
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func shown(_ value: Double) -> String {
        "\(chart.prefix ?? "")\(formatNumber(value, decimals: chart.decimals))\(chart.suffix ?? "")"
    }

    /// What a screen reader reads instead of the drawing.
    private var summary: String {
        let points = chart.series.enumerated().map { index, series in
            let name = names[index]
            let values = chart.labels.enumerated()
                .map { "\($0.element) \(shown(series.values[$0.offset]))" }
                .joined(separator: ", ")
            return "\(name): \(values)"
        }
        return "\(chart.type) chart. \(points.joined(separator: ". "))"
    }
}

/// The shape under a figure that already says the number: no axes, no labels, no scroll.
struct GenUiSparkline: View {
    let values: [Double]
    let tone: String?

    private var bounds: ChartBounds { chartBounds([values], zero: false) }
    private var stroke: Color {
        switch tone {
        case "good": return MiloTheme.success
        case "bad": return MiloTheme.danger
        default: return MiloTheme.muted
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let height = geometry.size.height
            let span = max(bounds.max - bounds.min, 1)
            let step = values.count > 1 ? width / CGFloat(values.count - 1) : 0
            Path { path in
                for (index, value) in values.enumerated() {
                    let point = CGPoint(
                        x: CGFloat(index) * step,
                        y: height - CGFloat((value - bounds.min) / span) * height
                    )
                    if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                }
            }
            .stroke(stroke, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 92, height: 26)
        .accessibilityHidden(true)
    }
}
