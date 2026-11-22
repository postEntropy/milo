import SwiftUI
import UIKit

/// Authenticated shell: a persistent Chat tab, optional Hub tabs pinned by the user,
/// and the Hub tab itself.
struct MainTabView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @State private var selectedTab: AppTab = .chat
    @State private var pinnedStore = PinnedTabsStore()
    @State private var hubPath = NavigationPath()
    @State private var pinnedRoutinesPath = NavigationPath()
    @State private var settings = false

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab(value: AppTab.chat) {
                ChatView(
                    account: account,
                    isActiveTab: selectedTab == .chat,
                    settingsOpen: settings,
                    onOpenSettings: { settings = true }
                )
            } label: {
                tabIcon(systemName: "bubble.left.and.bubble.right", label: "Chat")
            }

            ForEach(pinnedStore.items) { item in
                Tab(value: AppTab.pinned(item)) {
                    pinnedTabView(for: item)
                } label: {
                    if item == .crew {
                        Image(uiImage: OutlinedTabIconCache.crewImage())
                            .accessibilityLabel(item.title)
                    } else {
                        tabIcon(systemName: item.symbol, label: item.title)
                    }
                }
            }

            Tab(value: AppTab.hub) {
                HubView(
                    account: account,
                    pinnedStore: pinnedStore,
                    path: $hubPath,
                    onOpenSettings: { settings = true },
                    onOpenChat: { selectedTab = .chat }
                )
            } label: {
                tabIcon(systemName: "square.grid.2x2", label: "Hub")
            }
        }
        .environment(\.symbolVariants, .none)
        .task { await model.start(at: account) }
        .overlay(alignment: .top) {
            if selectedTab != .chat, !settings {
                MiloNoteToast(topPadding: 52)
            }
        }
        .sheet(isPresented: $settings) {
            SettingsView(account: account) {
                selectedTab = .chat
            }
        }
        .onChange(of: pinnedStore.items) { _, items in
            if case .pinned(let active) = selectedTab, !items.contains(active) {
                selectedTab = .hub
            }
        }
        .onChange(of: model.pendingSession) { _, id in
            guard id != nil else { return }
            selectedTab = .chat
            Task { _ = await model.openPendingSession() }
        }
        .onChange(of: model.pendingRoutine) { _, _ in
            routePendingRoutine()
        }
        .onAppear {
            routePendingRoutine()
        }
    }

    private func tabIcon(systemName: String, label: String) -> some View {
        Image(uiImage: OutlinedTabIconCache.image(named: systemName))
            .accessibilityLabel(label)
    }

    private func routePendingRoutine() {
        guard let routineId = model.pendingRoutine else { return }
        model.pendingRoutine = nil
        if pinnedStore.contains(.routines) {
            pinnedRoutinesPath = NavigationPath([RoutinesView.Route.detail(routine: routineId)])
            selectedTab = .pinned(.routines)
        } else {
            var next = NavigationPath()
            next.append(HubItem.routines)
            next.append(RoutinesView.Route.detail(routine: routineId))
            hubPath = next
            selectedTab = .hub
        }
    }

    @ViewBuilder
    private func pinnedTabView(for item: HubItem) -> some View {
        switch item {
        case .routines:
            NavigationStack(path: $pinnedRoutinesPath) {
                RoutinesView(account: account, path: $pinnedRoutinesPath, embeddedInHub: false)
                    .navigationDestination(for: RoutinesView.Route.self) { route in
                        RoutinesView.destination(for: route)
                    }
            }
        case .crew:
            CrewView(
                account: account,
                onChatWithBot: { botId in
                    Task {
                        if await model.startBotSession(botId: botId) {
                            selectedTab = .chat
                        }
                    }
                }
            )
        case .taskLists:
            TaskListsView()
        case .analytics:
            AnalyticsView(account: account)
        case .folders:
            FoldersView {
                selectedTab = .chat
            }
        case .memory:
            MemoryView(embeddedInHub: false) { id in
                Task {
                    if await model.resume(id) {
                        selectedTab = .chat
                    }
                }
            }
        case .skills:
            SkillsView(embeddedInHub: false)
        }
    }
}

/// Renders an SF Symbol into a non-symbol template `UIImage` so `UITabBar` cannot
/// auto-substitute `.fill` variants when a tab is selected, and normalizes optical size
/// across glyphs of different aspect ratios.
@MainActor
private enum OutlinedTabIconCache {
    private static var cache: [String: UIImage] = [:]
    private static var crewCached: UIImage?
    private static let canvasSide: CGFloat = 26
    private static let basePointSize: CGFloat = 19
    private static let targetOpticalSize: CGFloat = 20.0

    static func crewImage() -> UIImage {
        if let crewCached { return crewCached }
        let rendered = CrewDrawerMark.tabImage(size: 25, canvasSize: canvasSide)
        crewCached = rendered
        return rendered
    }

    static func image(named systemName: String) -> UIImage {
        if let cached = cache[systemName] { return cached }
        let baseConfig = UIImage.SymbolConfiguration(pointSize: basePointSize, weight: .medium)
        guard let baseSymbol = UIImage(systemName: systemName, withConfiguration: baseConfig) else {
            return UIImage()
        }

        // Measure inked bounds so wide symbols (e.g. overlapping chat bubbles) and compact
        // symbols (e.g. 2x2 grid) share the same optical weight in the tab bar.
        let baseBounds = inkBounds(of: baseSymbol)
        let optical = sqrt(baseBounds.width * baseBounds.height)
        let adjustedPointSize: CGFloat = optical > 0
            ? min(22.0, max(16.5, basePointSize * (targetOpticalSize / optical)))
            : basePointSize
        let symbol = abs(adjustedPointSize - basePointSize) > 0.25
            ? (UIImage(systemName: systemName, withConfiguration: UIImage.SymbolConfiguration(pointSize: adjustedPointSize, weight: .medium)) ?? baseSymbol)
            : baseSymbol

        let bounds = inkBounds(of: symbol)
        let canvas = CGSize(width: max(ceil(bounds.width) + 2, canvasSide), height: canvasSide)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: canvas, format: format)
        let rendered = renderer.image { _ in
            let origin = CGPoint(
                x: canvas.width / 2 - bounds.midX,
                y: canvas.height / 2 - bounds.midY
            )
            symbol.draw(in: CGRect(origin: origin, size: symbol.size))
        }.withRenderingMode(.alwaysTemplate)
        cache[systemName] = rendered
        return rendered
    }

    /// Computes the non-transparent ink bounding box in the image's UIKit point coordinates.
    private static func inkBounds(of image: UIImage) -> CGRect {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        format.opaque = false
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(at: .zero)
        }
        guard let cg = rendered.cgImage else {
            return CGRect(origin: .zero, size: image.size)
        }
        let width = cg.width
        let height = cg.height
        guard width > 0, height > 0 else {
            return CGRect(origin: .zero, size: image.size)
        }

        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return CGRect(origin: .zero, size: image.size)
        }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))

        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        for y in 0..<height {
            for x in 0..<width {
                let alpha = pixels[(y * width + x) * 4 + 3]
                if alpha > 16 {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard maxX >= minX, maxY >= minY else {
            return CGRect(origin: .zero, size: image.size)
        }
        let scale = image.scale
        return CGRect(
            x: CGFloat(minX) / scale,
            y: CGFloat(minY) / scale,
            width: CGFloat(maxX - minX + 1) / scale,
            height: CGFloat(maxY - minY + 1) / scale
        )
    }
}
