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
    case stat(Stat)
    /// A control the person moves. The four carry the values a `stat` and a `text`
    /// read, so the surface holds them by `id`.
    case slider(Slider)
    case number(NumberField)
    case checkbox(Checkbox)
    case select(Select)
    /// The only way a widget speaks back: pressing it sends `send` as a new turn.
    case button(Button)
    case unknown

    struct Step: Decodable {
        let title: String
        let detail: String?
    }

    struct Fact: Decodable {
        let label: String
        let value: String
    }

    struct Stat {
        let label: String
        let formula: String
        let prefix: String?
        let suffix: String?
        let decimals: Int?
    }

    struct Slider {
        let id: String
        let label: String
        let min: Double
        let max: Double
        let step: Double?
        let value: Double
        let prefix: String?
        let suffix: String?
    }

    struct NumberField {
        let id: String
        let label: String
        let value: Double
        let min: Double?
        let max: Double?
        let prefix: String?
        let suffix: String?
    }

    struct Checkbox {
        let id: String
        let label: String
        let value: Bool?
    }

    struct Select {
        let id: String
        let label: String
        let options: [String]
        let value: String
    }

    struct Button {
        let label: String
        let send: String
    }

    private enum CodingKeys: String, CodingKey {
        case kind, text, size, direction, gap, padding, children, title, entries, items, columns, rows
        case label, formula, prefix, suffix, decimals, id, min, max, step, value, options, send
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
        case "stat":
            // A `stat` without its label or its formula has nothing to show; the same
            // holds for a control with no `id` to key its value by.
            guard let label = readText(.label), let formula = readText(.formula) else {
                self = .unknown
                return
            }
            self = .stat(
                Stat(
                    label: label,
                    formula: formula,
                    prefix: readText(.prefix),
                    suffix: readText(.suffix),
                    decimals: read(.decimals, nil as Int?)
                )
            )
        case "slider":
            guard let id = readText(.id), let label = readText(.label),
                  let min = read(.min, nil as Double?), let max = read(.max, nil as Double?),
                  let value = read(.value, nil as Double?)
            else {
                self = .unknown
                return
            }
            self = .slider(
                Slider(
                    id: id,
                    label: label,
                    min: min,
                    max: max,
                    step: read(.step, nil as Double?),
                    value: value,
                    prefix: readText(.prefix),
                    suffix: readText(.suffix)
                )
            )
        case "number":
            guard let id = readText(.id), let label = readText(.label),
                  let value = read(.value, nil as Double?)
            else {
                self = .unknown
                return
            }
            self = .number(
                NumberField(
                    id: id,
                    label: label,
                    value: value,
                    min: read(.min, nil as Double?),
                    max: read(.max, nil as Double?),
                    prefix: readText(.prefix),
                    suffix: readText(.suffix)
                )
            )
        case "checkbox":
            guard let id = readText(.id), let label = readText(.label) else {
                self = .unknown
                return
            }
            self = .checkbox(Checkbox(id: id, label: label, value: read(.value, nil as Bool?)))
        case "select":
            guard let id = readText(.id), let label = readText(.label) else {
                self = .unknown
                return
            }
            self = .select(
                Select(id: id, label: label, options: read(.options, []), value: read(.value, ""))
            )
        case "button":
            guard let label = readText(.label), let send = readText(.send) else {
                self = .unknown
                return
            }
            self = .button(Button(label: label, send: send))
        default:
            // A kind added to the catalog after this build.
            self = .unknown
        }
    }
}
