/**
 The marks a project can wear, as this screen draws them.

 The catalog is the daemon's — the same ids the browser knows — and only the drawing is this
 platform's: an SF Symbol here, one of the browser's own there. One entry per line, so a
 test can hold the ids and words against `src/core/project-icons.ts`; if they drift, a
 project would wear one thing on the phone and another in the browser.
 */
enum ProjectMark {
    /// What a project wears until another mark is chosen.
    static let neutral = "folder"

    struct Choice: Identifiable {
        let id: String
        let label: String
        let symbol: String
    }

    static let choices: [Choice] = [
        .init(id: "folder", label: "Folder", symbol: "folder"),
        .init(id: "code", label: "Code", symbol: "chevron.left.forwardslash.chevron.right"),
        .init(id: "terminal", label: "Terminal", symbol: "terminal"),
        .init(id: "branch", label: "Branch", symbol: "arrow.triangle.branch"),
        .init(id: "notes", label: "Notes", symbol: "doc.text"),
        .init(id: "tasks", label: "Tasks", symbol: "checklist"),
        .init(id: "design", label: "Design", symbol: "paintpalette"),
        .init(id: "camera", label: "Camera", symbol: "camera"),
        .init(id: "music", label: "Music", symbol: "music.note"),
        .init(id: "video", label: "Video", symbol: "video"),
        .init(id: "book", label: "Book", symbol: "book"),
        .init(id: "game", label: "Games", symbol: "gamecontroller"),
        .init(id: "ideas", label: "Ideas", symbol: "sparkles"),
        .init(id: "science", label: "Science", symbol: "flask"),
        .init(id: "tools", label: "Tools", symbol: "wrench.and.screwdriver"),
        .init(id: "rocket", label: "Launch", symbol: "rocket"),
        .init(id: "chart", label: "Analytics", symbol: "chart.bar"),
        .init(id: "map", label: "Map", symbol: "map"),
        .init(id: "home", label: "Home", symbol: "house"),
        .init(id: "garden", label: "Garden", symbol: "leaf"),
        .init(id: "food", label: "Food", symbol: "fork.knife"),
        .init(id: "coffee", label: "Coffee", symbol: "cup.and.saucer"),
        .init(id: "health", label: "Health", symbol: "heart"),
        .init(id: "fitness", label: "Fitness", symbol: "dumbbell"),
        .init(id: "pets", label: "Pets", symbol: "pawprint"),
        .init(id: "travel", label: "Travel", symbol: "airplane"),
        .init(id: "explore", label: "Explore", symbol: "safari"),
        .init(id: "web", label: "Web", symbol: "globe"),
        .init(id: "mail", label: "Mail", symbol: "envelope"),
        .init(id: "security", label: "Security", symbol: "shield"),
        .init(id: "link", label: "Links", symbol: "link"),
        .init(id: "archive", label: "Archive", symbol: "archivebox"),
        .init(id: "shop", label: "Shop", symbol: "cart"),
        .init(id: "money", label: "Money", symbol: "dollarsign.circle"),
        .init(id: "business", label: "Business", symbol: "building.2"),
        .init(id: "server", label: "Server", symbol: "server.rack"),
        .init(id: "data", label: "Data", symbol: "cylinder.split.1x2"),
        .init(id: "cpu", label: "Hardware", symbol: "cpu"),
        .init(id: "cloud", label: "Cloud", symbol: "cloud"),
        .init(id: "run", label: "Run", symbol: "play"),
    ]

    /// The symbol a project's mark draws, with the neutral one for none or an unknown id.
    static func symbol(_ icon: String?) -> String {
        choices.first { $0.id == icon }?.symbol ?? neutral
    }

    /// What a mark is called, for the picker's own label.
    static func label(_ icon: String?) -> String {
        choices.first { $0.id == icon }?.label ?? "Folder"
    }
}
