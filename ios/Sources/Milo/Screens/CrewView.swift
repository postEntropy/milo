import SwiftUI

struct CrewAvatarModel: Decodable, Hashable, Sendable {
    var shape: String
    var eyes: String
    var accessory: String
    var palette: String

    static let shapes = ["orb", "pebble", "capsule", "droplet", "puff", "gem", "dome", "star"]
    static let eyesList = ["capsule", "happy", "curious", "visor", "wink", "spark"]
    static let accessories = ["none", "antenna", "sprout", "glasses", "headphones", "crown"]
    static let palettes = MiloPaletteId.allCases.map(\.rawValue)

    static let fallback = CrewAvatarModel(shape: "orb", eyes: "capsule", accessory: "none", palette: "peach")

    private static func hashSeed(_ seed: String) -> UInt32 {
        var h: UInt32 = 2_166_136_261
        for byte in seed.utf8 {
            h ^= UInt32(byte)
            h = h &* 16_777_619
        }
        return h
    }

    static func fromSeed(id: String, name: String = "") -> CrewAvatarModel {
        let h1 = Int(hashSeed("\(id):\(name)"))
        let h2 = Int(hashSeed("\(name):\(id):eyes"))
        let h3 = Int(hashSeed("\(id):acc:\(name)"))
        let h4 = Int(hashSeed("\(name):pal:\(id)"))
        return CrewAvatarModel(
            shape: shapes[h1 % shapes.count],
            eyes: eyesList[h2 % eyesList.count],
            accessory: accessories[h3 % accessories.count],
            palette: palettes[h4 % palettes.count]
        )
    }

    func with(shape: String? = nil, eyes: String? = nil, accessory: String? = nil, palette: String? = nil) -> CrewAvatarModel {
        CrewAvatarModel(
            shape: shape ?? self.shape,
            eyes: eyes ?? self.eyes,
            accessory: accessory ?? self.accessory,
            palette: palette ?? self.palette
        )
    }

    var traitSummary: String {
        let color = MiloPaletteId.resolve(palette).label
        let body = shape.capitalized
        let gaze = "\(eyes.capitalized) eyes"
        if accessory == "none" {
            return "\(color) · \(body) · \(gaze)"
        }
        return "\(color) · \(body) · \(gaze) · \(accessory.capitalized)"
    }
}

private struct CrewGuidance: Decodable, Identifiable {
    let id: String
    let text: String
    let at: Double?
    let appliedAt: Double?
}

private struct CrewAssignment: Decodable, Identifiable {
    let id: String
    let sessionId: String
    let mission: String
    let model: String
    let provider: String?
    let state: String
    let startedAt: Double?
    let finishedAt: Double?
    let report: String?
    let stopRequestedAt: Double?
    let guidance: [CrewGuidance]?
}

private struct CrewBot: Decodable, Identifiable {
    let id: String
    let name: String
    let createdAt: Double?
    let avatar: CrewAvatarModel?
    let assignments: [CrewAssignment]

    var resolvedAvatar: CrewAvatarModel {
        avatar ?? .fromSeed(id: id, name: name)
    }

    var latestAssignment: CrewAssignment? {
        assignments.last
    }

    var currentState: String {
        latestAssignment?.state ?? "available"
    }

    var lastActivityAt: Double? {
        if let latest = latestAssignment {
            return latest.finishedAt ?? latest.startedAt ?? createdAt
        }
        return createdAt
    }
}

private struct DelegatedRun: Decodable, Identifiable {
    let id: String
    let sessionId: String?
    let result: String
    let report: String?
    let deliveryError: String?
    let startedAt: Double
    let finishedAt: Double?
}

private struct DelegatedWork: Decodable, Identifiable {
    let id: String
    let name: String
    let objective: String
    let state: String
    let pauseAfterRun: Bool?
    let scheduleLabel: String?
    let allow: [String]
    let runs: [DelegatedRun]
}

private enum CrewPage: Hashable { case bot(String), work(String) }

struct CrewBotAvatar: View {
    let avatar: CrewAvatarModel
    var state: String? = nil
    var size: CGFloat = 36
    var animated: Bool = false

    private var blinkPhaseOffset: Double {
        var h: UInt32 = 2166136261
        for b in "\(avatar.shape):\(avatar.eyes):\(avatar.palette)".utf8 {
            h = (h ^ UInt32(b)) &* 16777619
        }
        return Double(h % 370) / 100.0
    }

    var body: some View {
        let preset = MiloPaletteId.resolve(avatar.palette).preset
        let top = Color.hex(preset.logoTop)
        let bottom = Color.hex(preset.logoBottom)
        let gradient = LinearGradient(colors: [top, bottom], startPoint: .topLeading, endPoint: .bottomTrailing)

        Group {
            if animated {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    let t = timeline.date.timeIntervalSinceReferenceDate
                    let speed = state == "running" ? 3.2 : 1.9
                    let floatY = sin(t * speed + blinkPhaseOffset) * (state == "running" ? 1.5 : 0.9)
                    let cycle = (t + blinkPhaseOffset).truncatingRemainder(dividingBy: 4.1)
                    let blinking = cycle > 3.94
                    avatarCanvas(top: top, bottom: bottom, floatY: floatY, blinking: blinking)
                }
            } else {
                avatarCanvas(top: top, bottom: bottom, floatY: 0, blinking: false)
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if state == "running" {
                Circle()
                    .fill(gradient)
                    .frame(width: max(8, size * 0.22), height: max(8, size * 0.22))
                    .overlay(
                        Circle().stroke(MiloTheme.background, lineWidth: max(1.5, size * 0.04))
                    )
            }
        }
        .accessibilityHidden(true)
    }

    private func avatarCanvas(top: Color, bottom: Color, floatY: Double, blinking: Bool) -> some View {
        Canvas { context, canvasSize in
            let s = min(canvasSize.width, canvasSize.height) / 40.0
            let dy = CGFloat(floatY) * s
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: (y + CGFloat(floatY)) * s) }
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
                CGRect(x: x * s, y: (y + CGFloat(floatY)) * s, width: w * s, height: h * s)
            }

            if size >= 64 {
                let shadowScale = CGFloat(1.0 - max(-0.12, min(0.12, floatY * 0.05)))
                let sw = 18.0 * shadowScale
                let shadowRect = CGRect(
                    x: (20.0 - sw / 2.0) * s,
                    y: 36.4 * s,
                    width: sw * s,
                    height: 2.6 * s
                )
                context.fill(Path(ellipseIn: shadowRect), with: .color(bottom.opacity(0.22)))
            }

            let bodyPath: Path = {
                var p = Path()
                switch avatar.shape {
                case "pebble":
                    p.addRoundedRect(in: rect(6.5, 7.5, 27, 27), cornerSize: CGSize(width: 9.5 * s, height: 9.5 * s))
                case "capsule":
                    p.addRoundedRect(in: rect(8.5, 6, 23, 29), cornerSize: CGSize(width: 11.5 * s, height: 11.5 * s))
                case "droplet":
                    p.move(to: pt(20, 5.5))
                    p.addCurve(to: pt(33.5, 24.8), control1: pt(27.5, 13), control2: pt(33.5, 18))
                    p.addArc(center: pt(20, 24.8), radius: 13.5 * s, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false)
                    p.addCurve(to: pt(20, 5.5), control1: pt(6.5, 18), control2: pt(12.5, 13))
                case "puff":
                    p.addRoundedRect(in: rect(6.5, 8.5, 27, 24), cornerSize: CGSize(width: 12 * s, height: 12 * s))
                    p.addEllipse(in: rect(12, 6, 16, 16))
                case "gem":
                    p.move(to: pt(14, 7))
                    p.addLine(to: pt(26, 7))
                    p.addLine(to: pt(33, 14))
                    p.addLine(to: pt(33, 27))
                    p.addLine(to: pt(26, 34))
                    p.addLine(to: pt(14, 34))
                    p.addLine(to: pt(7, 27))
                    p.addLine(to: pt(7, 14))
                    p.closeSubpath()
                case "dome":
                    p.addRoundedRect(in: rect(7, 14, 26, 20), cornerSize: CGSize(width: 4 * s, height: 4 * s))
                    p.addEllipse(in: rect(7, 7.5, 26, 22))
                case "star":
                    p.move(to: pt(20, 6))
                    p.addQuadCurve(to: pt(34, 20.5), control: pt(25, 15.5))
                    p.addQuadCurve(to: pt(20, 35), control: pt(25, 25.5))
                    p.addQuadCurve(to: pt(6, 20.5), control: pt(15, 25.5))
                    p.addQuadCurve(to: pt(20, 6), control: pt(15, 15.5))
                default:
                    p.addEllipse(in: rect(6.5, 7.5, 27, 27))
                }
                return p
            }()

            context.fill(
                bodyPath,
                with: .linearGradient(
                    Gradient(colors: [top, bottom]),
                    startPoint: CGPoint(x: 8 * s, y: 6 * s + dy),
                    endPoint: CGPoint(x: 32 * s, y: 35 * s + dy)
                )
            )
            var shine = Path()
            shine.addEllipse(in: rect(11, 9.5, 13, 6))
            context.fill(shine, with: .color(.white.opacity(0.22)))

            if blinking && avatar.eyes != "visor" {
                var closed = Path()
                closed.move(to: pt(12.6, 20.5))
                closed.addLine(to: pt(17.4, 20.5))
                closed.move(to: pt(22.6, 20.5))
                closed.addLine(to: pt(27.4, 20.5))
                context.stroke(closed, with: .color(.white), style: StrokeStyle(lineWidth: 2.3 * s, lineCap: .round))
            } else {
                switch avatar.eyes {
                case "happy":
                    var arcs = Path()
                    arcs.move(to: pt(12.2, 21.8))
                    arcs.addQuadCurve(to: pt(18, 21.8), control: pt(15.1, 16.6))
                    arcs.move(to: pt(22, 21.8))
                    arcs.addQuadCurve(to: pt(27.8, 21.8), control: pt(24.9, 16.6))
                    context.stroke(arcs, with: .color(.white), style: StrokeStyle(lineWidth: 2.5 * s, lineCap: .round))
                case "curious":
                    context.fill(Path(ellipseIn: rect(12.2, 18.2, 5.6, 5.6)), with: .color(.white))
                    context.fill(Path(ellipseIn: rect(22.8, 17.6, 4.0, 4.0)), with: .color(.white))
                case "visor":
                    let visor = Path(roundedRect: rect(9.8, 16.4, 20.4, 7.6), cornerSize: CGSize(width: 3.8 * s, height: 3.8 * s))
                    context.fill(visor, with: .color(Color.black.opacity(0.68)))
                    let eyeH: CGFloat = blinking ? 1.1 : 2.6
                    let eyeY: CGFloat = blinking ? 19.6 : 18.9
                    context.fill(Path(roundedRect: rect(13.2, eyeY, 4.4, eyeH), cornerSize: CGSize(width: 1.3 * s, height: 1.3 * s)), with: .color(.white))
                    context.fill(Path(roundedRect: rect(22.4, eyeY, 4.4, eyeH), cornerSize: CGSize(width: 1.3 * s, height: 1.3 * s)), with: .color(.white))
                case "wink":
                    var wink = Path()
                    wink.move(to: pt(12.5, 18.4))
                    wink.addLine(to: pt(16.7, 20.6))
                    wink.addLine(to: pt(12.5, 22.8))
                    context.stroke(wink, with: .color(.white), style: StrokeStyle(lineWidth: 2.4 * s, lineCap: .round, lineJoin: .round))
                    context.fill(Path(roundedRect: rect(22.8, 16.4, 3.6, 8.2), cornerSize: CGSize(width: 1.8 * s, height: 1.8 * s)), with: .color(.white))
                case "spark":
                    for cx in [15.2, 24.8] {
                        var star = Path()
                        star.move(to: pt(cx, 15.8))
                        star.addLine(to: pt(cx + 1.1, 19.1))
                        star.addLine(to: pt(cx + 4.4, 20.2))
                        star.addLine(to: pt(cx + 1.1, 21.3))
                        star.addLine(to: pt(cx, 24.6))
                        star.addLine(to: pt(cx - 1.1, 21.3))
                        star.addLine(to: pt(cx - 4.4, 20.2))
                        star.addLine(to: pt(cx - 1.1, 19.1))
                        star.closeSubpath()
                        context.fill(star, with: .color(.white))
                    }
                default:
                    context.fill(Path(roundedRect: rect(13.4, 16.4, 3.6, 8.2), cornerSize: CGSize(width: 1.8 * s, height: 1.8 * s)), with: .color(.white))
                    context.fill(Path(roundedRect: rect(23.0, 16.4, 3.6, 8.2), cornerSize: CGSize(width: 1.8 * s, height: 1.8 * s)), with: .color(.white))
                }
            }

            switch avatar.accessory {
            case "antenna":
                var stem = Path()
                stem.move(to: pt(20, 7.5))
                stem.addLine(to: pt(20, 3.2))
                context.stroke(stem, with: .color(top), style: StrokeStyle(lineWidth: 2.2 * s, lineCap: .round))
                context.fill(Path(ellipseIn: rect(17.7, 0.5, 4.6, 4.6)), with: .color(bottom))
            case "sprout":
                var stem = Path()
                stem.move(to: pt(20, 8.0))
                stem.addLine(to: pt(20, 4.4))
                context.stroke(stem, with: .color(Color.hex(0x3D9B83)), style: StrokeStyle(lineWidth: 2.0 * s, lineCap: .round))
                var leftLeaf = Path()
                leftLeaf.move(to: pt(20, 5.2))
                leftLeaf.addCurve(to: pt(14.8, 6.4), control1: pt(16.6, 2.2), control2: pt(13.5, 3.6))
                leftLeaf.addCurve(to: pt(20, 5.2), control1: pt(16.4, 8.0), control2: pt(19.0, 6.6))
                context.fill(leftLeaf, with: .color(Color.hex(0x73A66A)))
                var rightLeaf = Path()
                rightLeaf.move(to: pt(20, 5.2))
                rightLeaf.addCurve(to: pt(25.2, 6.4), control1: pt(23.4, 2.2), control2: pt(26.5, 3.6))
                rightLeaf.addCurve(to: pt(20, 5.2), control1: pt(23.6, 8.0), control2: pt(21.0, 6.6))
                context.fill(rightLeaf, with: .color(Color.hex(0x83CBB0)))
            case "glasses":
                let leftLens = Path(roundedRect: rect(10.0, 15.8, 9.2, 9.2), cornerSize: CGSize(width: 3.4 * s, height: 3.4 * s))
                let rightLens = Path(roundedRect: rect(20.8, 15.8, 9.2, 9.2), cornerSize: CGSize(width: 3.4 * s, height: 3.4 * s))
                context.fill(leftLens, with: .color(.black.opacity(0.14)))
                context.fill(rightLens, with: .color(.black.opacity(0.14)))
                context.stroke(leftLens, with: .color(.white.opacity(0.92)), lineWidth: 1.5 * s)
                context.stroke(rightLens, with: .color(.white.opacity(0.92)), lineWidth: 1.5 * s)
                var bridge = Path()
                bridge.move(to: pt(19.2, 19.8))
                bridge.addLine(to: pt(20.8, 19.8))
                context.stroke(bridge, with: .color(.white.opacity(0.92)), style: StrokeStyle(lineWidth: 1.5 * s, lineCap: .round))
            case "headphones":
                var band = Path()
                band.addArc(center: pt(20, 20), radius: 12.6 * s, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
                context.stroke(band, with: .color(top), style: StrokeStyle(lineWidth: 2.3 * s, lineCap: .round))
                context.fill(Path(roundedRect: rect(4, 16.8, 3.8, 8.6), cornerSize: CGSize(width: 1.9 * s, height: 1.9 * s)), with: .color(top))
                context.fill(Path(roundedRect: rect(32.2, 16.8, 3.8, 8.6), cornerSize: CGSize(width: 1.9 * s, height: 1.9 * s)), with: .color(top))
            case "crown":
                var crown = Path()
                crown.move(to: pt(13.8, 8.4))
                crown.addLine(to: pt(15.2, 3.2))
                crown.addLine(to: pt(20, 6.4))
                crown.addLine(to: pt(24.8, 3.2))
                crown.addLine(to: pt(26.2, 8.4))
                crown.closeSubpath()
                context.fill(crown, with: .color(Color.hex(0xE9AF56)))
                context.stroke(crown, with: .color(Color.hex(0xD96B36)), style: StrokeStyle(lineWidth: 0.9 * s, lineJoin: .round))
            default:
                break
            }
        }
    }
}

private struct IdentifiableBotId: Identifiable {
    let id: String
}

struct CrewView: View {
    let account: Account
    @Binding var pushed: Bool
    let onSessions: () -> Void
    @State private var bots: [CrewBot] = []
    @State private var work: [DelegatedWork] = []
    @State private var path: [CrewPage] = []
    @State private var error: String?
    @State private var loading = true
    @State private var busy = false
    @State private var customizingBot: IdentifiableBotId?
    @State private var expandedMissions: Set<String> = []
    @State private var editingWork = false
    @State private var renameDraft = ""
    @State private var guidanceDraft = ""
    @State private var objectiveDraft = ""
    @State private var scheduleMode = "every"
    @State private var scheduleDraft = ""
    @State private var renaming: CrewBot?
    @State private var openRun: RoutineRun?
    @State private var runName = ""

    private var sortedBots: [CrewBot] {
        bots.sorted { lhs, rhs in
            let lRunning = lhs.currentState == "running"
            let rRunning = rhs.currentState == "running"
            if lRunning != rRunning { return lRunning }
            return (lhs.lastActivityAt ?? 0) > (rhs.lastActivityAt ?? 0)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            CrewHome(
                bots: sortedBots,
                work: work,
                loading: loading,
                error: error,
                onSessions: onSessions,
                onRefresh: { await refresh() },
                botCard: { bot in
                    botCard(bot) {
                        path.append(.bot(bot.id))
                    }
                },
                workRow: { item in
                    workRow(item) {
                        objectiveDraft = item.objective
                        editingWork = false
                        path.append(.work(item.id))
                    }
                }
            )
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CrewPage.self) { page in
                switch page {
                case .bot(let id):
                    if let bot = bots.first(where: { $0.id == id }) {
                        botDetailPage(bot)
                    } else {
                        missingPage("Bot not found.")
                    }
                case .work(let id):
                    if let item = work.first(where: { $0.id == id }) {
                        workDetailPage(item)
                    } else {
                        missingPage("Work not found.")
                    }
                }
            }
        }
        .onChange(of: path) { _, next in pushed = !next.isEmpty }
        .onAppear { pushed = !path.isEmpty }
        .task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            }
        }
        .alert("Rename bot", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameDraft)
            Button("Save") {
                if let bot = renaming {
                    let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !name.isEmpty { Task { await rename(bot.id, name: name) } }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $customizingBot) { item in
            if let bot = bots.first(where: { $0.id == item.id }) {
                BotAppearanceSheet(
                    bot: bot,
                    busy: busy,
                    onShuffle: { Task { await updateAvatar(bot.id, field: "shuffle") } },
                    onSelect: { field, value in
                        Task { await updateAvatar(bot.id, field: field, value: value) }
                    }
                )
            }
        }
        .sheet(item: $openRun) { run in RunDetail(run: run, name: runName) }
    }

    // MARK: - Home Cards

    private func botCard(_ bot: CrewBot, action: @escaping () -> Void) -> some View {
        let last = bot.latestAssignment
        let state = bot.currentState
        let isRunning = state == "running"
        let isAlert = state == "failed" || state == "interrupted"
        let preset = MiloPaletteId.resolve(bot.resolvedAvatar.palette).preset
        let haloTone = Color.hex(preset.logoTop)

        return Button(action: action) {
            HStack(alignment: .center, spacing: MiloTheme.Space.four) {
                ZStack {
                    RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                        .fill(haloTone.opacity(0.13))
                        .frame(width: 60, height: 60)
                    CrewBotAvatar(
                        avatar: bot.resolvedAvatar,
                        state: state,
                        size: 46,
                        animated: isRunning
                    )
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.one + 1) {
                    HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                        Text(bot.name)
                            .font(MiloTheme.Text.body.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)

                        if isRunning {
                            statusBadge("Working", tone: MiloTheme.accent)
                        } else if isAlert {
                            statusBadge(state, tone: statusTone(state))
                        }

                        Spacer(minLength: MiloTheme.Space.two)

                        if let at = bot.lastActivityAt {
                            Text(RelativeTime.when(at))
                                .font(MiloTheme.Text.meta)
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }

                    Text(previewLine(for: last))
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.mutedStrong)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.muted2)
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .miloGlassCard(
                radius: MiloTheme.Radius.xl,
                tint: isRunning ? MiloTheme.accent.opacity(0.14) : nil,
                interactive: true
            )
        }
        .buttonStyle(PressableStyle())
        .contextMenu {
            menuItem("Customize appearance", "slider.horizontal.3") {
                customizingBot = IdentifiableBotId(id: bot.id)
            }
            menuItem("Shuffle avatar", "sparkles", disabled: busy) {
                Task { await updateAvatar(bot.id, field: "shuffle") }
            }
            menuItem("Rename", "pencil") {
                renameDraft = bot.name
                renaming = bot
            }
            if isRunning, last?.stopRequestedAt == nil {
                Button(role: .destructive) {
                    Task { await stop(bot.id) }
                } label: {
                    Label("Stop bot", systemImage: "stop.fill")
                }
            }
        }
    }

    private func workRow(_ item: DelegatedWork, action: @escaping () -> Void) -> some View {
        let sessionIds = Set(item.runs.compactMap(\.sessionId))
        let assignedBots = bots.filter { bot in bot.assignments.contains { sessionIds.contains($0.sessionId) } }
        let tone = statusTone(item.state)
        return Button(action: action) {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                HStack(spacing: MiloTheme.Space.two) {
                    Text(item.name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                    Spacer()
                    statusBadge(item.state, tone: tone)
                }
                Text(cleanSnippet(item.objective))
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.mutedStrong)
                    .lineLimit(2)
                HStack(spacing: MiloTheme.Space.two) {
                    Label(item.scheduleLabel ?? "Runs once", systemImage: "clock")
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                    Spacer()
                    if !assignedBots.isEmpty {
                        HStack(spacing: -6) {
                            ForEach(assignedBots.prefix(4)) { bot in
                                CrewBotAvatar(avatar: bot.resolvedAvatar, size: 24)
                                    .padding(2)
                                    .background(MiloTheme.background, in: Circle())
                            }
                        }
                    }
                }
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .miloGlassCard(
                radius: MiloTheme.Radius.xl,
                tint: item.state == "running" ? MiloTheme.accent.opacity(0.14) : nil,
                interactive: true
            )
        }
        .buttonStyle(PressableStyle())
    }

    // MARK: - Bot Detail Page

    private func botDetailPage(_ bot: CrewBot) -> some View {
        let avatar = bot.resolvedAvatar
        let current = bot.latestAssignment
        let state = bot.currentState
        let isRunning = state == "running"
        let preset = MiloPaletteId.resolve(avatar.palette).preset
        let haloTone = Color.hex(preset.logoTop)

        return ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let error { MiloErrorPill(text: error) }

                // Character Profile Stage Card
                VStack(spacing: MiloTheme.Space.four) {
                    ZStack {
                        Circle()
                            .fill(haloTone.opacity(0.15))
                            .frame(width: 112, height: 112)
                        CrewBotAvatar(
                            avatar: avatar,
                            state: state,
                            size: 92,
                            animated: true
                        )
                    }
                    .padding(.top, MiloTheme.Space.one)

                    VStack(spacing: MiloTheme.Space.one + 2) {
                        Text(bot.name)
                            .font(MiloTheme.Text.title.weight(.bold))
                            .foregroundStyle(MiloTheme.foreground)
                            .multilineTextAlignment(.center)

                        if isRunning {
                            statusBadge(
                                current?.startedAt.map { "Working · \(RelativeTime.elapsed(Date().timeIntervalSince1970 * 1000 - $0))" } ?? "Working",
                                tone: MiloTheme.accent
                            )
                        } else {
                            Text(botSummaryLine(bot))
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                                .multilineTextAlignment(.center)
                        }
                    }

                    HStack(spacing: MiloTheme.Space.two) {
                        profileActionPill("Customize", symbol: "slider.horizontal.3") {
                            customizingBot = IdentifiableBotId(id: bot.id)
                        }
                        profileActionPill("Shuffle", symbol: "sparkles", disabled: busy) {
                            Task { await updateAvatar(bot.id, field: "shuffle") }
                        }
                        profileActionPill("Rename", symbol: "pencil") {
                            renameDraft = bot.name
                            renaming = bot
                        }
                    }
                    .padding(.top, MiloTheme.Space.one)
                }
                .padding(MiloTheme.Space.five)
                .frame(maxWidth: .infinity)
                .miloGlassCard(radius: MiloTheme.Radius.xl)
                .sensoryFeedback(.selection, trigger: avatar)

                // Live Guidance & Stop Bar (when running)
                if let current, current.state == "running" {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        if current.stopRequestedAt == nil {
                            Text("Guide \(bot.name)")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .foregroundStyle(MiloTheme.muted)
                            HStack(spacing: MiloTheme.Space.two) {
                                TextField("Steer on its next step…", text: $guidanceDraft)
                                    .font(MiloTheme.Text.body)
                                    .foregroundStyle(MiloTheme.foreground)
                                    .padding(.horizontal, MiloTheme.Space.four)
                                    .padding(.vertical, MiloTheme.Space.three)
                                    .background(MiloTheme.surfaceRaised, in: Capsule())
                                Button {
                                    Task { await guide(bot.id) }
                                } label: {
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(MiloTheme.accentOn)
                                        .frame(width: 42, height: 42)
                                        .background(MiloTheme.accent, in: Circle())
                                }
                                .buttonStyle(PressableStyle())
                                .disabled(busy || guidanceDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }
                        Button {
                            Task { await stop(bot.id) }
                        } label: {
                            Label(current.stopRequestedAt != nil ? "Stopping…" : "Stop bot", systemImage: "stop.fill")
                                .font(MiloTheme.Text.small.weight(.semibold))
                                .foregroundStyle(MiloTheme.danger)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, MiloTheme.Space.three)
                                .background(MiloTheme.danger.opacity(0.14), in: Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(busy || current.stopRequestedAt != nil)
                    }
                    .padding(MiloTheme.Space.four)
                    .miloGlassCard(radius: MiloTheme.Radius.xl, tint: MiloTheme.accent.opacity(0.14))
                }

                // Missions History
                VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(bot.assignments.count == 1 ? "Mission" : "Missions")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                        if bot.assignments.count > 1 {
                            Spacer()
                            Text("\(bot.assignments.count)")
                                .font(MiloTheme.Text.small.weight(.medium))
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }

                    if bot.assignments.isEmpty {
                        Text("No missions yet. Ask Milo to delegate a task to \(bot.name).")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .padding(MiloTheme.Space.five)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .miloGlassCard(radius: MiloTheme.Radius.xl)
                    } else {
                        ForEach(bot.assignments.reversed()) { assignment in
                            assignmentCard(assignment)
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .miloWallpaperBackground()
        .navigationTitle(bot.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
    }

    private func profileActionPill(
        _ label: String,
        symbol: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: MiloTheme.Space.one + 2) {
                Image(systemName: symbol)
                    .font(.system(size: 12, weight: .semibold))
                Text(label)
                    .font(MiloTheme.Text.small.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(MiloTheme.foreground)
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.two + 2)
            .frame(maxWidth: .infinity)
            .background(MiloTheme.surfaceRaised, in: Capsule())
        }
        .buttonStyle(PressableStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    private func assignmentCard(_ assignment: CrewAssignment) -> some View {
        let tone = statusTone(assignment.state)
        let isExpanded = expandedMissions.contains(assignment.id)
        let canExpandMission = assignment.mission.count > 100 || assignment.mission.contains("\n")

        return VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
            HStack(spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.one + 2) {
                    Circle().fill(tone).frame(width: 7, height: 7)
                    Text(assignmentTimingLabel(assignment))
                        .font(MiloTheme.Text.meta.weight(.semibold))
                        .foregroundStyle(assignment.state == "completed" ? MiloTheme.mutedStrong : tone)
                        .lineLimit(1)
                }

                Spacer(minLength: MiloTheme.Space.two)

                HStack(spacing: MiloTheme.Space.one + 2) {
                    if let provider = assignment.provider, !provider.isEmpty {
                        ProviderMark(id: provider, size: 13)
                    }
                    Text(shortModelName(assignment.model))
                        .font(MiloTheme.Text.meta.weight(.medium))
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                }
                .padding(.horizontal, MiloTheme.Space.two + 2)
                .padding(.vertical, MiloTheme.Space.one)
                .background(MiloTheme.surfaceRaised, in: Capsule())
            }

            // Compact, collapsible Mission prompt box
            Button {
                guard canExpandMission else { return }
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isExpanded {
                        expandedMissions.remove(assignment.id)
                    } else {
                        expandedMissions.insert(assignment.id)
                    }
                }
            } label: {
                VStack(alignment: .leading, spacing: MiloTheme.Space.one + 2) {
                    HStack(spacing: MiloTheme.Space.one) {
                        Text("MISSION")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .tracking(0.8)
                            .foregroundStyle(MiloTheme.muted)
                        Spacer()
                        if canExpandMission {
                            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(MiloTheme.muted)
                        }
                    }
                    Text(assignment.mission)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground2)
                        .lineLimit(isExpanded ? nil : 2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(MiloTheme.Space.three)
                .background(MiloTheme.surfaceWarm.opacity(0.75), in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            }
            .buttonStyle(.plain)

            if let guidance = assignment.guidance, !guidance.isEmpty {
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    ForEach(guidance) { item in
                        HStack(spacing: MiloTheme.Space.two) {
                            Image(systemName: "bubble.left.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(MiloTheme.accent)
                            Text(item.text)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.foreground2)
                            Spacer()
                            Text(item.appliedAt != nil ? "Applied" : assignment.state == "running" ? "Queued" : "Skipped")
                                .font(MiloTheme.Text.meta)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.three)
                        .background(MiloTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.sm))
                    }
                }
            }

            if let report = assignment.report, !report.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Prose(text: report, color: MiloTheme.foreground)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if assignment.state == "running" {
                HStack(spacing: MiloTheme.Space.two) {
                    ProgressView().controlSize(.small)
                    Text("Working on this mission…")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
        }
        .padding(MiloTheme.Space.five)
        .frame(maxWidth: .infinity, alignment: .leading)
        .miloGlassCard(radius: MiloTheme.Radius.xl)
    }

    // MARK: - Work Detail Page

    private func workDetailPage(_ item: DelegatedWork) -> some View {
        let tone = statusTone(item.state)
        let canEdit = !["running", "completed", "cancelled"].contains(item.state)

        return ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let error { MiloErrorPill(text: error) }

                VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                    HStack {
                        statusBadge(item.pauseAfterRun == true ? "Pausing after run" : item.state, tone: tone)
                        Spacer()
                        Text(item.scheduleLabel ?? "Runs once")
                            .font(MiloTheme.Text.meta.weight(.medium))
                            .foregroundStyle(MiloTheme.muted)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.one)
                            .background(MiloTheme.surfaceRaised, in: Capsule())
                    }

                    Text(item.name)
                        .font(MiloTheme.Text.title.weight(.bold))
                        .foregroundStyle(MiloTheme.foreground)

                    Text(item.objective)
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.foreground2)

                    Label(
                        item.allow.isEmpty ? "Read-only while unattended" : "Allowed tools: \(item.allow.joined(separator: ", "))",
                        systemImage: "shield"
                    )
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                }
                .padding(MiloTheme.Space.five)
                .frame(maxWidth: .infinity, alignment: .leading)
                .miloGlassCard(radius: MiloTheme.Radius.xl)

                if canEdit && editingWork {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                        MiloField(label: "Objective", text: $objectiveDraft, placeholder: "Describe the objective")
                        Button {
                            Task { await edit(item.id, field: "objective", value: objectiveDraft) }
                        } label: {
                            Text("Save objective")
                                .font(MiloTheme.Text.small.weight(.semibold))
                                .foregroundStyle(MiloTheme.accentOn)
                                .padding(.horizontal, MiloTheme.Space.four)
                                .padding(.vertical, MiloTheme.Space.two + 2)
                                .background(MiloTheme.accent, in: Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(busy || objectiveDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || objectiveDraft == item.objective)

                        Picker("Schedule", selection: $scheduleMode) {
                            Text("Interval").tag("every")
                            Text("Daily time").tag("at")
                            Text("Run once").tag("once")
                        }
                        .pickerStyle(.segmented)

                        if scheduleMode != "once" {
                            MiloField(
                                label: scheduleMode == "every" ? "Interval" : "Daily time",
                                text: $scheduleDraft,
                                placeholder: scheduleMode == "every" ? "2h" : "08:00"
                            )
                        }
                        Button {
                            Task { await edit(item.id, field: scheduleMode, value: scheduleDraft) }
                        } label: {
                            Text("Save schedule")
                                .font(MiloTheme.Text.small.weight(.semibold))
                                .foregroundStyle(MiloTheme.accentOn)
                                .padding(.horizontal, MiloTheme.Space.four)
                                .padding(.vertical, MiloTheme.Space.two + 2)
                                .background(MiloTheme.accent, in: Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(busy || (scheduleMode != "once" && scheduleDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    }
                    .padding(MiloTheme.Space.four)
                    .miloGlassCard(radius: MiloTheme.Radius.xl)
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                    Text(item.runs.isEmpty ? "Runs" : "Runs · \(item.runs.count)")
                        .font(MiloTheme.Text.title)
                        .foregroundStyle(MiloTheme.foreground)

                    if item.runs.isEmpty {
                        Text("No runs yet.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .padding(MiloTheme.Space.five)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .miloGlassCard(radius: MiloTheme.Radius.xl)
                    } else {
                        ForEach(item.runs.reversed()) { run in
                            workRunCard(item: item, run: run)
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six + 56)
            .frame(maxWidth: 620, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .miloWallpaperBackground()
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            if canEdit {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        withAnimation(.snappy(duration: 0.22)) { editingWork.toggle() }
                    } label: {
                        Text(editingWork ? "Done" : "Edit")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !["completed", "cancelled"].contains(item.state) {
                HStack(spacing: MiloTheme.Space.two) {
                    if ["queued", "running", "waiting"].contains(item.state) {
                        Button {
                            Task { await control(item.id, action: "pause") }
                        } label: {
                            Label("Pause", systemImage: "pause.fill")
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .frame(maxWidth: .infinity)
                                .frame(height: 50)
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(busy || item.pauseAfterRun == true)
                        .glassEffect(.regular.interactive(), in: Capsule())
                    }
                    if ["paused", "failed", "interrupted"].contains(item.state) {
                        Button {
                            Task { await control(item.id, action: "resume") }
                        } label: {
                            Label("Resume", systemImage: "play.fill")
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.accentOn)
                                .frame(maxWidth: .infinity)
                                .frame(height: 50)
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(busy)
                        .glassEffect(.regular.tint(MiloTheme.accent).interactive(), in: Capsule())
                    }
                    Button {
                        Task { await control(item.id, action: "cancel") }
                    } label: {
                        Label("Cancel", systemImage: "xmark")
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.danger)
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                    }
                    .buttonStyle(PressableStyle())
                    .disabled(busy)
                    .glassEffect(.regular.interactive(), in: Capsule())
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.vertical, MiloTheme.Space.three)
            }
        }
    }

    private func workRunCard(item: DelegatedWork, run: DelegatedRun) -> some View {
        let tone = statusTone(run.result)
        let runBots = bots.filter { bot in bot.assignments.contains { $0.sessionId == run.sessionId } }
        let timing: String = {
            let when = RelativeTime.when(run.startedAt)
            if let finishedAt = run.finishedAt, finishedAt >= run.startedAt {
                return "\(when) · \(RelativeTime.elapsed(finishedAt - run.startedAt))"
            }
            return when
        }()

        return VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
            HStack(spacing: MiloTheme.Space.two) {
                HStack(spacing: MiloTheme.Space.one + 2) {
                    Circle().fill(tone).frame(width: 7, height: 7)
                    Text(run.result == "completed" ? timing : "\(run.result.capitalized) · \(timing)")
                        .font(MiloTheme.Text.meta.weight(.semibold))
                        .foregroundStyle(run.result == "completed" ? MiloTheme.mutedStrong : tone)
                }
                Spacer()
                if let id = run.sessionId {
                    Button {
                        runName = item.name
                        openRun = RoutineRun(id: id, at: run.startedAt)
                    } label: {
                        Label("Open run", systemImage: "text.bubble")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.one + 2)
                            .background(MiloTheme.surfaceRaised, in: Capsule())
                    }
                    .buttonStyle(PressableStyle())
                }
            }

            if let report = run.report, !report.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Prose(text: report, color: MiloTheme.foreground)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let failure = run.deliveryError {
                Label("Could not deliver: \(failure)", systemImage: "exclamationmark.triangle")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.danger)
            }

            if !runBots.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: MiloTheme.Space.two) {
                        ForEach(runBots) { bot in
                            Button {
                                path.append(.bot(bot.id))
                            } label: {
                                HStack(spacing: MiloTheme.Space.two) {
                                    CrewBotAvatar(avatar: bot.resolvedAvatar, state: bot.currentState, size: 22)
                                    Text(bot.name)
                                        .font(MiloTheme.Text.small.weight(.medium))
                                        .foregroundStyle(MiloTheme.foreground)
                                }
                                .padding(.horizontal, MiloTheme.Space.three)
                                .padding(.vertical, MiloTheme.Space.one + 2)
                                .background(MiloTheme.surfaceRaised, in: Capsule())
                            }
                            .buttonStyle(PressableStyle())
                        }
                    }
                }
                .marksSidewaysDrag()
            }
        }
        .padding(MiloTheme.Space.five)
        .frame(maxWidth: .infinity, alignment: .leading)
        .miloGlassCard(radius: MiloTheme.Radius.xl)
    }

    // MARK: - Formatting & Helpers

    private func previewLine(for assignment: CrewAssignment?) -> String {
        guard let assignment else { return "Ready for a mission" }
        if assignment.state != "running", let report = assignment.report {
            let cleaned = cleanSnippet(report)
            if !cleaned.isEmpty { return cleaned }
        }
        let mission = cleanSnippet(assignment.mission)
        return mission.isEmpty ? "Ready for a mission" : mission
    }

    private func cleanSnippet(_ raw: String) -> String {
        raw
            .components(separatedBy: .newlines)
            .map { line in
                line
                    .trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
                    .replacingOccurrences(of: #"^[-*+]\s+"#, with: "", options: .regularExpression)
                    .replacingOccurrences(of: "**", with: "")
                    .replacingOccurrences(of: "`", with: "")
            }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private func botSummaryLine(_ bot: CrewBot) -> String {
        let count = bot.assignments.count
        let missions = "\(count) \(count == 1 ? "mission" : "missions")"
        if let at = bot.lastActivityAt {
            return "\(missions) · Active \(RelativeTime.when(at))"
        }
        return missions
    }

    private func assignmentTimingLabel(_ assignment: CrewAssignment) -> String {
        switch assignment.state {
        case "running":
            if let started = assignment.startedAt {
                return "Working · \(RelativeTime.elapsed(Date().timeIntervalSince1970 * 1000 - started))"
            }
            return "Working"
        case "completed":
            let anchor = assignment.finishedAt ?? assignment.startedAt
            let when = anchor.map(RelativeTime.when) ?? "Completed"
            if let started = assignment.startedAt, let finished = assignment.finishedAt, finished >= started {
                return "\(when) · \(RelativeTime.elapsed(finished - started))"
            }
            return when
        default:
            let label = assignment.state.capitalized
            if let anchor = assignment.finishedAt ?? assignment.startedAt {
                return "\(label) · \(RelativeTime.when(anchor))"
            }
            return label
        }
    }

    private func shortModelName(_ model: String) -> String {
        if let last = model.split(separator: "/").last {
            return String(last)
        }
        return model
    }

    private func missingPage(_ message: String) -> some View {
        VStack {
            Text(message)
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.muted)
                .padding(MiloTheme.Space.five)
                .miloGlassCard()
        }
        .padding(MiloTheme.margin)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .miloWallpaperBackground()
        .toolbar(.visible, for: .navigationBar)
    }

    private func statusTone(_ state: String) -> Color {
        switch state {
        case "running": return MiloTheme.accent
        case "completed": return MiloTheme.success
        case "failed", "interrupted", "cancelled": return MiloTheme.danger
        case "paused": return MiloTheme.warning
        default: return MiloTheme.muted
        }
    }

    private func statusBadge(_ label: String, tone: Color) -> some View {
        HStack(spacing: MiloTheme.Space.one + 2) {
            Circle().fill(tone).frame(width: 7, height: 7)
            Text(label.capitalized)
                .font(MiloTheme.Text.meta.weight(.semibold))
                .foregroundStyle(tone)
                .lineLimit(1)
        }
        .fixedSize(horizontal: true, vertical: false)
        .padding(.horizontal, MiloTheme.Space.two + 2)
        .padding(.vertical, MiloTheme.Space.one)
        .background(tone.opacity(0.14), in: Capsule())
    }

    // MARK: - API Actions

    @MainActor private func refresh() async {
        do {
            async let nextBots = MiloApi.call("crew", account: account, as: [CrewBot].self)
            async let nextWork = MiloApi.call("delegated-work", account: account, as: [DelegatedWork].self)
            (bots, work) = try await (nextBots, nextWork)
            error = nil
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    @MainActor private func rename(_ id: String, name: String) async {
        busy = true; defer { busy = false }
        do { _ = try await MiloApi.call("crew-rename", ["id": id, "name": name], account: account, as: CrewBot.self); await refresh() }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func updateAvatar(_ id: String, field: String, value: String = "") async {
        busy = true; defer { busy = false }
        do {
            if field == "shuffle" {
                _ = try await MiloApi.call("crew-avatar", ["id": id, "shuffle": true], account: account, as: CrewBot.self)
            } else {
                _ = try await MiloApi.call("crew-avatar", ["id": id, field: value], account: account, as: CrewBot.self)
            }
            await refresh()
        }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func stop(_ id: String) async {
        busy = true; defer { busy = false }
        do { _ = try await MiloApi.call("crew-stop", ["id": id], account: account, as: MiloApi.Ack.self); await refresh() }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func guide(_ id: String) async {
        let text = guidanceDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        busy = true; defer { busy = false }
        do { _ = try await MiloApi.call("crew-guide", ["id": id, "text": text], account: account, as: MiloApi.Ack.self); guidanceDraft = ""; await refresh() }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func control(_ id: String, action: String) async {
        busy = true; defer { busy = false }
        do { _ = try await MiloApi.call("delegated-work-control", ["id": id, "action": action], account: account, as: DelegatedWork.self); await refresh() }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func edit(_ id: String, field: String, value: String) async {
        busy = true; defer { busy = false }
        do {
            if field == "once" {
                _ = try await MiloApi.call("delegated-work-edit", ["id": id, "once": true], account: account, as: DelegatedWork.self)
            } else {
                _ = try await MiloApi.call("delegated-work-edit", ["id": id, field: value], account: account, as: DelegatedWork.self)
            }
            scheduleDraft = ""; editingWork = false; await refresh()
        }
        catch { self.error = error.localizedDescription }
    }
}

// MARK: - Bot Appearance Studio Sheet

private struct BotAppearanceSheet: View {
    let bot: CrewBot
    let busy: Bool
    let onShuffle: () -> Void
    let onSelect: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss

    private var avatar: CrewAvatarModel { bot.resolvedAvatar }

    var body: some View {
        let preset = MiloPaletteId.resolve(avatar.palette).preset
        let haloTone = Color.hex(preset.logoTop)

        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
                HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text("Appearance")
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                        Text(avatar.traitSummary)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: MiloTheme.Space.two)
                    MiloIconButton(
                        systemName: "sparkles",
                        size: 15,
                        span: 36,
                        glass: true,
                        disabled: busy,
                        action: onShuffle
                    )
                    .accessibilityLabel("Shuffle avatar")
                    MiloIconButton(
                        systemName: "xmark",
                        size: 15,
                        span: 36,
                        glass: true,
                        action: { dismiss() }
                    )
                    .accessibilityLabel("Close")
                }

                // Live Animated Preview Stage
                VStack(spacing: MiloTheme.Space.two) {
                    ZStack {
                        Circle()
                            .fill(haloTone.opacity(0.16))
                            .frame(width: 118, height: 118)
                        CrewBotAvatar(avatar: avatar, size: 96, animated: true)
                    }
                    Text(bot.name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                }
                .padding(.vertical, MiloTheme.Space.four)
                .frame(maxWidth: .infinity)
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))

                // Palette Swatches
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    Text("Color")
                        .font(MiloTheme.Text.meta.weight(.semibold))
                        .foregroundStyle(MiloTheme.muted)
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 44), spacing: MiloTheme.Space.two)],
                        spacing: MiloTheme.Space.two
                    ) {
                        ForEach(CrewAvatarModel.palettes, id: \.self) { paletteId in
                            let itemPreset = MiloPaletteId.resolve(paletteId).preset
                            let selected = avatar.palette == paletteId
                            Button {
                                onSelect("palette", paletteId)
                            } label: {
                                ZStack {
                                    Circle()
                                        .fill(
                                            LinearGradient(
                                                colors: [Color.hex(itemPreset.logoTop), Color.hex(itemPreset.logoBottom)],
                                                startPoint: .topLeading,
                                                endPoint: .bottomTrailing
                                            )
                                        )
                                        .frame(width: 36, height: 36)
                                    if selected {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 13, weight: .bold))
                                            .foregroundStyle(.white)
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, MiloTheme.Space.one + 2)
                                .background(
                                    selected ? MiloTheme.surfaceRaised : Color.clear,
                                    in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                                )
                            }
                            .buttonStyle(PressableStyle())
                            .disabled(busy)
                            .accessibilityLabel(itemPreset.label)
                        }
                    }
                }

                // Shape Grid (8 shapes, 4 columns)
                traitGrid(
                    title: "Shape",
                    columns: 4,
                    items: CrewAvatarModel.shapes,
                    selected: avatar.shape,
                    preview: { avatar.with(shape: $0) },
                    label: { $0.capitalized },
                    onSelect: { onSelect("shape", $0) }
                )

                // Eyes Grid (6 styles, 3 columns)
                traitGrid(
                    title: "Eyes",
                    columns: 3,
                    items: CrewAvatarModel.eyesList,
                    selected: avatar.eyes,
                    preview: { avatar.with(eyes: $0) },
                    label: { $0.capitalized },
                    onSelect: { onSelect("eyes", $0) }
                )

                // Accessory Grid (6 accessories, 3 columns)
                traitGrid(
                    title: "Accessory",
                    columns: 3,
                    items: CrewAvatarModel.accessories,
                    selected: avatar.accessory,
                    preview: { avatar.with(accessory: $0) },
                    label: { $0 == "none" ? "None" : $0.capitalized },
                    onSelect: { onSelect("accessory", $0) }
                )
            }
        }
        .sensoryFeedback(.selection, trigger: avatar)
    }

    private func traitGrid(
        title: String,
        columns: Int,
        items: [String],
        selected: String,
        preview: @escaping (String) -> CrewAvatarModel,
        label: @escaping (String) -> String,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(title)
                .font(MiloTheme.Text.meta.weight(.semibold))
                .foregroundStyle(MiloTheme.muted)
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: MiloTheme.Space.two), count: columns),
                spacing: MiloTheme.Space.two
            ) {
                ForEach(items, id: \.self) { item in
                    let isSelected = item == selected
                    Button {
                        onSelect(item)
                    } label: {
                        VStack(spacing: MiloTheme.Space.one + 2) {
                            CrewBotAvatar(avatar: preview(item), size: 32)
                            Text(label(item))
                                .font(MiloTheme.Text.meta.weight(isSelected ? .semibold : .medium))
                                .foregroundStyle(isSelected ? MiloTheme.accent : MiloTheme.foreground2)
                                .lineLimit(1)
                        }
                        .padding(.vertical, MiloTheme.Space.three)
                        .padding(.horizontal, MiloTheme.Space.two)
                        .frame(maxWidth: .infinity)
                        .background(
                            isSelected ? MiloTheme.accent.opacity(0.15) : MiloTheme.surface,
                            in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                        )
                    }
                    .buttonStyle(PressableStyle())
                    .disabled(busy)
                }
            }
        }
    }
}

// MARK: - Home Screen

private struct CrewHome<BotCardView: View, WorkRowView: View>: View {
    let bots: [CrewBot]
    let work: [DelegatedWork]
    let loading: Bool
    let error: String?
    let onSessions: () -> Void
    let onRefresh: () async -> Void
    @ViewBuilder let botCard: (CrewBot) -> BotCardView
    @ViewBuilder let workRow: (DelegatedWork) -> WorkRowView

    @Environment(AppModel.self) private var model

    private var activeBotsCount: Int {
        bots.filter { $0.currentState == "running" }.count
    }

    private var totalMissionsCount: Int {
        bots.reduce(0) { $0 + $1.assignments.count }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    HStack(alignment: .center) {
                        HStack(spacing: MiloTheme.Space.two) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 13, weight: .semibold))
                            Text("TEAMMATES")
                                .font(MiloTheme.Text.meta.weight(.semibold))
                                .tracking(1.1)
                        }
                        .foregroundStyle(MiloTheme.accent)

                        Spacer()

                        if !bots.isEmpty {
                            HStack(spacing: -8) {
                                ForEach(bots.prefix(5)) { bot in
                                    CrewBotAvatar(avatar: bot.resolvedAvatar, size: 26)
                                        .padding(2)
                                        .background(MiloTheme.background, in: Circle())
                                }
                            }
                        }
                    }

                    Text("Crew")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(MiloTheme.foreground)
                    Text("The work and bots Milo is looking after.")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)

                    HStack(spacing: MiloTheme.Space.two) {
                        if activeBotsCount > 0 {
                            Label("\(activeBotsCount) working", systemImage: "bolt.fill")
                                .foregroundStyle(MiloTheme.accent)
                            Text("·").foregroundStyle(MiloTheme.muted)
                        }
                        Text("\(bots.count) \(bots.count == 1 ? "bot" : "bots")")
                            .foregroundStyle(bots.isEmpty ? MiloTheme.muted : MiloTheme.foreground2)
                        if totalMissionsCount > 0 {
                            Text("·").foregroundStyle(MiloTheme.muted)
                            Text("\(totalMissionsCount) \(totalMissionsCount == 1 ? "mission" : "missions")")
                                .foregroundStyle(MiloTheme.muted)
                        }
                        if !work.isEmpty {
                            Text("·").foregroundStyle(MiloTheme.muted)
                            Text("\(work.count) scheduled")
                                .foregroundStyle(MiloTheme.muted)
                        }
                        Spacer()
                    }
                    .font(MiloTheme.Text.small.weight(.medium))
                    .padding(.top, MiloTheme.Space.one)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MiloTheme.Space.five)
                .miloGlassCard(radius: MiloTheme.Radius.xl)

                if let error { MiloErrorPill(text: error) }

                if loading && bots.isEmpty && work.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .padding(MiloTheme.Space.six)
                } else if bots.isEmpty && work.isEmpty {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(MiloTheme.accent)
                        Text("No bots yet")
                            .font(MiloTheme.Text.body.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                        Text("Ask Milo to delegate a task. Its work and bots will appear here.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .padding(MiloTheme.Space.five)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .miloGlassCard(radius: MiloTheme.Radius.xl)
                } else {
                    if !bots.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three + 2) {
                            Text("Bots")
                                .font(MiloTheme.Text.title)
                                .foregroundStyle(MiloTheme.foreground)

                            VStack(spacing: MiloTheme.Space.three + 2) {
                                ForEach(bots) { bot in
                                    botCard(bot)
                                }
                            }
                        }
                    }

                    if !work.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three + 2) {
                            Text("Delegated work")
                                .font(MiloTheme.Text.title)
                                .foregroundStyle(MiloTheme.foreground)

                            VStack(spacing: MiloTheme.Space.three + 2) {
                                ForEach(work) { item in
                                    workRow(item)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .miloWallpaperBackground()
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: MiloTheme.Space.one) {
                HStack(spacing: 0) {
                    SessionsButton(action: onSessions)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 46)
                ConnectionPill()
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .animation(.smooth(duration: 0.22), value: model.connectionLine)
        }
        .refreshable { await onRefresh() }
    }
}
