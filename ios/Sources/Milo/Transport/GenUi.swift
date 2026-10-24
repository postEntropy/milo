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
    indirect case box(direction: String?, gap: Int?, padding: Int?, align: String?, wrap: Bool, children: [GenUiNode])
    indirect case section(title: String, description: String?, children: [GenUiNode])
    case timeline([TimelineEntry])
    case choiceCards(ChoiceCards)
    case textInput(TextInput)
    indirect case form(children: [GenUiNode], submit: FormSubmit)
    case title(text: String, size: String?)
    case text(String)
    case divider
    case callout(Callout)
    case badge(Badge)
    case chart(Chart)
    case stat(Stat)
    case progress(Progress)
    case table(columns: [String], rows: [[String]], align: [String])
    case list([String])
    case steps(title: String?, entries: [Step])
    case facts(title: String?, entries: [Fact])
    case code(Code)
    /// A control the person moves. Each carries the values a `stat` and a `text`
    /// read, so the surface holds them by `id`.
    case slider(Slider)
    case number(NumberField)
    case checkbox(Checkbox)
    case select(Select)
    case multiselect(MultiSelect)
    case date(DateField)
    case dateRange(DateRange)
    case tabs(Tabs)
    case accordion(Accordion)
    /// The only way a widget speaks back: pressing it sends `send` as a new turn.
    case button(Button)
    case unknown

    struct Step: Decodable {
        let title: String
        let detail: String?
        let when: String?
    }

    struct TimelineEntry: Decodable { let when: String; let title: String; let detail: String?; let tone: String? }
    struct ChoiceOption: Decodable { let value: String; let title: String; let detail: String? }
    struct ChoiceCards { let id: String; let label: String; let options: [ChoiceOption]; let value: String? }
    struct TextInput { let id: String; let label: String; let value: String?; let placeholder: String?; let multiline: Bool; let required: Bool; let maxLength: Int? }
    struct FormSubmit: Decodable { let label: String; let send: String }

    struct Fact: Decodable {
        let label: String
        let value: String
        let tone: String?
    }

    struct Callout {
        let tone: String?
        let title: String?
        let text: String
    }

    struct Badge {
        let label: String
        let tone: String?
    }

    struct ChartSeries: Decodable {
        let label: String?
        let values: [Double]
    }

    struct Chart {
        let type: String
        let labels: [String]
        let series: [ChartSeries]
        let height: String?
        let prefix: String?
        let suffix: String?
        let decimals: Int?
    }

    struct Stat {
        let label: String
        let formula: String
        let prefix: String?
        let suffix: String?
        let decimals: Int?
        let delta: String?
        let deltaSuffix: String?
        let deltaTone: String?
        let trend: [Double]?
    }

    struct Progress {
        let label: String?
        let formula: String
        let max: Double?
        let suffix: String?
        let tone: String?
    }

    struct Code {
        let language: String?
        let text: String
    }

    struct MultiSelect {
        let id: String
        let label: String
        let options: [String]
        let values: [String]
    }

    struct DateField {
        let id: String
        let label: String
        let value: String
        let min: String?
        let max: String?
    }

    struct DateRange {
        let id: String
        let label: String
        let from: String
        let to: String
        let min: String?
        let max: String?
    }

    struct Tab: Decodable {
        let label: String
        let children: [GenUiNode]
    }

    struct Tabs {
        let tabs: [Tab]
    }

    struct AccordionItem: Decodable {
        let title: String
        let open: Bool?
        let children: [GenUiNode]
    }

    struct Accordion {
        let items: [AccordionItem]
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
        let tone: String?
    }

    private enum CodingKeys: String, CodingKey {
        case kind, text, size, direction, gap, padding, align, wrap, children, title, entries, items, columns, rows
        case label, formula, prefix, suffix, decimals, id, min, max, step, value, options, send
        case type, labels, series, height, tone, delta, deltaSuffix, deltaTone, trend, language, values, from, to, tabs, open, when
        case description, placeholder, multiline, required, maxLength, submit
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
                align: readText(.align),
                wrap: read(.wrap, false),
                children: children
            )
        case "section":
            guard let title = readText(.title) else { self = .unknown; return }
            self = .section(title: title, description: readText(.description), children: read(.children, []))
        case "timeline":
            let entries: [TimelineEntry] = read(.entries, [])
            guard !entries.isEmpty else { self = .unknown; return }
            self = .timeline(entries)
        case "choice-cards":
            guard let id = readText(.id), let label = readText(.label) else { self = .unknown; return }
            let options: [ChoiceOption] = read(.options, [])
            let value = readText(.value)
            guard options.count >= 2, Set(options.map(\.value)).count == options.count,
                  value.map({ selected in options.contains(where: { $0.value == selected }) }) ?? true
            else { self = .unknown; return }
            self = .choiceCards(ChoiceCards(id: id, label: label, options: options, value: value))
        case "text-input":
            guard let id = readText(.id), let label = readText(.label) else { self = .unknown; return }
            self = .textInput(TextInput(id: id, label: label, value: readText(.value), placeholder: readText(.placeholder), multiline: read(.multiline, false), required: read(.required, false), maxLength: read(.maxLength, nil as Int?)))
        case "form":
            guard let submit = try? container.decode(FormSubmit.self, forKey: .submit) else { self = .unknown; return }
            let children: [GenUiNode] = read(.children, [])
            guard !children.isEmpty else { self = .unknown; return }
            self = .form(children: children, submit: submit)
        case "title":
            self = .title(text: read(.text, ""), size: readText(.size))
        case "text":
            self = .text(read(.text, ""))
        case "divider":
            self = .divider
        case "callout":
            guard let text = readText(.text) else {
                self = .unknown
                return
            }
            self = .callout(Callout(tone: readText(.tone), title: readText(.title), text: text))
        case "badge":
            guard let label = readText(.label) else {
                self = .unknown
                return
            }
            self = .badge(Badge(label: label, tone: readText(.tone)))
        case "chart":
            let labels: [String] = read(.labels, [])
            let series: [ChartSeries] = read(.series, [])
            // A point is a label and a value. A series that disagrees with the labels is
            // a chart this build cannot draw honestly, so it is dropped rather than
            // drawn with a point missing.
            guard let type = readText(.type), !labels.isEmpty, !series.isEmpty,
                  series.allSatisfy({ $0.values.count == labels.count })
            else {
                self = .unknown
                return
            }
            self = .chart(
                Chart(
                    type: type,
                    labels: labels,
                    series: series,
                    height: readText(.height),
                    prefix: readText(.prefix),
                    suffix: readText(.suffix),
                    decimals: read(.decimals, nil as Int?)
                )
            )
        case "list":
            self = .list(read(.items, []))
        case "steps":
            self = .steps(title: readText(.title), entries: read(.entries, []))
        case "facts":
            self = .facts(title: readText(.title), entries: read(.entries, []))
        case "code":
            guard let text = readText(.text) else {
                self = .unknown
                return
            }
            self = .code(Code(language: readText(.language), text: text))
        case "table":
            self = .table(columns: read(.columns, []), rows: read(.rows, []), align: read(.align, []))
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
                    decimals: read(.decimals, nil as Int?),
                    delta: readText(.delta),
                    deltaSuffix: readText(.deltaSuffix),
                    deltaTone: readText(.deltaTone),
                    trend: read(.trend, nil as [Double]?)
                )
            )
        case "progress":
            guard let formula = readText(.formula) else {
                self = .unknown
                return
            }
            self = .progress(
                Progress(
                    label: readText(.label),
                    formula: formula,
                    max: read(.max, nil as Double?),
                    suffix: readText(.suffix),
                    tone: readText(.tone)
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
        case "multiselect":
            guard let id = readText(.id), let label = readText(.label) else {
                self = .unknown
                return
            }
            let options: [String] = read(.options, [])
            let values: [String] = read(.values, [])
            guard !options.isEmpty, Set(options).count == options.count,
                  Set(values).count == values.count, values.allSatisfy(options.contains)
            else {
                self = .unknown
                return
            }
            self = .multiselect(
                MultiSelect(id: id, label: label, options: options, values: values)
            )
        case "date":
            guard let id = readText(.id), let label = readText(.label),
                  let value = readText(.value), isoDay(value)
            else {
                self = .unknown
                return
            }
            let min = readText(.min)
            let max = readText(.max)
            let boundsOrdered: Bool
            if let min, let max { boundsOrdered = min <= max } else { boundsOrdered = true }
            guard min.map(isoDay) ?? true, max.map(isoDay) ?? true,
                  min.map({ $0 <= value }) ?? true, max.map({ value <= $0 }) ?? true,
                  boundsOrdered
            else {
                self = .unknown
                return
            }
            self = .date(
                DateField(id: id, label: label, value: value, min: min, max: max)
            )
        case "daterange":
            guard let id = readText(.id), let label = readText(.label),
                  let from = readText(.from), let to = readText(.to), isoDay(from), isoDay(to)
            else {
                self = .unknown
                return
            }
            let min = readText(.min)
            let max = readText(.max)
            let boundsOrdered: Bool
            if let min, let max { boundsOrdered = min <= max } else { boundsOrdered = true }
            guard min.map(isoDay) ?? true, max.map(isoDay) ?? true,
                  from <= to, min.map({ $0 <= from }) ?? true,
                  max.map({ to <= $0 }) ?? true,
                  boundsOrdered
            else {
                self = .unknown
                return
            }
            self = .dateRange(
                DateRange(id: id, label: label, from: from, to: to, min: min, max: max)
            )
        case "tabs":
            let tabs: [Tab] = read(.tabs, [])
            guard tabs.count >= 2, tabs.allSatisfy({ !$0.children.isEmpty }) else {
                self = .unknown
                return
            }
            self = .tabs(Tabs(tabs: tabs))
        case "accordion":
            let items: [AccordionItem] = read(.items, [])
            guard !items.isEmpty, items.allSatisfy({ !$0.children.isEmpty }) else {
                self = .unknown
                return
            }
            self = .accordion(Accordion(items: items))
        case "button":
            guard let label = readText(.label), let send = readText(.send) else {
                self = .unknown
                return
            }
            self = .button(Button(label: label, send: send, tone: readText(.tone)))
        default:
            // A kind added to the catalog after this build.
            self = .unknown
        }
    }
}

/// Whether a string is a day written `YYYY-MM-DD`, the only shape a date node takes.
/// A build older than the shape does not have to guess at it.
private func isoDay(_ text: String) -> Bool {
    let parts = text.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2 else { return false }
    guard parts.allSatisfy({ part in part.allSatisfy { $0 >= "0" && $0 <= "9" } }),
          let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]), year > 0
    else { return false }
    var calendar = Calendar(identifier: .gregorian)
    guard let utc = TimeZone(secondsFromGMT: 0) else { return false }
    calendar.timeZone = utc
    let components = DateComponents(year: year, month: month, day: day)
    guard let date = calendar.date(from: components) else { return false }
    let roundTrip = calendar.dateComponents([.year, .month, .day], from: date)
    return roundTrip.year == year && roundTrip.month == month && roundTrip.day == day
}
