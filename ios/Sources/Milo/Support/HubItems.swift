import Observation
import SwiftUI

/// Every workspace destination offered in the Hub and optionally pinned to the tab bar.
enum HubItem: String, CaseIterable, Codable, Hashable, Identifiable {
    case routines
    case crew
    case taskLists
    case analytics
    case folders
    case memory
    case skills

    var id: String { rawValue }

    var title: String {
        switch self {
        case .routines: "Routines"
        case .crew: "Crew"
        case .taskLists: "Task lists"
        case .analytics: "Analytics"
        case .folders: "Folders"
        case .memory: "Memory"
        case .skills: "Skills"
        }
    }

    var symbol: String {
        switch self {
        case .routines: "clock"
        case .crew: "person.2"
        case .taskLists: "checklist"
        case .analytics: "chart.bar"
        case .folders: "folder"
        case .memory: "cylinder"
        case .skills: "sparkles"
        }
    }

    var tint: Color {
        switch self {
        case .routines: MiloPaletteId.violet.preset.accentColor
        case .crew: MiloPaletteId.tangerine.preset.accentColor
        case .taskLists: MiloPaletteId.mint.preset.accentColor
        case .analytics: MiloPaletteId.lagoon.preset.accentColor
        case .folders: MiloPaletteId.apricot.preset.accentColor
        case .memory: MiloPaletteId.rose.preset.accentColor
        case .skills: MiloPaletteId.lime.preset.accentColor
        }
    }
}

/// Top-level tabs: Chat and Hub are fixed; up to three Hub items can sit between them.
enum AppTab: Hashable {
    case chat
    case pinned(HubItem)
    case hub
}

/// Persists the user's pinned Hub tabs in pin order.
@MainActor
@Observable
final class PinnedTabsStore {
    static let maxPinned = 3
    private static let storageKey = "milo.pinnedHubTabs"

    private(set) var items: [HubItem]

    init() {
        let raw = UserDefaults.standard.stringArray(forKey: Self.storageKey) ?? []
        var seen: Set<HubItem> = []
        var loaded: [HubItem] = []
        for entry in raw {
            guard let item = HubItem(rawValue: entry), !seen.contains(item) else { continue }
            seen.insert(item)
            loaded.append(item)
            if loaded.count == Self.maxPinned { break }
        }
        self.items = loaded
    }

    var canPinMore: Bool { items.count < Self.maxPinned }

    func contains(_ item: HubItem) -> Bool {
        items.contains(item)
    }

    func pin(_ item: HubItem) {
        guard !contains(item), canPinMore else { return }
        items.append(item)
        save()
    }

    func unpin(_ item: HubItem) {
        items.removeAll { $0 == item }
        save()
    }

    func replace(_ existing: HubItem, with next: HubItem) {
        guard !contains(next), let index = items.firstIndex(of: existing) else { return }
        items[index] = next
        save()
    }

    func canMoveLeft(_ item: HubItem) -> Bool {
        guard let index = items.firstIndex(of: item) else { return false }
        return index > 0
    }

    func canMoveRight(_ item: HubItem) -> Bool {
        guard let index = items.firstIndex(of: item) else { return false }
        return index < items.count - 1
    }

    func moveLeft(_ item: HubItem) {
        guard let index = items.firstIndex(of: item), index > 0 else { return }
        items.swapAt(index, index - 1)
        save()
    }

    func moveRight(_ item: HubItem) {
        guard let index = items.firstIndex(of: item), index < items.count - 1 else { return }
        items.swapAt(index, index + 1)
        save()
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        items.move(fromOffsets: source, toOffset: destination)
        save()
    }

    private func save() {
        UserDefaults.standard.set(items.map(\.rawValue), forKey: Self.storageKey)
    }
}
