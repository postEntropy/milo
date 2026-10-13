import Foundation

/// One widget of a turn: what the model wrote in a `genui` block, lifted out of the
/// stream by the daemon and handed over as a tree of primitives. The catalog is the
/// server's (`src/core/genui.ts`) — a node this app does not know draws as nothing
/// rather than failing the message, which is what a build older than the catalog has
/// to do.
struct GenUi: Decodable {
    let title: String?
    let tree: GenUiNode

    /// A widget with nothing readable in it: what a frame that could not be read
    /// draws, so a broken one costs its own drawing and not the conversation.
    static let unreadable = GenUi(title: nil, tree: .unknown)
}

extension GenUi {
    private enum CodingKeys: String, CodingKey { case title, tree }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? container.decodeIfPresent(String.self, forKey: .title)) ?? nil
        tree = (try? container.decode(GenUiNode.self, forKey: .tree)) ?? .unknown
    }
}

/// The primitives a widget is made of, in the order the server lists them. Every field
/// is read tolerantly: a node whose shape does not match draws as nothing, because a
/// part that throws takes the whole transcript with it — the `ready` frame is one
/// message, and half a widget is not worth a blank chat.
enum GenUiNode: Decodable {
    indirect case box(direction: String?, gap: Int?, padding: Int?, children: [GenUiNode])
    case title(text: String, size: String?)
    case text(String)
    case list([String])
    case steps(title: String?, entries: [Step])
    case facts(title: String?, entries: [Fact])
    case table(columns: [String], rows: [[String]])
    case unknown

    struct Step: Decodable {
        let title: String
        let detail: String?
    }

    struct Fact: Decodable {
        let label: String
        let value: String
    }

    private enum CodingKeys: String, CodingKey {
        case kind, text, size, direction, gap, padding, children, title, entries, items, columns, rows
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        func read<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            (try? container.decode(T.self, forKey: key)) ?? fallback
        }
        func readText(_ key: CodingKeys) -> String? {
            (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil
        }

        switch (try? container.decode(String.self, forKey: .kind)) ?? "" {
        case "box":
            let children: [GenUiNode] = read(.children, [])
            self = .box(
                direction: readText(.direction),
                gap: read(.gap, nil as Int?),
                padding: read(.padding, nil as Int?),
                children: children
            )
        case "title":
            self = .title(text: read(.text, ""), size: readText(.size))
        case "text":
            self = .text(read(.text, ""))
        case "list":
            self = .list(read(.items, []))
        case "steps":
            self = .steps(title: readText(.title), entries: read(.entries, []))
        case "facts":
            self = .facts(title: readText(.title), entries: read(.entries, []))
        case "table":
            self = .table(columns: read(.columns, []), rows: read(.rows, []))
        default:
            // A `stat`, a control, a button, or a kind added to the catalog after this
            // build. Decoded as nothing until the pass that draws them.
            self = .unknown
        }
    }
}
