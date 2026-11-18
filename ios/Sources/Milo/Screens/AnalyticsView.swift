import SwiftUI
import UIKit

private struct AnalyticsEvent: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let at: String
    let startedAt: String?
    let event: String
    let ok: Bool
    let ms: Double
    let model: String?
    let provider: String?
    let tool: String?
    let purpose: String?
    let session: String?
    let callId: String?
    let surface: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let ttftMs: Double?
    let error: String?

    let title: String
    let timestampMs: Double?
    let startMs: Double
    let detailsLine: String

    private enum CodingKeys: String, CodingKey {
        case id, at, startedAt, event, ok, ms, model, provider, tool, purpose, session, callId, surface, inputTokens, outputTokens, ttftMs, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        at = try container.decode(String.self, forKey: .at)
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
        event = try container.decode(String.self, forKey: .event)
        ok = try container.decode(Bool.self, forKey: .ok)
        ms = try container.decode(Double.self, forKey: .ms)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        tool = try container.decodeIfPresent(String.self, forKey: .tool)
        purpose = try container.decodeIfPresent(String.self, forKey: .purpose)
        session = try container.decodeIfPresent(String.self, forKey: .session)
        callId = try container.decodeIfPresent(String.self, forKey: .callId)
        surface = try container.decodeIfPresent(String.self, forKey: .surface)
        inputTokens = try container.decodeIfPresent(Int.self, forKey: .inputTokens)
        outputTokens = try container.decodeIfPresent(Int.self, forKey: .outputTokens)
        ttftMs = try container.decodeIfPresent(Double.self, forKey: .ttftMs)
        error = try container.decodeIfPresent(String.self, forKey: .error)

        if let tool, !tool.isEmpty {
            title = tool
        } else if let purpose, !purpose.isEmpty {
            let clean = purpose.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
            let labeled = clean.prefix(1).uppercased() + clean.dropFirst()
            if event == "model.request" { title = "\(labeled) request" }
            else if event == "embedding.request" { title = "\(labeled) embedding" }
            else { title = labeled }
        } else {
            title = EventKindFilter.displayLabel(for: event)
        }

        let parsedTimestamp = AnalyticsDate.timestampMs(from: at)
        timestampMs = parsedTimestamp
        if let startedAt, let started = AnalyticsDate.timestampMs(from: startedAt) {
            startMs = started
        } else if let parsedTimestamp {
            startMs = parsedTimestamp - max(0, ms)
        } else {
            startMs = 0
        }

        var parts: [String] = []
        if let model, !model.isEmpty { parts.append(model) }
        parts.append(duration(ms))
        if let inputTokens, let outputTokens {
            parts.append("\(inputTokens.formatted()) in / \(outputTokens.formatted()) out")
        }
        if let surface, !surface.isEmpty { parts.append(surface) }
        if let session, !session.isEmpty { parts.append(session) }
        detailsLine = parts.joined(separator: " · ")
    }

    var relativeTime: String {
        guard let timestampMs else { return at }
        return RelativeTime.when(timestampMs)
    }
}

private enum AnalyticsDate {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle(includingFractionalSeconds: false)

    @MainActor
    private static let stampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = "dd/MM/yyyy, HH:mm:ss"
        return formatter
    }()

    static func parse(_ raw: String) -> Date? {
        (try? fractional.parse(raw)) ?? (try? plain.parse(raw))
    }

    static func timestampMs(from raw: String) -> Double? {
        guard let date = parse(raw) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    @MainActor
    static func stamp(_ raw: String) -> String {
        guard let date = parse(raw) else { return raw }
        let relative = RelativeTime.when(date.timeIntervalSince1970 * 1000)
        return "\(relative) · \(stampFormatter.string(from: date))"
    }
}

private struct AnalyticsModel: Decodable, Identifiable, Equatable {
    let model: String
    let requests: Int
    let failures: Int
    let inputTokens: Int
    let outputTokens: Int
    var id: String { model }
    var totalTokens: Int { inputTokens + outputTokens }
}

private struct AnalyticsReport: Decodable, Equatable {
    let events: [AnalyticsEvent]
    let total: Int
    let requests: Int
    let embeddingRequests: Int?
    let requestsWithUsage: Int
    let failures: Int
    let inputTokens: Int
    let outputTokens: Int
    let averageMs: Double?
    let models: [AnalyticsModel]
}

private struct SessionTraceTurn: Decodable, Identifiable, Equatable {
    let id: String
    let index: Int
    let startedAt: String
    let endedAt: String
    let ms: Double
    let spanMs: Double
    let ok: Bool
    let session: String?
    let model: String?
    let surface: String?
    let requests: Int
    let toolCalls: Int
    let failures: Int
    let inputTokens: Int
    let outputTokens: Int
    let events: [AnalyticsEvent]

    var listKey: String {
        "\(session ?? ""):\(id):\(startedAt)"
    }

    var steps: [AnalyticsEvent] {
        let nonTurn = events.filter { $0.event != "turn" }
        return nonTurn.isEmpty ? events : nonTurn
    }

    var summaryEvent: AnalyticsEvent? {
        events.first { $0.event == "turn" }
    }

    var startMs: Double {
        AnalyticsDate.timestampMs(from: startedAt) ?? steps.first?.startMs ?? 0
    }
}

private struct AnalyticsTurnsReport: Decodable, Equatable {
    let turns: [SessionTraceTurn]
    let total: Int
    let totalEvents: Int
    let requests: Int
    let embeddingRequests: Int?
    let requestsWithUsage: Int
    let failures: Int
    let inputTokens: Int
    let outputTokens: Int
    let averageMs: Double?
    let models: [AnalyticsModel]
}

private enum AnalyticsViewMode: String, CaseIterable, Identifiable {
    case traces
    case turns

    var id: String { rawValue }

    var label: String {
        switch self {
        case .traces: return "Traces"
        case .turns: return "Turns"
        }
    }
}

private struct AnalyticsSummary: Equatable {
    let totalCount: Int
    let requests: Int
    let embeddingRequests: Int?
    let requestsWithUsage: Int
    let failures: Int
    let inputTokens: Int
    let outputTokens: Int
    let averageMs: Double?
    let models: [AnalyticsModel]

    init(_ report: AnalyticsReport) {
        totalCount = report.total
        requests = report.requests
        embeddingRequests = report.embeddingRequests
        requestsWithUsage = report.requestsWithUsage
        failures = report.failures
        inputTokens = report.inputTokens
        outputTokens = report.outputTokens
        averageMs = report.averageMs
        models = report.models
    }

    init(_ report: AnalyticsTurnsReport) {
        totalCount = report.total
        requests = report.requests
        embeddingRequests = report.embeddingRequests
        requestsWithUsage = report.requestsWithUsage
        failures = report.failures
        inputTokens = report.inputTokens
        outputTokens = report.outputTokens
        averageMs = report.averageMs
        models = report.models
    }
}

private struct InspectedSession: Identifiable {
    let id: String
}

private struct SessionTraceReport: Decodable, Equatable {
    let session: String
    let totalEvents: Int
    let turnsCount: Int
    let requests: Int
    let toolCalls: Int
    let failures: Int
    let inputTokens: Int
    let outputTokens: Int
    let totalMs: Double
    let models: [AnalyticsModel]
    let turns: [SessionTraceTurn]
}

private enum TraceValue: Codable {
    case string(String), number(Double), bool(Bool), object([String: TraceValue]), array([TraceValue]), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([String: TraceValue].self) { self = .object(v) }
        else { self = .array(try value.decode([TraceValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .bool(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }

    var text: String {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            if value.rounded() == value, value >= Double(Int.min), value < Double(Int.max) {
                return Int(value).formatted()
            }
            return String(format: "%.2f", value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null:
            return "—"
        case .object, .array:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else { return "Unavailable" }
            return text
        }
    }

    var numberValue: Double? {
        if case .number(let v) = self { return v }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    var arrayValue: [TraceValue]? {
        if case .array(let v) = self { return v }
        return nil
    }

    var objectValue: [String: TraceValue]? {
        if case .object(let v) = self { return v }
        return nil
    }

    var isStructured: Bool {
        switch self {
        case .object, .array: return true
        default: return false
        }
    }
}

private struct AnalyticsDetail: Decodable {
    let event: [String: TraceValue]
}

private enum EventKindFilter: String, CaseIterable, Identifiable {
    case all = "all"
    case modelRequest = "model.request"
    case embeddingRequest = "embedding.request"
    case toolCall = "tool.call"
    case turn = "turn"
    case classifier = "classifier.request"
    case verification = "verification"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All events"
        case .modelRequest: return "Model requests"
        case .embeddingRequest: return "Embedding requests"
        case .toolCall: return "Tool calls"
        case .turn: return "Turns"
        case .classifier: return "Classifier requests"
        case .verification: return "Verification"
        }
    }

    var symbol: String {
        switch self {
        case .all: return "line.3.horizontal.decrease.circle"
        case .modelRequest: return "cpu"
        case .embeddingRequest: return "point.3.connected.trianglepath.dotted"
        case .toolCall: return "hammer"
        case .turn: return "bubble.left.and.bubble.right"
        case .classifier: return "sparkle.magnifyingglass"
        case .verification: return "checkmark.shield"
        }
    }

    static func displayLabel(for raw: String) -> String {
        switch raw {
        case "model.request": return "Model request"
        case "embedding.request": return "Embedding request"
        case "tool.call": return "Tool call"
        case "turn": return "Turn"
        case "classifier.request": return "Classifier request"
        case "verification": return "Verification"
        default:
            let spaced = raw.replacingOccurrences(of: ".", with: " ")
            guard let first = spaced.first else { return raw }
            return first.uppercased() + spaced.dropFirst()
        }
    }
}

private enum PeriodFilter: Int, CaseIterable, Identifiable {
    case allTime = 0
    case day = 1
    case week = 7
    case month = 30

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .allTime: return "All time"
        case .day: return "Last 24 hours"
        case .week: return "Last 7 days"
        case .month: return "Last 30 days"
        }
    }

    var symbol: String {
        switch self {
        case .allTime: return "infinity"
        case .day: return "clock"
        case .week: return "calendar"
        case .month: return "calendar.badge.clock"
        }
    }
}

struct AnalyticsView: View, Equatable {
    let account: Account
    @Binding var pushed: Bool
    let onSessions: () -> Void

    nonisolated static func == (lhs: AnalyticsView, rhs: AnalyticsView) -> Bool {
        lhs.account == rhs.account
    }
    @Environment(AppModel.self) private var appModel
    @State private var path: [String] = []
    @State private var viewMode: AnalyticsViewMode = .traces
    @State private var report: AnalyticsReport?
    @State private var turnsReport: AnalyticsTurnsReport?
    /// Full model breakdown for the active period/event filter, kept stable when a single
    /// model is tapped so the list does not collapse to one row.
    @State private var catalogModels: [AnalyticsModel] = []
    @State private var selectedModel: String?
    @State private var showAllModels = false
    @State private var collapsedTurns: Set<String> = []
    @State private var inspectedSession: InspectedSession?
    @State private var error: String?
    @State private var query = ""
    @State private var kind = "all"
    @State private var days = 0
    @State private var offset = 0
    @State private var loading = false
    @State private var loadGeneration = 0
    @FocusState private var searching: Bool

    private var activeKind: EventKindFilter {
        EventKindFilter(rawValue: kind) ?? .all
    }

    private var activePeriod: PeriodFilter {
        PeriodFilter(rawValue: days) ?? .allTime
    }

    private var activeSummary: AnalyticsSummary? {
        switch viewMode {
        case .traces: return report.map(AnalyticsSummary.init)
        case .turns: return turnsReport.map(AnalyticsSummary.init)
        }
    }

    private var displayedModels: [AnalyticsModel] {
        if !catalogModels.isEmpty { return catalogModels }
        return activeSummary?.models ?? []
    }

    private var totalCatalogRequests: Int {
        max(1, displayedModels.reduce(0) { $0 + $1.requests })
    }

    private var hasActiveFilters: Bool {
        selectedModel != nil || !query.isEmpty || kind != "all" || days != 0
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                    heroCard

                    if let error {
                        MiloErrorPill(text: error)
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }

                    if let summary = activeSummary {
                        metricsSection(summary)
                        if !displayedModels.isEmpty {
                            modelsSection(displayedModels)
                        }
                    }

                    tracesSection
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.top, MiloTheme.Space.four)
                .padding(.bottom, MiloTheme.Space.six)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .miloWallpaperBackground()
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: MiloTheme.Space.one) {
                    HStack(spacing: 0) {
                        SessionsButton(action: onSessions)
                        Spacer(minLength: 0)
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            Task { await load() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .frame(width: 30, height: 30)
                                .symbolEffect(.rotate, options: .repeating, isActive: loading)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .controlSize(.regular)
                        .tint(MiloTheme.foreground)
                        .disabled(loading)
                        .accessibilityLabel("Refresh")
                    }
                    .frame(minHeight: 46)
                    ConnectionPill()
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.bottom, MiloTheme.Space.two)
                .animation(.smooth(duration: 0.22), value: appModel.connectionLine)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { id in
                AnalyticsDetailView(account: account, id: id)
            }
            .sheet(item: $inspectedSession) { target in
                SessionTracesSheet(account: account, sessionId: target.id, sessionTitle: target.id)
            }
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: viewMode) { _, _ in
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                offset = 0
                Task { await load() }
            }
            .onChange(of: kind) { _, _ in
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                offset = 0
                Task { await load() }
            }
            .onChange(of: days) { _, _ in
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                offset = 0
                Task { await load() }
            }
        }
        .onChange(of: path) { _, value in pushed = !value.isEmpty }
        .onAppear { pushed = !path.isEmpty }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "chart.bar")
                    .font(.system(size: 13, weight: .semibold))
                Text("OBSERVABILITY")
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .tracking(1.1)
                Spacer(minLength: 0)
                if let selectedModel {
                    Button {
                        toggleModel(selectedModel)
                    } label: {
                        HStack(spacing: MiloTheme.Space.one) {
                            Image(systemName: "cpu")
                                .font(.system(size: 10, weight: .semibold))
                            Text(selectedModel)
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .lineLimit(1)
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11))
                        }
                        .foregroundStyle(MiloTheme.accent)
                        .padding(.horizontal, MiloTheme.Space.two + 2)
                        .padding(.vertical, MiloTheme.Space.one)
                        .contentShape(Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.tint(MiloTheme.accent.opacity(0.16)).interactive(), in: Capsule())
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }
            .foregroundStyle(MiloTheme.accent)

            Text("Analytics")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(MiloTheme.foreground)
            Text("Requests, tools and turns across Milo.")
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.muted)

            if let summary = activeSummary {
                let unit = viewMode == .turns
                    ? (summary.totalCount == 1 ? "turn" : "turns")
                    : (summary.totalCount == 1 ? "event" : "events")
                HStack(spacing: MiloTheme.Space.two) {
                    Label("\(summary.totalCount.formatted()) \(unit)", systemImage: "waveform.path.ecg")
                    Text("·").foregroundStyle(MiloTheme.muted)
                    Text("\(summary.requests.formatted()) \(summary.requests == 1 ? "request" : "requests")")
                        .foregroundStyle(MiloTheme.muted)
                    if summary.failures > 0 {
                        Text("·").foregroundStyle(MiloTheme.muted)
                        Text("\(summary.failures.formatted()) failed")
                            .foregroundStyle(MiloTheme.danger)
                    }
                    Spacer(minLength: 0)
                }
                .font(MiloTheme.Text.small.weight(.medium).monospacedDigit())
                .contentTransition(.numericText())
                .padding(.top, MiloTheme.Space.one)
            }

            Picker("View", selection: $viewMode) {
                ForEach(AnalyticsViewMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .padding(.top, MiloTheme.Space.one)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.five)
        .glassCard(radius: MiloTheme.Radius.xl)
    }

    @ViewBuilder
    private func metricsSection(_ summary: AnalyticsSummary) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                metric(
                    "Model requests",
                    summary.requests.formatted(),
                    icon: "cpu",
                    iconTone: MiloTheme.accent
                )
                if let count = summary.embeddingRequests, count > 0 {
                    metric(
                        "Embedding requests",
                        count.formatted(),
                        icon: "point.3.connected.trianglepath.dotted",
                        iconTone: MiloTheme.secondary
                    )
                }
            }

            HStack(spacing: MiloTheme.Space.two) {
                metric(
                    "Average request",
                    summary.averageMs.map { duration($0) } ?? "—",
                    icon: "timer",
                    iconTone: MiloTheme.muted
                )
                metric(
                    "Failed events",
                    summary.failures.formatted(),
                    icon: summary.failures > 0 ? "exclamationmark.triangle.fill" : "checkmark.circle",
                    iconTone: summary.failures > 0 ? MiloTheme.danger : MiloTheme.success,
                    failed: summary.failures > 0
                )
            }

            HStack(spacing: MiloTheme.Space.two) {
                metric(
                    "Input tokens",
                    summary.inputTokens.formatted(),
                    icon: "arrow.down.circle",
                    iconTone: MiloTheme.secondary
                )
                metric(
                    "Output tokens",
                    summary.outputTokens.formatted(),
                    icon: "arrow.up.circle",
                    iconTone: MiloTheme.accent
                )
            }

            if summary.requestsWithUsage < summary.requests {
                Label(
                    "Token counts are available for \(summary.requestsWithUsage.formatted()) of \(summary.requests.formatted()) requests.",
                    systemImage: "info.circle"
                )
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
                .padding(MiloTheme.Space.four)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(fill: MiloTheme.surfaceWarm)
            }
        }
    }

    private func metric(
        _ label: String,
        _ value: String,
        icon: String,
        iconTone: Color,
        failed: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(iconTone)
                Text(label)
                    .font(MiloTheme.Text.meta.weight(.medium))
                    .foregroundStyle(MiloTheme.muted)
                    .lineLimit(1)
            }
            Text(value)
                .font(MiloTheme.Text.title.monospacedDigit())
                .foregroundStyle(failed ? MiloTheme.danger : MiloTheme.foreground)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.four)
        .glassCard(tint: failed ? MiloTheme.danger.opacity(0.14) : nil)
    }

    private func toggleModel(_ modelName: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.snappy(duration: 0.24)) {
            if selectedModel == modelName {
                selectedModel = nil
            } else {
                selectedModel = modelName
                query = ""
            }
            offset = 0
        }
        Task { await load() }
    }

    private func modelsSection(_ models: [AnalyticsModel]) -> some View {
        let visible = showAllModels ? models : Array(models.prefix(5))
        return VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(alignment: .firstTextBaseline) {
                Text(models.count > 1 ? "Models · \(models.count)" : "Models")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
                if selectedModel != nil {
                    Button {
                        if let current = selectedModel {
                            toggleModel(current)
                        }
                    } label: {
                        HStack(spacing: MiloTheme.Space.one) {
                            Image(systemName: "xmark")
                                .font(.system(size: 10, weight: .bold))
                            Text("All models")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                        }
                        .foregroundStyle(MiloTheme.accent)
                        .padding(.horizontal, MiloTheme.Space.three)
                        .padding(.vertical, MiloTheme.Space.one + 2)
                        .contentShape(Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.tint(MiloTheme.accent.opacity(0.16)).interactive(), in: Capsule())
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }

            VStack(spacing: MiloTheme.Space.two) {
                ForEach(visible) { item in
                    let isSelected = selectedModel == item.model
                    let isDimmed = selectedModel != nil && !isSelected
                    let share = Double(item.requests) / Double(totalCatalogRequests)
                    let sharePercent = Int((share * 100).rounded())

                    Button {
                        toggleModel(item.model)
                    } label: {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                                Image(systemName: isSelected ? "checkmark.circle.fill" : "cpu")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(isSelected ? MiloTheme.accent : MiloTheme.muted)
                                    .contentTransition(.symbolEffect(.replace))

                                Text(item.model)
                                    .font(MiloTheme.Text.body.weight(.semibold))
                                    .foregroundStyle(MiloTheme.foreground)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.85)

                                Spacer(minLength: MiloTheme.Space.two)

                                Text("\(sharePercent)%")
                                    .font(MiloTheme.Text.meta.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(isSelected ? MiloTheme.accent : MiloTheme.muted)
                                    .fixedSize()
                            }

                            // Proportional request share bar
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule()
                                        .fill(MiloTheme.surfaceRaised)
                                        .frame(height: 5)
                                    Capsule()
                                        .fill(isSelected ? MiloTheme.accent : MiloTheme.foreground.opacity(0.32))
                                        .frame(width: max(8, geo.size.width * share), height: 5)
                                }
                            }
                            .frame(height: 5)

                            Text("\(item.inputTokens.formatted()) input · \(item.outputTokens.formatted()) output")
                                .font(MiloTheme.Text.small.monospacedDigit())
                                .foregroundStyle(MiloTheme.muted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)

                            HStack(spacing: MiloTheme.Space.two) {
                                Text("\(item.requests.formatted()) \(item.requests == 1 ? "request" : "requests")")
                                    .font(MiloTheme.Text.meta.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(isSelected ? MiloTheme.accent : MiloTheme.foreground2)
                                    .lineLimit(1)
                                    .fixedSize()
                                    .padding(.horizontal, MiloTheme.Space.three)
                                    .padding(.vertical, MiloTheme.Space.one + 1)
                                    .background(
                                        isSelected ? MiloTheme.accent.opacity(0.18) : MiloTheme.surfaceRaised,
                                        in: Capsule()
                                    )

                                if item.failures > 0 {
                                    Text("\(item.failures.formatted()) failed")
                                        .font(MiloTheme.Text.meta.weight(.semibold).monospacedDigit())
                                        .foregroundStyle(MiloTheme.danger)
                                        .lineLimit(1)
                                        .fixedSize()
                                        .padding(.horizontal, MiloTheme.Space.three)
                                        .padding(.vertical, MiloTheme.Space.one + 1)
                                        .background(MiloTheme.danger.opacity(0.14), in: Capsule())
                                }

                                Spacer(minLength: 0)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MiloTheme.Space.four)
                        .opacity(isDimmed ? 0.62 : 1)
                        .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    }
                    .buttonStyle(PressableStyle())
                    .glassCard(
                        tint: isSelected ? MiloTheme.accent.opacity(0.18) : nil,
                        interactive: true
                    )
                }

                if models.count > 5 {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.84)) {
                            showAllModels.toggle()
                        }
                    } label: {
                        Text(showAllModels ? "Show fewer models" : "Show all \(models.count) models")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .frame(maxWidth: .infinity)
                            .frame(height: 38)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.interactive(), in: Capsule())
                }
            }
        }
    }

    private var sectionHeading: String {
        let label = viewMode.label
        guard let total = activeSummary?.totalCount, total > 0 else { return label }
        return "\(label) · \(total.formatted())"
    }

    private var tracesSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                Text(sectionHeading)
                    .font(MiloTheme.Text.title.monospacedDigit())
                    .foregroundStyle(MiloTheme.foreground)
                    .contentTransition(.numericText())

                if loading && activeSummary != nil {
                    ProgressView()
                        .controlSize(.small)
                        .transition(.opacity)
                }

                Spacer(minLength: MiloTheme.Space.two)

                if hasActiveFilters {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) {
                            selectedModel = nil
                            query = ""
                            kind = "all"
                            days = 0
                            offset = 0
                        }
                        Task { await load() }
                    } label: {
                        Text("Reset")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.one + 2)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .glassEffect(.regular.interactive(), in: Capsule())
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }

            filtersBar

            if loading && activeSummary == nil {
                statusCard(
                    icon: "hourglass",
                    title: viewMode == .turns ? "Loading turns…" : "Loading traces…",
                    subtitle: "Reading execution events from Milo."
                )
            } else if viewMode == .turns, let turnsReport {
                if turnsReport.turns.isEmpty {
                    statusCard(
                        icon: "magnifyingglass",
                        title: "No turns found.",
                        subtitle: "Try clearing your search or widening the time range."
                    )
                    .transition(.opacity)
                } else {
                    LazyVStack(spacing: MiloTheme.Space.four) {
                        ForEach(turnsReport.turns, id: \.listKey) { turn in
                            let key = turn.listKey
                            TurnTimelineCard(
                                turn: turn,
                                collapsed: collapsedTurns.contains(key),
                                showSession: true,
                                onToggle: {
                                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                                        if collapsedTurns.contains(key) {
                                            collapsedTurns.remove(key)
                                        } else {
                                            collapsedTurns.insert(key)
                                        }
                                    }
                                },
                                onSelect: { id in
                                    path.append(id)
                                },
                                onOpenSession: { sessionId in
                                    inspectedSession = InspectedSession(id: sessionId)
                                }
                            )
                        }
                    }

                    paginationBar(total: turnsReport.total, singular: "turn", plural: "turns")
                }
            } else if viewMode == .traces, let report {
                if report.events.isEmpty {
                    statusCard(
                        icon: "magnifyingglass",
                        title: "No traces found.",
                        subtitle: "Try clearing your search or widening the time range."
                    )
                    .transition(.opacity)
                } else {
                    LazyVStack(spacing: MiloTheme.Space.two) {
                        ForEach(report.events) { item in
                            TraceEventRow(item: item) {
                                path.append(item.id)
                            }
                            .equatable()
                        }
                    }

                    paginationBar(total: report.total, singular: "event", plural: "events")
                }
            }
        }
    }

    private func statusCard(icon: String, title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(MiloTheme.accent)
            Text(title)
                .font(MiloTheme.Text.body.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Text(subtitle)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
        }
        .padding(MiloTheme.Space.five)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private var filtersBar: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "magnifyingglass")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                TextField("Search model, Session or tool", text: $query)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($searching)
                    .onSubmit {
                        if !query.isEmpty { selectedModel = nil }
                        offset = 0
                        Task { await load() }
                    }
                if !query.isEmpty {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                            query = ""
                            offset = 0
                        }
                        Task { await load() }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, MiloTheme.Space.four)
            .frame(height: 44)
            .glassEffect(.regular.interactive(), in: Capsule())

            HStack(spacing: MiloTheme.Space.two) {
                Menu {
                    ForEach(EventKindFilter.allCases) { item in
                        menuItem(item.label, item.symbol) {
                            kind = item.rawValue
                        }
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: activeKind.symbol)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MiloTheme.accent)
                            .contentTransition(.symbolEffect(.replace))
                        Text(activeKind.label)
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .padding(.horizontal, MiloTheme.Space.four)
                    .frame(height: 40)
                    .frame(maxWidth: .infinity)
                    .contentShape(Capsule())
                }
                .buttonStyle(PressableStyle())
                .glassEffect(
                    (kind != "all" ? Glass.regular.tint(MiloTheme.accent.opacity(0.16)) : .regular).interactive(),
                    in: Capsule()
                )

                Menu {
                    ForEach(PeriodFilter.allCases) { item in
                        menuItem(item.label, item.symbol) {
                            days = item.rawValue
                        }
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: activePeriod.symbol)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MiloTheme.accent)
                            .contentTransition(.symbolEffect(.replace))
                        Text(activePeriod.label)
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .padding(.horizontal, MiloTheme.Space.four)
                    .frame(height: 40)
                    .frame(maxWidth: .infinity)
                    .contentShape(Capsule())
                }
                .buttonStyle(PressableStyle())
                .glassEffect(
                    (days != 0 ? Glass.regular.tint(MiloTheme.accent.opacity(0.16)) : .regular).interactive(),
                    in: Capsule()
                )
            }

            if let selectedModel {
                Button {
                    toggleModel(selectedModel)
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "cpu")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MiloTheme.accent)
                        Text("Filtered by \(selectedModel)")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                        Spacer(minLength: MiloTheme.Space.two)
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .padding(.horizontal, MiloTheme.Space.four)
                    .frame(height: 36)
                    .frame(maxWidth: .infinity)
                    .contentShape(Capsule())
                }
                .buttonStyle(PressableStyle())
                .glassEffect(.regular.tint(MiloTheme.accent.opacity(0.16)).interactive(), in: Capsule())
                .transition(.asymmetric(
                    insertion: .scale(scale: 0.94).combined(with: .opacity),
                    removal: .opacity
                ))
            }
        }
    }

    private func paginationBar(total: Int, singular: String, plural: String) -> some View {
        let canPrevious = offset > 0
        let canNext = offset + 30 < total
        return HStack(spacing: MiloTheme.Space.three) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                offset = max(0, offset - 30)
                Task { await load() }
            } label: {
                HStack(spacing: MiloTheme.Space.one) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Previous")
                        .font(MiloTheme.Text.small.weight(.semibold))
                }
                .foregroundStyle(MiloTheme.foreground)
                .padding(.horizontal, MiloTheme.Space.four)
                .frame(height: 38)
                .contentShape(Capsule())
            }
            .buttonStyle(PressableStyle())
            .disabled(!canPrevious)
            .opacity(canPrevious ? 1 : 0.4)
            .glassEffect(.regular.interactive(), in: Capsule())

            Spacer(minLength: 0)

            Text("\(total.formatted()) \(total == 1 ? singular : plural)")
                .font(MiloTheme.Text.small.monospacedDigit())
                .foregroundStyle(MiloTheme.muted)
                .contentTransition(.numericText())

            Spacer(minLength: 0)

            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                offset += 30
                Task { await load() }
            } label: {
                HStack(spacing: MiloTheme.Space.one) {
                    Text("Next")
                        .font(MiloTheme.Text.small.weight(.semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(MiloTheme.foreground)
                .padding(.horizontal, MiloTheme.Space.four)
                .frame(height: 38)
                .contentShape(Capsule())
            }
            .buttonStyle(PressableStyle())
            .disabled(!canNext)
            .opacity(canNext ? 1 : 0.4)
            .glassEffect(.regular.interactive(), in: Capsule())
        }
        .padding(.top, MiloTheme.Space.two)
    }

    private func fetchWithCatalog<T: Decodable & Sendable>(
        action: String,
        as type: T.Type,
        effectiveQuery: String,
        needsCatalog: Bool,
        models: @escaping (T) -> [AnalyticsModel]
    ) async throws -> (T, [AnalyticsModel]) {
        async let filteredCall = MiloApi.call(
            action,
            ["query": effectiveQuery, "event": kind, "days": days, "offset": offset],
            account: account,
            as: type,
            timeout: 120
        )
        if needsCatalog {
            async let catalogCall = MiloApi.call(
                action,
                ["query": "", "event": kind, "days": days, "offset": 0],
                account: account,
                as: type,
                timeout: 120
            )
            let (next, fullCatalog) = try await (filteredCall, catalogCall)
            return (next, models(fullCatalog))
        }
        let next = try await filteredCall
        return (next, models(next))
    }

    @MainActor private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        let targetMode = viewMode
        loading = true
        defer { if generation == loadGeneration { loading = false } }
        let effectiveQuery = selectedModel ?? query
        let needsCatalog = selectedModel != nil || !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        do {
            switch targetMode {
            case .traces:
                let (next, models) = try await fetchWithCatalog(
                    action: "analytics",
                    as: AnalyticsReport.self,
                    effectiveQuery: effectiveQuery,
                    needsCatalog: needsCatalog,
                    models: \.models
                )
                guard generation == loadGeneration else { return }
                withAnimation(.spring(response: 0.34, dampingFraction: 0.84)) {
                    report = next
                    catalogModels = models
                    error = nil
                }
            case .turns:
                let (next, models) = try await fetchWithCatalog(
                    action: "analytics-turns",
                    as: AnalyticsTurnsReport.self,
                    effectiveQuery: effectiveQuery,
                    needsCatalog: needsCatalog,
                    models: \.models
                )
                guard generation == loadGeneration else { return }
                withAnimation(.spring(response: 0.34, dampingFraction: 0.84)) {
                    turnsReport = next
                    catalogModels = models
                    error = nil
                }
            }
        } catch {
            guard generation == loadGeneration else { return }
            withAnimation(.smooth(duration: 0.22)) {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

private struct TraceEventRow: View, Equatable {
    let item: AnalyticsEvent
    let onOpen: () -> Void

    nonisolated static func == (lhs: TraceEventRow, rhs: TraceEventRow) -> Bool {
        lhs.item == rhs.item
    }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.two) {
                    Circle()
                        .fill(item.ok ? MiloTheme.success : MiloTheme.danger)
                        .frame(width: 8, height: 8)
                    Text(item.title)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                    Spacer(minLength: MiloTheme.Space.two)
                    if !item.ok {
                        Text("Failed")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.danger)
                            .padding(.horizontal, MiloTheme.Space.two + 2)
                            .padding(.vertical, 2)
                            .background(MiloTheme.danger.opacity(0.14), in: Capsule())
                    }
                    Text(item.relativeTime)
                        .font(MiloTheme.Text.small.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }

                HStack(spacing: MiloTheme.Space.two) {
                    Text(EventKindFilter.displayLabel(for: item.event))
                        .font(MiloTheme.Text.meta.weight(.medium))
                        .foregroundStyle(MiloTheme.foreground2)
                        .padding(.horizontal, MiloTheme.Space.two + 2)
                        .padding(.vertical, 3)
                        .background(MiloTheme.surfaceRaised, in: Capsule())

                    Text(item.detailsLine)
                        .font(MiloTheme.Text.small.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                }

                if let error = item.error, !error.isEmpty {
                    Text(error)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                        .lineLimit(2)
                }
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        }
        .buttonStyle(PressableStyle())
        .glassCard(interactive: true)
    }
}

private func duration(_ ms: Double) -> String {
    ms < 1000 ? "\(Int(ms.rounded())) ms" : String(format: "%.2f s", ms / 1000)
}

// MARK: - Trace detail

private struct AnalyticsDetailView: View {
    let account: Account
    let id: String
    @Environment(AppModel.self) private var appModel
    @State private var detail: AnalyticsDetail?
    @State private var error: String?
    @State private var attachmentsOpen = false
    @State private var copiedKey: String?

    private static let fieldLabels: [String: String] = [
        "id": "ID",
        "ok": "Status",
        "ms": "Duration",
        "ttftMs": "First token",
        "inputTokens": "Input tokens",
        "outputTokens": "Output tokens",
        "cachedInputTokens": "Cached input tokens",
        "cacheWriteTokens": "Cache write tokens",
        "reasoningTokens": "Reasoning tokens",
        "callId": "Tool call ID",
        "provider": "Provider",
        "model": "Model",
        "tool": "Tool",
        "purpose": "Purpose",
        "surface": "Surface",
        "session": "Session",
        "turn": "Turn",
        "finish": "Finish reason",
        "error": "Error",
    ]

    private static let excludedKeys: Set<String> = [
        "input", "output", "attachments", "at", "event",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let error {
                    MiloErrorPill(text: error)
                }
                if let detail {
                    headerCard(detail)
                    metricsGrid(detail)
                    metadataCard(detail)

                    ForEach(["input", "output"], id: \.self) { key in
                        if let value = detail.event[key] {
                            payloadSection(
                                key: key,
                                title: key == "input" ? "Input" : "Output",
                                value: value
                            )
                        }
                    }

                    if detail.event["input"] == nil, detail.event["output"] == nil, detail.event["attachments"] == nil {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.one + 2) {
                            Label("No request or response payload", systemImage: "doc.text")
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("This trace recorded timing and metadata only. Select a model request or tool call in the timeline to inspect inputs and outputs.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassCard(fill: MiloTheme.surfaceWarm)
                    }

                    if let attachments = detail.event["attachments"] {
                        attachmentsSection(attachments)
                    }
                } else if error == nil {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Image(systemName: "hourglass")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(MiloTheme.accent)
                        Text("Loading event…")
                            .font(MiloTheme.Text.body.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                    }
                    .padding(MiloTheme.Space.five)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard()
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .miloWallpaperBackground()
        .navigationTitle("Trace")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) {
            ConnectionPill()
                .padding(.horizontal, MiloTheme.margin)
                .padding(.bottom, appModel.connectionLine == nil ? 0 : MiloTheme.Space.two)
                .animation(.smooth(duration: 0.22), value: appModel.connectionLine)
        }
        .task {
            do {
                let loaded = try await MiloApi.call(
                    "analytics-detail",
                    ["id": id],
                    account: account,
                    as: AnalyticsDetail.self,
                    timeout: 120
                )
                withAnimation(.spring(response: 0.32, dampingFraction: 0.84)) {
                    detail = loaded
                }
            } catch {
                withAnimation(.smooth(duration: 0.22)) {
                    self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                }
            }
        }
    }

    private func eventTitle(_ event: [String: TraceValue]) -> String {
        if let tool = event["tool"]?.stringValue, !tool.isEmpty { return tool }
        let kind = event["event"]?.stringValue ?? ""
        if let purpose = event["purpose"]?.stringValue, !purpose.isEmpty {
            let clean = purpose.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
            let labeled = clean.prefix(1).uppercased() + clean.dropFirst()
            if kind == "model.request" { return "\(labeled) request" }
            if kind == "embedding.request" { return "\(labeled) embedding" }
            return labeled
        }
        if !kind.isEmpty { return EventKindFilter.displayLabel(for: kind) }
        return "Event"
    }

    private func headerCard(_ detail: AnalyticsDetail) -> some View {
        let ok = detail.event["ok"]?.boolValue ?? true
        let tone = ok ? MiloTheme.success : MiloTheme.danger
        let kind = detail.event["event"]?.text ?? "event"
        let at = detail.event["at"]?.text ?? ""

        return VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
            HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.one + 2) {
                    Circle().fill(tone).frame(width: 7, height: 7)
                    Text(ok ? "Succeeded" : "Failed")
                        .font(MiloTheme.Text.meta.weight(.semibold))
                        .foregroundStyle(tone)
                }
                .padding(.horizontal, MiloTheme.Space.two + 2)
                .padding(.vertical, MiloTheme.Space.one)
                .background(tone.opacity(0.16), in: Capsule())

                Spacer(minLength: MiloTheme.Space.two)

                Text(EventKindFilter.displayLabel(for: kind))
                    .font(MiloTheme.Text.meta.weight(.medium))
                    .foregroundStyle(MiloTheme.foreground2)
                    .padding(.horizontal, MiloTheme.Space.two + 2)
                    .padding(.vertical, MiloTheme.Space.one)
                    .background(MiloTheme.surfaceRaised, in: Capsule())
            }

            Text(eventTitle(detail.event))
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)
                .fixedSize(horizontal: false, vertical: true)

            if !at.isEmpty {
                Text(AnalyticsDate.stamp(at))
                    .font(MiloTheme.Text.small.monospacedDigit())
                    .foregroundStyle(MiloTheme.muted)
            }

            if let err = detail.event["error"]?.text, !err.isEmpty {
                Text(err)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.danger)
                    .padding(MiloTheme.Space.three)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(MiloTheme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.five)
        .glassCard()
    }

    @ViewBuilder
    private func metricsGrid(_ detail: AnalyticsDetail) -> some View {
        let ms = detail.event["ms"]?.numberValue
        let ttft = detail.event["ttftMs"]?.numberValue
        let inputTokens = detail.event["inputTokens"]?.numberValue
        let outputTokens = detail.event["outputTokens"]?.numberValue

        if ms != nil || ttft != nil || inputTokens != nil || outputTokens != nil {
            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: MiloTheme.Space.two),
                    GridItem(.flexible(), spacing: MiloTheme.Space.two),
                ],
                spacing: MiloTheme.Space.two
            ) {
                if let ms {
                    detailFact("Duration", duration(ms), icon: "timer", tone: MiloTheme.accent)
                }
                if let ttft {
                    detailFact("First token", duration(ttft), icon: "bolt.fill", tone: MiloTheme.secondary)
                }
                if let inputTokens {
                    detailFact("Input tokens", Int(inputTokens).formatted(), icon: "arrow.down.circle", tone: MiloTheme.secondary)
                }
                if let outputTokens {
                    detailFact("Output tokens", Int(outputTokens).formatted(), icon: "arrow.up.circle", tone: MiloTheme.accent)
                }
            }
        }
    }

    private func detailFact(_ label: String, _ value: String, icon: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tone)
                Text(label)
                    .font(MiloTheme.Text.meta.weight(.medium))
                    .foregroundStyle(MiloTheme.muted)
            }
            Text(value)
                .font(MiloTheme.Text.base.weight(.semibold).monospacedDigit())
                .foregroundStyle(MiloTheme.foreground)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.four)
        .glassCard()
    }

    @ViewBuilder
    private func metadataCard(_ detail: AnalyticsDetail) -> some View {
        let keys = detail.event.keys
            .filter { !Self.excludedKeys.contains($0) }
            .sorted()

        if !keys.isEmpty {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                ForEach(keys, id: \.self) { key in
                    if let raw = detail.event[key] {
                        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                            Text(Self.fieldLabels[key] ?? key)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                                .frame(width: 130, alignment: .leading)
                            Text(formattedField(key: key, value: raw))
                                .font(MiloTheme.Text.small.monospacedDigit())
                                .foregroundStyle(key == "error" ? MiloTheme.danger : MiloTheme.foreground)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
    }

    private func formattedField(key: String, value: TraceValue) -> String {
        if key == "ok", let flag = value.boolValue {
            return flag ? "Succeeded" : "Failed"
        }
        if (key == "ms" || key == "ttftMs"), let ms = value.numberValue {
            return duration(ms)
        }
        return value.text
    }

    @State private var rawPayloads: Set<String> = []

    private func payloadSection(key: String, title: String, value: TraceValue) -> some View {
        let copied = copiedKey == key
        let showRaw = rawPayloads.contains(key)
        let rawText = value.text

        return VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Text(title)
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
                if value.isStructured {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                            if showRaw { rawPayloads.remove(key) }
                            else { rawPayloads.insert(key) }
                        }
                    } label: {
                        Label(showRaw ? "Formatted" : "JSON", systemImage: showRaw ? "text.alignleft" : "curlybraces")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(showRaw ? MiloTheme.accent : MiloTheme.foreground)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.one + 2)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .glassEffect(
                        (showRaw ? Glass.regular.tint(MiloTheme.accent.opacity(0.16)) : .regular).interactive(),
                        in: Capsule()
                    )
                }
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    UIPasteboard.general.string = rawText
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        copiedKey = key
                    }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation(.smooth(duration: 0.2)) {
                            if copiedKey == key { copiedKey = nil }
                        }
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(MiloTheme.Text.small.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .padding(.horizontal, MiloTheme.Space.three)
                        .padding(.vertical, MiloTheme.Space.one + 2)
                        .contentShape(Capsule())
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(PressableStyle())
                .glassEffect(.regular.interactive(), in: Capsule())
            }

            if showRaw || !value.isStructured {
                Text(rawText)
                    .font(value.isStructured ? MiloTheme.Text.mono : MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.four)
                    .glassCard(fill: MiloTheme.surfaceWarm)
            } else {
                TracePayloadView(value: value)
            }
        }
    }

    private func attachmentsSection(_ attachments: TraceValue) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) {
                    attachmentsOpen.toggle()
                }
            } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MiloTheme.accent)
                    Text(attachmentsOpen ? "Hide attachment data" : "Attachment data")
                        .font(MiloTheme.Text.base.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .frame(height: 44)
                .frame(maxWidth: .infinity)
                .contentShape(Capsule())
            }
            .buttonStyle(PressableStyle())
            .glassEffect(.regular.interactive(), in: Capsule())

            if attachmentsOpen {
                Text(attachments.text)
                    .font(MiloTheme.Text.mono)
                    .foregroundStyle(MiloTheme.foreground)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.four)
                    .glassCard(fill: MiloTheme.surfaceWarm)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

private struct TracePayloadView: View {
    let value: TraceValue
    @State private var systemExpanded = false
    @State private var toolsExpanded = false
    @State private var reasoningExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            if let obj = value.objectValue {
                if obj["messages"] != nil || obj["system"] != nil {
                    chatRequestView(obj)
                } else {
                    objectView(obj)
                }
            } else if let arr = value.arrayValue {
                if isStreamEvents(arr) {
                    streamOutputView(arr)
                } else if isEmbeddingVectors(arr) {
                    embeddingVectorsView(arr)
                } else {
                    arrayView(arr)
                }
            } else {
                Text(value.text)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.four)
                    .glassCard(fill: MiloTheme.surfaceWarm)
            }
        }
    }

    @ViewBuilder
    private func chatRequestView(_ obj: [String: TraceValue]) -> some View {
        if let system = obj["system"]?.stringValue, !system.isEmpty {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                        systemExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Text("System")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground2)
                            .padding(.horizontal, MiloTheme.Space.two + 2)
                            .padding(.vertical, 3)
                            .background(MiloTheme.surfaceRaised, in: Capsule())
                        Text("\(system.count.formatted()) chars")
                            .font(MiloTheme.Text.small.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                        Spacer(minLength: 0)
                        Text(systemExpanded ? "Hide" : "Show")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.accent)
                    }
                    .padding(MiloTheme.Space.four)
                    .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }
                .buttonStyle(PressableStyle())
                .glassCard(fill: MiloTheme.surfaceWarm)

                if systemExpanded {
                    Text(system)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MiloTheme.Space.four)
                        .glassCard(fill: MiloTheme.surfaceWarm)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }

        if let messages = obj["messages"]?.arrayValue, !messages.isEmpty {
            ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
                messageCard(message)
            }
        }

        if let tools = obj["tools"]?.arrayValue, !tools.isEmpty {
            let names = tools.compactMap { $0.objectValue?["name"]?.stringValue }
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                        toolsExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "hammer")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MiloTheme.accent)
                        Text("Tools · \(tools.count)")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                        Spacer(minLength: 0)
                        Text(toolsExpanded ? "Hide" : "Show")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.accent)
                    }
                    .padding(MiloTheme.Space.four)
                    .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }
                .buttonStyle(PressableStyle())
                .glassCard(fill: MiloTheme.surfaceWarm)

                if toolsExpanded {
                    Text(names.isEmpty ? TraceValue.array(tools).text : names.joined(separator: ", "))
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MiloTheme.Space.four)
                        .glassCard(fill: MiloTheme.surfaceWarm)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }

        let extraKeys = obj.keys.filter { $0 != "system" && $0 != "messages" && $0 != "tools" }.sorted()
        if !extraKeys.isEmpty {
            let extra = Dictionary(uniqueKeysWithValues: extraKeys.compactMap { k in obj[k].map { (k, $0) } })
            objectView(extra)
        }
    }

    private func messageCard(_ message: TraceValue) -> some View {
        let obj = message.objectValue ?? [:]
        let role = obj["role"]?.stringValue ?? "message"
        let roleLabel: String = switch role {
        case "user": "User"
        case "assistant": "Assistant"
        case "tool": "Tool"
        case "system": "System"
        default: role.capitalized
        }
        let roleTone: Color = switch role {
        case "user": MiloTheme.accent
        case "assistant": MiloTheme.secondary
        case "tool": MiloTheme.warning
        default: MiloTheme.muted
        }
        let contentText = extractMessageText(obj)

        return VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            HStack(spacing: MiloTheme.Space.two) {
                Text(roleLabel)
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .foregroundStyle(roleTone)
                    .padding(.horizontal, MiloTheme.Space.two + 2)
                    .padding(.vertical, 3)
                    .background(roleTone.opacity(0.16), in: Capsule())
                if let name = obj["name"]?.stringValue ?? obj["toolName"]?.stringValue {
                    Text(name)
                        .font(MiloTheme.Text.small.weight(.medium))
                        .foregroundStyle(MiloTheme.muted)
                }
                Spacer(minLength: 0)
            }

            if !contentText.isEmpty {
                Text(contentText)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(message.text)
                    .font(MiloTheme.Text.mono)
                    .foregroundStyle(MiloTheme.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(MiloTheme.Space.four)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(fill: MiloTheme.surfaceWarm)
    }

    private func extractMessageText(_ obj: [String: TraceValue]) -> String {
        if let text = obj["content"]?.stringValue, !text.isEmpty {
            return text
        }
        if let parts = obj["parts"]?.arrayValue ?? obj["content"]?.arrayValue {
            let chunks = parts.compactMap { part -> String? in
                guard let p = part.objectValue else { return part.stringValue }
                if let text = p["text"]?.stringValue { return text }
                if let type = p["type"]?.stringValue {
                    if type == "tool-call", let name = p["name"]?.stringValue ?? p["toolName"]?.stringValue {
                        return "Tool call: \(name)"
                    }
                    if type == "tool-result", let name = p["name"]?.stringValue ?? p["toolName"]?.stringValue {
                        let result = p["output"]?.stringValue ?? p["result"]?.stringValue ?? ""
                        return result.isEmpty ? "Tool result: \(name)" : "Tool result (\(name)): \(result)"
                    }
                    return type
                }
                return nil
            }
            if !chunks.isEmpty {
                return chunks.joined(separator: "\n")
            }
        }
        if let calls = obj["toolCalls"]?.arrayValue, !calls.isEmpty {
            let names = calls.compactMap { $0.objectValue?["name"]?.stringValue }
            if !names.isEmpty { return "Tool calls: \(names.joined(separator: ", "))" }
        }
        return ""
    }

    private func isStreamEvents(_ arr: [TraceValue]) -> Bool {
        arr.contains { $0.objectValue?["type"]?.stringValue != nil }
    }

    private func isEmbeddingVectors(_ arr: [TraceValue]) -> Bool {
        guard let first = arr.first?.arrayValue, !first.isEmpty else { return false }
        return first.first?.numberValue != nil
    }

    @ViewBuilder
    private func streamOutputView(_ arr: [TraceValue]) -> some View {
        let reasoning = arr.compactMap { item -> String? in
            guard let o = item.objectValue, o["type"]?.stringValue == "reasoning" else { return nil }
            return o["delta"]?.stringValue
        }.joined()

        let text = arr.compactMap { item -> String? in
            guard let o = item.objectValue, o["type"]?.stringValue == "text" else { return nil }
            return o["delta"]?.stringValue
        }.joined()

        let toolCalls = arr.compactMap { item -> (name: String, args: TraceValue?)? in
            guard let o = item.objectValue, o["type"]?.stringValue == "tool-call" else { return nil }
            let name = o["name"]?.stringValue ?? "Tool"
            return (name, o["arguments"] ?? o["args"])
        }

        if !reasoning.isEmpty {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                        reasoningExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.two) {
                        Text("Reasoning")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.secondary)
                            .padding(.horizontal, MiloTheme.Space.two + 2)
                            .padding(.vertical, 3)
                            .background(MiloTheme.secondary.opacity(0.16), in: Capsule())
                        Text("\(reasoning.count.formatted()) chars")
                            .font(MiloTheme.Text.small.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                        Spacer(minLength: 0)
                        Text(reasoningExpanded ? "Hide" : "Show")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.accent)
                    }
                    .padding(MiloTheme.Space.four)
                    .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }
                .buttonStyle(PressableStyle())
                .glassCard(fill: MiloTheme.surfaceWarm)

                if reasoningExpanded {
                    Text(reasoning)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground2)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MiloTheme.Space.four)
                        .glassCard(fill: MiloTheme.surfaceWarm)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }

        if !text.isEmpty {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                Text("Response")
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .foregroundStyle(MiloTheme.accent)
                    .padding(.horizontal, MiloTheme.Space.two + 2)
                    .padding(.vertical, 3)
                    .background(MiloTheme.accent.opacity(0.16), in: Capsule())

                Text(text)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(fill: MiloTheme.surfaceWarm)
        }

        ForEach(Array(toolCalls.enumerated()), id: \.offset) { _, call in
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.two) {
                    Text("Tool call")
                        .font(MiloTheme.Text.meta.weight(.semibold))
                        .foregroundStyle(MiloTheme.warning)
                        .padding(.horizontal, MiloTheme.Space.two + 2)
                        .padding(.vertical, 3)
                        .background(MiloTheme.warning.opacity(0.16), in: Capsule())
                    Text(call.name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                }
                if let args = call.args {
                    if let obj = args.objectValue {
                        keyValueRows(obj)
                    } else {
                        Text(args.text)
                            .font(MiloTheme.Text.mono)
                            .foregroundStyle(MiloTheme.foreground)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(fill: MiloTheme.surfaceWarm)
        }

        if reasoning.isEmpty && text.isEmpty && toolCalls.isEmpty {
            arrayView(arr)
        }
    }

    private func embeddingVectorsView(_ arr: [TraceValue]) -> some View {
        let dims = arr.first?.arrayValue?.count ?? 0
        return VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text("\(arr.count.formatted()) \(arr.count == 1 ? "vector" : "vectors") · \(dims.formatted()) dimensions")
                .font(MiloTheme.Text.base.weight(.semibold).monospacedDigit())
                .foregroundStyle(MiloTheme.foreground)
            if let first = arr.first?.arrayValue {
                let preview = first.prefix(6).map(\.text).joined(separator: ", ")
                Text("[\(preview), …]")
                    .font(MiloTheme.Text.mono)
                    .foregroundStyle(MiloTheme.muted)
            }
        }
        .padding(MiloTheme.Space.four)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(fill: MiloTheme.surfaceWarm)
    }

    private func objectView(_ obj: [String: TraceValue]) -> some View {
        keyValueRows(obj)
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(fill: MiloTheme.surfaceWarm)
    }

    private static let keyLabels: [String: String] = [
        "reasoningEffort": "Reasoning effort",
        "maxTokens": "Max tokens",
        "toolChoice": "Tool choice",
        "topP": "Top P",
        "topK": "Top K",
        "model": "Model",
        "temperature": "Temperature",
        "stopSequences": "Stop sequences",
    ]

    private func prettyKey(_ key: String) -> String {
        if let mapped = Self.keyLabels[key] { return mapped }
        let spaced = key
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
        guard let first = spaced.first else { return key }
        return first.uppercased() + spaced.dropFirst().lowercased()
    }

    private func prettyValue(for key: String, value: TraceValue) -> String {
        if key == "reasoningEffort", let str = value.stringValue, !str.isEmpty {
            return str.prefix(1).uppercased() + str.dropFirst()
        }
        return value.text
    }

    private func keyValueRows(_ obj: [String: TraceValue]) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            ForEach(obj.keys.sorted(), id: \.self) { key in
                if let val = obj[key] {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text(prettyKey(key))
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.muted)
                        Text(prettyValue(for: key, value: val))
                            .font(val.isStructured ? MiloTheme.Text.mono : MiloTheme.Text.base)
                            .foregroundStyle(MiloTheme.foreground)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func arrayView(_ arr: [TraceValue]) -> some View {
        VStack(spacing: MiloTheme.Space.two) {
            ForEach(Array(arr.enumerated()), id: \.offset) { _, item in
                if let obj = item.objectValue {
                    objectView(obj)
                } else {
                    Text(item.text)
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.foreground)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MiloTheme.Space.four)
                        .glassCard(fill: MiloTheme.surfaceWarm)
                }
            }
        }
    }
}

// MARK: - Session Traces & Turn Waterfall

struct SessionTracesSheet: View {
    let account: Account
    let sessionId: String
    let sessionTitle: String

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel
    @State private var path: [String] = []
    @State private var report: SessionTraceReport?
    @State private var loading = false
    @State private var error: String?
    @State private var ascending = false
    @State private var copiedId = false
    @State private var collapsedTurns: Set<String> = []

    private var orderedTurns: [SessionTraceTurn] {
        guard let report else { return [] }
        return ascending ? Array(report.turns.reversed()) : report.turns
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
                    summaryCard

                    if let error {
                        MiloErrorPill(text: error)
                    }

                    if let report {
                        if report.turns.isEmpty {
                            emptyState
                        } else {
                            timelineHeader(report)
                            LazyVStack(spacing: MiloTheme.Space.four) {
                                ForEach(orderedTurns) { turn in
                                    TurnTimelineCard(
                                        turn: turn,
                                        collapsed: collapsedTurns.contains(turn.id),
                                        onToggle: {
                                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                                                if collapsedTurns.contains(turn.id) {
                                                    collapsedTurns.remove(turn.id)
                                                } else {
                                                    collapsedTurns.insert(turn.id)
                                                }
                                            }
                                        },
                                        onSelect: { id in
                                            path.append(id)
                                        }
                                    )
                                }
                            }
                        }
                    } else if loading && error == nil {
                        loadingCard
                    }
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.top, MiloTheme.Space.three)
                .padding(.bottom, MiloTheme.Space.six)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .miloWallpaperBackground()
            .navigationTitle("Session traces")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(MiloTheme.foreground)
                    }
                    .accessibilityLabel("Close")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.snappy(duration: 0.24)) {
                            ascending.toggle()
                        }
                    } label: {
                        Image(systemName: ascending ? "arrow.up.circle" : "arrow.down.circle")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(MiloTheme.foreground)
                    }
                    .accessibilityLabel(ascending ? "Oldest first" : "Newest first")

                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(MiloTheme.foreground)
                    }
                    .disabled(loading)
                    .accessibilityLabel("Refresh traces")
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                ConnectionPill()
                    .padding(.horizontal, MiloTheme.margin)
                    .padding(.bottom, appModel.connectionLine == nil ? 0 : MiloTheme.Space.two)
                    .animation(.smooth(duration: 0.22), value: appModel.connectionLine)
            }
            .navigationDestination(for: String.self) { id in
                AnalyticsDetailView(account: account, id: id)
            }
            .task(id: sessionId) {
                await load()
            }
        }
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                Text(sessionTitle)
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(2)

                Button {
                    UIPasteboard.general.string = sessionId
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.snappy(duration: 0.2)) { copiedId = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation(.smooth(duration: 0.2)) { copiedId = false }
                    }
                } label: {
                    HStack(spacing: MiloTheme.Space.one + 2) {
                        Image(systemName: copiedId ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 11, weight: .semibold))
                            .contentTransition(.symbolEffect(.replace))
                        Text(copiedId ? "Session ID copied" : sessionId)
                            .font(MiloTheme.Text.meta.monospaced())
                            .lineLimit(1)
                    }
                    .foregroundStyle(copiedId ? MiloTheme.success : MiloTheme.foreground2)
                    .padding(.horizontal, MiloTheme.Space.three)
                    .padding(.vertical, MiloTheme.Space.one + 1)
                    .glassEffect(
                        copiedId ? .regular.tint(MiloTheme.success.opacity(0.18)) : .regular.interactive(),
                        in: Capsule()
                    )
                }
                .buttonStyle(PressableStyle())
            }

            if let report {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: MiloTheme.Space.two),
                        GridItem(.flexible(), spacing: MiloTheme.Space.two),
                        GridItem(.flexible(), spacing: MiloTheme.Space.two),
                    ],
                    spacing: MiloTheme.Space.two
                ) {
                    compactStat("Turns", report.turnsCount.formatted())
                    compactStat("Requests", report.requests.formatted())
                    compactStat("Tools", report.toolCalls.formatted())
                    compactStat("Input", report.inputTokens.formatted())
                    compactStat("Output", report.outputTokens.formatted())
                    compactStat("Time", duration(report.totalMs))
                }

                if report.failures > 0 {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MiloTheme.danger)
                        Text("\(report.failures.formatted()) failed \(report.failures == 1 ? "event" : "events")")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.danger)
                    }
                    .padding(.horizontal, MiloTheme.Space.three)
                    .padding(.vertical, MiloTheme.Space.one + 2)
                    .background(MiloTheme.danger.opacity(0.18), in: Capsule())
                }
            }
        }
        .padding(MiloTheme.Space.five)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(fill: MiloTheme.surfaceWarm)
    }

    private func compactStat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(MiloTheme.Text.meta)
                .foregroundStyle(MiloTheme.muted)
                .lineLimit(1)
            Text(value)
                .font(MiloTheme.Text.base.weight(.semibold).monospacedDigit())
                .foregroundStyle(MiloTheme.foreground)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.two)
        .glassCard(radius: MiloTheme.Radius.md, fill: MiloTheme.surface)
    }

    private func timelineHeader(_ report: SessionTraceReport) -> some View {
        HStack {
            Text("Timeline")
                .font(MiloTheme.Text.body.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Spacer()
            Text("\(report.totalEvents.formatted()) \(report.totalEvents == 1 ? "event" : "events") · \(ascending ? "Oldest first" : "Newest first")")
                .font(MiloTheme.Text.meta.monospacedDigit())
                .foregroundStyle(MiloTheme.muted)
        }
        .padding(.horizontal, MiloTheme.Space.one)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Image(systemName: "waveform.path.ecg")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(MiloTheme.muted)
            Text("No traces for this Session")
                .font(MiloTheme.Text.body.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Text("New turns record model requests, tool calls and timings here. Older entries may have been trimmed from the execution log.")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
        }
        .padding(MiloTheme.Space.five)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private var loadingCard: some View {
        HStack(spacing: MiloTheme.Space.three) {
            ProgressView()
                .tint(MiloTheme.accent)
            Text("Loading Session timeline…")
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.muted)
        }
        .padding(MiloTheme.Space.five)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    @MainActor
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await MiloApi.call(
                "session-traces",
                ["session": sessionId],
                account: account,
                as: SessionTraceReport.self,
                timeout: 120
            )
            withAnimation(.spring(response: 0.34, dampingFraction: 0.84)) {
                report = loaded
                error = nil
            }
        } catch {
            withAnimation(.smooth(duration: 0.22)) {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

private struct TurnTimelineCard: View {
    let turn: SessionTraceTurn
    let collapsed: Bool
    var showSession: Bool = false
    let onToggle: () -> Void
    let onSelect: (String) -> Void
    var onOpenSession: ((String) -> Void)? = nil

    private var toolCallIds: Set<String> {
        Set(turn.steps.filter { $0.event == "tool.call" }.compactMap(\.callId))
    }

    var body: some View {
        let steps = turn.steps
        let turnStart = turn.startMs
        let span = max(1, turn.spanMs > 0 ? turn.spanMs : turn.ms)

        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                Button(action: onToggle) {
                    HStack(spacing: MiloTheme.Space.two) {
                        Circle()
                            .fill(turn.ok ? MiloTheme.success : MiloTheme.danger)
                            .frame(width: 9, height: 9)
                        Text("Turn \(turn.index)")
                            .font(MiloTheme.Text.body.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)

                        if !turn.ok {
                            Text("Failed")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .foregroundStyle(MiloTheme.danger)
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, MiloTheme.Space.two + 2)
                                .padding(.vertical, 2)
                                .background(MiloTheme.danger.opacity(0.16), in: Capsule())
                        }

                        Spacer(minLength: MiloTheme.Space.two)

                        Text(duration(turn.ms))
                            .font(MiloTheme.Text.meta.weight(.semibold).monospacedDigit())
                            .foregroundStyle(MiloTheme.foreground2)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, 3)
                            .background(MiloTheme.surfaceRaised, in: Capsule())

                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())

                HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                    Text(turnMetadataLine)
                        .font(MiloTheme.Text.small.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: MiloTheme.Space.two)
                    if showSession, let sessionId = turn.session, !sessionId.isEmpty, let onOpenSession {
                        Button {
                            onOpenSession(sessionId)
                        } label: {
                            Text("Session")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground2)
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, MiloTheme.Space.two + 3)
                                .padding(.vertical, 3)
                                .glassEffect(.regular.interactive(), in: Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    if let summary = turn.summaryEvent {
                        Button {
                            onSelect(summary.id)
                        } label: {
                            Text("Inspect turn")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .foregroundStyle(MiloTheme.accent)
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, MiloTheme.Space.two + 3)
                                .padding(.vertical, 3)
                                .glassEffect(.regular.tint(MiloTheme.accent.opacity(0.18)).interactive(), in: Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                }
            }

            if !collapsed {
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    HStack {
                        Text("Chronological · Start → End")
                            .font(MiloTheme.Text.meta.weight(.medium))
                            .foregroundStyle(MiloTheme.muted)
                        Spacer()
                        Text("\(steps.count) \(steps.count == 1 ? "step" : "steps")")
                            .font(MiloTheme.Text.meta.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .padding(.horizontal, MiloTheme.Space.one)

                    ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                        let nested = step.event != "tool.call" && step.callId.map { toolCallIds.contains($0) } == true
                        WaterfallStepRow(
                            stepIndex: index + 1,
                            isLast: index == steps.count - 1,
                            step: step,
                            turnModel: turn.model,
                            turnStartMs: turnStart,
                            turnSpanMs: span,
                            nested: nested,
                            onSelect: { onSelect(step.id) }
                        )
                    }
                }
                .padding(.top, MiloTheme.Space.one)
                .transition(.opacity)
            }
        }
        .padding(MiloTheme.Space.four)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private var turnMetadataLine: String {
        var parts: [String] = []
        if let ts = AnalyticsDate.timestampMs(from: turn.startedAt) {
            parts.append(RelativeTime.when(ts))
        }
        if showSession, let session = turn.session, !session.isEmpty {
            parts.append(session)
        }
        if showSession, let surface = turn.surface, !surface.isEmpty {
            parts.append(surface)
        }
        if let model = turn.model, !model.isEmpty {
            parts.append(model)
        }
        if turn.inputTokens > 0 || turn.outputTokens > 0 {
            parts.append("\(turn.inputTokens.formatted()) in / \(turn.outputTokens.formatted()) out")
        }
        return parts.joined(separator: " · ")
    }
}

private struct WaterfallStepRow: View {
    let stepIndex: Int
    let isLast: Bool
    let step: AnalyticsEvent
    let turnModel: String?
    let turnStartMs: Double
    let turnSpanMs: Double
    let nested: Bool
    let onSelect: () -> Void

    private var accentColor: Color {
        if !step.ok { return MiloTheme.danger }
        switch step.event {
        case "tool.call": return MiloTheme.warning
        case "classifier.request": return MiloTheme.secondary
        case "embedding.request": return MiloTheme.muted
        default: return MiloTheme.accent
        }
    }

    private var offsetMs: Double {
        max(0, step.startMs - turnStartMs)
    }

    private var startFraction: Double {
        let raw = offsetMs / max(1, turnSpanMs)
        return min(0.94, max(0, raw))
    }

    private var widthFraction: Double {
        let raw = max(0, step.ms) / max(1, turnSpanMs)
        return min(1 - startFraction, max(0.03, raw))
    }

    private var ttftFraction: Double {
        guard step.event == "model.request", let ttft = step.ttftMs, step.ms > 0 else { return 0 }
        return min(1, max(0, ttft / step.ms))
    }

    private var stepMeta: String {
        var parts: [String] = []
        if let model = step.model, !model.isEmpty, model != turnModel { parts.append(model) }
        if let input = step.inputTokens, let output = step.outputTokens {
            parts.append("\(input.formatted()) in / \(output.formatted()) out")
        }
        if let ttft = step.ttftMs {
            parts.append("TTFT \(duration(ttft))")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .top, spacing: MiloTheme.Space.two) {
                VStack(spacing: 0) {
                    Circle()
                        .fill(accentColor)
                        .frame(width: 8, height: 8)
                        .padding(.top, 7)
                    if !isLast {
                        Rectangle()
                            .fill(accentColor.opacity(0.28))
                            .frame(width: 2)
                            .frame(maxHeight: .infinity)
                            .padding(.top, 3)
                    }
                }
                .padding(.leading, nested ? MiloTheme.Space.four : 0)

                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    HStack(spacing: MiloTheme.Space.two) {
                        Text("#\(stepIndex)")
                            .font(MiloTheme.Text.meta.weight(.semibold).monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                            .fixedSize()
                        Text(step.title)
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                            .minimumScaleFactor(0.88)
                        Spacer(minLength: MiloTheme.Space.two)
                        Text(duration(step.ms))
                            .font(MiloTheme.Text.small.weight(.medium).monospacedDigit())
                            .foregroundStyle(step.ok ? MiloTheme.foreground2 : MiloTheme.danger)
                            .lineLimit(1)
                            .fixedSize()
                    }

                    HStack(spacing: MiloTheme.Space.two) {
                        Text("+\(duration(offsetMs))")
                            .font(MiloTheme.Text.meta.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                            .lineLimit(1)
                            .fixedSize()

                        GeometryReader { geo in
                            let totalW = geo.size.width
                            let barX = totalW * startFraction
                            let barW = max(6, totalW * widthFraction)
                            let ttftW = barW * ttftFraction
                            ZStack(alignment: .leading) {
                                Capsule()
                                    .fill(MiloTheme.foreground.opacity(0.09))
                                ZStack(alignment: .leading) {
                                    Capsule()
                                        .fill(accentColor)
                                    if ttftW > 0 {
                                        Capsule()
                                            .fill(MiloTheme.foreground.opacity(0.3))
                                            .frame(width: ttftW)
                                    }
                                }
                                .frame(width: barW)
                                .offset(x: barX)
                            }
                        }
                        .frame(height: 7)
                    }

                    HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                        Text(EventKindFilter.displayLabel(for: step.event))
                            .font(MiloTheme.Text.meta.weight(.medium))
                            .foregroundStyle(MiloTheme.foreground2)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, MiloTheme.Space.two + 2)
                            .padding(.vertical, 2)
                            .background(MiloTheme.surfaceRaised, in: Capsule())

                        if !stepMeta.isEmpty {
                            Text(stepMeta)
                                .font(MiloTheme.Text.meta.monospacedDigit())
                                .foregroundStyle(MiloTheme.muted)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    if let error = step.error, !error.isEmpty {
                        Text(error)
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.danger)
                            .lineLimit(2)
                    }
                }
                .padding(MiloTheme.Space.three)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(radius: MiloTheme.Radius.md, fill: MiloTheme.background)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }
}

private extension View {
    @ViewBuilder
    func glassCard(
        radius: CGFloat = MiloTheme.Radius.lg,
        fill: Color? = nil,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        if let fill {
            let shape = RoundedRectangle(cornerRadius: radius)
            self
                .background(fill, in: shape)
                .background {
                    if let tint {
                        shape.fill(tint)
                    }
                }
        } else {
            self.miloGlassCard(radius: radius, tint: tint, interactive: interactive)
        }
    }
}
