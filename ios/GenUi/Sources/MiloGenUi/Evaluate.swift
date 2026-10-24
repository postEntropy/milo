import Foundation

/**
 The value of a widget's input, by the id the model gave it. Numbers and sliders
 hold numbers, a `select` a string, a `checkbox` a flag, a `multiselect` choices,
 and a date range its two days — an id the model never declared is absent.
 */
public enum GenUiValue: Equatable, Sendable {
    case number(Double)
    case text(String)
    case flag(Bool)
    case choices([String])
    case dateRange(String, String)
}

/** The values of a widget's inputs, by input id. */
public typealias GenUiValues = [String: GenUiValue]

/**
 A widget's `stat` formula, evaluated without `eval` — the Swift reading of the
 browser's `evaluate.ts`, held to the same cases on disk so the two cannot drift.

 The grammar is the whole of it: numbers, input ids, `+ - * /` and parentheses.
 There is nothing else to express — no calls, no property access, no strings — so
 a tree can carry arithmetic and nothing more, which is the entire reason no
 sandbox is needed. A formula that does not parse, reads an id that is not a
 number, or comes out non-finite (a division by zero) is nil, and the surface
 shows a dash rather than a wrong number.
 */
public func evaluateFormula(_ formula: String, _ values: GenUiValues) -> Double? {
    guard let tokens = tokenize(formula) else { return nil }
    let cursor = Cursor(tokens)
    guard let value = expression(cursor, values), cursor.at == tokens.count else { return nil }
    return value.isFinite ? value : nil
}

/**
 A number as the widget shows it, at the decimal places asked for.

 Grouping and the decimal mark follow the machine's locale, the way `toLocaleString`
 does in the browser. The number of places is held here rather than left to the
 formatter: the browser's `minimumFractionDigits` fills the trailing zeros, and the
 platform's formatter does not always agree on how many digits to keep — so the
 value is rounded by the formatter and then padded to the places asked for.
 */
public func formatNumber(_ value: Double, decimals: Int? = nil) -> String {
    let places = max(decimals ?? (value == value.rounded() ? 0 : 2), 0)
    let formatter = NumberFormatter()
    formatter.locale = .current
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = places
    let text = formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    guard places > 0 else { return text }
    let separator = (formatter.decimalSeparator).flatMap { $0.isEmpty ? nil : $0 } ?? "."
    guard let mark = text.lastIndex(of: Character(separator)) else {
        return text + separator + String(repeating: "0", count: places)
    }
    let shown = text.distance(from: text.index(after: mark), to: text.endIndex)
    return shown >= places ? text : text + String(repeating: "0", count: places - shown)
}

/** A `text` node with its `{id}` references filled in from the current inputs. */
public func interpolate(_ text: String, _ values: GenUiValues) -> String {
    let pattern = "\\{([A-Za-z][A-Za-z0-9_]{0,31})\\}"
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
    let source = text as NSString
    let matches = regex.matches(in: text, range: NSRange(location: 0, length: source.length))
    var result = ""
    var last = 0
    for match in matches {
        let whole = source.substring(with: match.range)
        let name = source.substring(with: match.range(at: 1))
        result += source.substring(with: NSRange(location: last, length: match.range.location - last))
        result += values[name].map(shown) ?? whole
        last = match.range.location + match.range.length
    }
    result += source.substring(from: last)
    return result
}

private func shown(_ value: GenUiValue) -> String {
    switch value {
    case .number(let number): return formatNumber(number)
    case .flag(let flag): return flag ? "true" : "false"
    case .text(let text): return text
    case .choices(let choices): return choices.joined(separator: ", ")
    case .dateRange(let from, let to): return "\(from) – \(to)"
    }
}

// MARK: - The grammar

private enum Token: Equatable {
    case number(Double)
    case ident(String)
    case op(Character)
}

private final class Cursor {
    let tokens: [Token]
    var at = 0

    init(_ tokens: [Token]) {
        self.tokens = tokens
    }
}

private func tokenize(_ input: String) -> [Token]? {
    let chars = Array(input)
    var tokens: [Token] = []
    var index = 0
    while index < chars.count {
        let char = chars[index]
        if char == " " || char == "\t" {
            index += 1
            continue
        }
        if "+-*/()".contains(char) {
            tokens.append(.op(char))
            index += 1
            continue
        }
        // A number starts with a digit, the way the browser's own reader starts one:
        // `.5` is not a number here, and matches the browser by not being one.
        if isDigit(char) {
            var end = index
            while end < chars.count, isDigit(chars[end]) { end += 1 }
            if end < chars.count, chars[end] == "." {
                let after = end + 1
                if after < chars.count, isDigit(chars[after]) {
                    end = after
                    while end < chars.count, isDigit(chars[end]) { end += 1 }
                }
            }
            guard let number = Double(String(chars[index..<end])) else { return nil }
            tokens.append(.number(number))
            index = end
            continue
        }
        if char == "_" || isLetter(char) {
            var end = index
            while end < chars.count, chars[end] == "_" || isDigit(chars[end]) || isLetter(chars[end]) { end += 1 }
            tokens.append(.ident(String(chars[index..<end])))
            index = end
            continue
        }
        return nil
    }
    return tokens
}

/** `term (('+' | '-') term)*` */
private func expression(_ cursor: Cursor, _ values: GenUiValues) -> Double? {
    guard var left = term(cursor, values) else { return nil }
    while cursor.at < cursor.tokens.count {
        guard case .op(let op) = cursor.tokens[cursor.at], op == "+" || op == "-" else { break }
        cursor.at += 1
        guard let right = term(cursor, values) else { return nil }
        left = op == "+" ? left + right : left - right
    }
    return left
}

/** `factor (('*' | '/') factor)*` */
private func term(_ cursor: Cursor, _ values: GenUiValues) -> Double? {
    guard var left = factor(cursor, values) else { return nil }
    while cursor.at < cursor.tokens.count {
        guard case .op(let op) = cursor.tokens[cursor.at], op == "*" || op == "/" else { break }
        cursor.at += 1
        guard let right = factor(cursor, values) else { return nil }
        left = op == "*" ? left * right : left / right
    }
    return left
}

/** A signed number, an input id, or a parenthesised expression. */
private func factor(_ cursor: Cursor, _ values: GenUiValues) -> Double? {
    guard cursor.at < cursor.tokens.count else { return nil }
    switch cursor.tokens[cursor.at] {
    case .op("-"):
        cursor.at += 1
        guard let value = factor(cursor, values) else { return nil }
        return -value
    case .op("+"):
        cursor.at += 1
        return factor(cursor, values)
    case .op("("):
        cursor.at += 1
        guard let value = expression(cursor, values) else { return nil }
        guard cursor.at < cursor.tokens.count, cursor.tokens[cursor.at] == .op(")") else { return nil }
        cursor.at += 1
        return value
    case .number(let number):
        cursor.at += 1
        return number
    case .ident(let name):
        cursor.at += 1
        return numberValue(values[name])
    default:
        return nil
    }
}

private func numberValue(_ value: GenUiValue?) -> Double? {
    switch value {
    case .number(let number): return number.isFinite ? number : nil
    case .flag(let flag): return flag ? 1 : 0
    case .text, .choices, .dateRange, .none: return nil
    }
}

private func isDigit(_ char: Character) -> Bool {
    char >= "0" && char <= "9"
}

private func isLetter(_ char: Character) -> Bool {
    (char >= "a" && char <= "z") || (char >= "A" && char <= "Z")
}

// MARK: - The range a chart is drawn on

/** The range every series is scaled to: always including zero, and rounded out. */
public struct ChartBounds: Equatable, Sendable {
    public let min: Double
    public let max: Double

    public init(min: Double, max: Double) {
        self.min = min
        self.max = max
    }
}

/**
 The range a chart is drawn on, the Swift reading of `chart-bounds.ts`.

 A bar chart starts at zero; a line or a sparkline takes the series' own range with an
 eighth of it as air on either side, because a run rate of $380k–$455k on a zero-based
 axis is a flat line at the top. The two surfaces are held to the same cases on disk.
 */
public func chartBounds(_ series: [[Double]], zero: Bool = true) -> ChartBounds {
    let values = series.flatMap { $0 }.filter { $0.isFinite }
    guard let low = values.min(), let high = values.max() else {
        return ChartBounds(min: 0, max: 1)
    }
    if !zero {
        let span = high - low
        let pad = span == 0 ? (abs(high) > 0 ? abs(high) * 0.1 : 1) : span * 0.08
        return ChartBounds(min: low - pad, max: high + pad)
    }
    let max = high > 0 ? niceCeiling(high) : 0
    let min = low < 0 ? -niceCeiling(-low) : 0
    return max == min ? ChartBounds(min: min, max: min + 1) : ChartBounds(min: min, max: max)
}

private func niceCeiling(_ value: Double) -> Double {
    guard value > 0 else { return 1 }
    let step = pow(10, floor(log10(value)))
    let units = value / step
    let nice: Double = units <= 1 ? 1 : units <= 2 ? 2 : units <= 5 ? 5 : 10
    return nice * step
}

// MARK: - The inline marks a string may carry

/// One piece of a string the person reads, and the mark it wears.
public struct InlineRun: Equatable, Sendable {
    public enum Style: Equatable, Sendable {
        case plain, bold, italic, code
    }

    public let text: String
    public let style: Style

    public init(text: String, style: Style) {
        self.text = text
        self.style = style
    }
}

/**
 The three inline marks the teaching allows — `**bold**`, `*italic*` and `` `code` `` —
 read into runs, the Swift reading of `Inline.tsx`.

 It is a small scanner rather than Foundation's markdown reader: the browser's rule is
 the one shape both surfaces must agree on, and a mark that never closes stays the
 characters that wrote it. The view colours the runs; nothing here knows a font.
 */
public func inlineRuns(_ text: String) -> [InlineRun] {
    let chars = Array(text)
    var runs: [InlineRun] = []
    var plain = ""
    var at = 0

    func flush() {
        if !plain.isEmpty {
            runs.append(InlineRun(text: plain, style: .plain))
            plain = ""
        }
    }

    while at < chars.count {
        if at + 1 < chars.count, chars[at] == "*", chars[at + 1] == "*" {
            if let end = closing(chars, from: at + 2, mark: "*", doubled: true) {
                flush()
                runs.append(InlineRun(text: String(chars[(at + 2)..<end]), style: .bold))
                at = end + 2
                continue
            }
        }
        if chars[at] == "*" {
            if let end = closing(chars, from: at + 1, mark: "*", doubled: false) {
                flush()
                runs.append(InlineRun(text: String(chars[(at + 1)..<end]), style: .italic))
                at = end + 1
                continue
            }
        }
        if chars[at] == "`" {
            if let end = closing(chars, from: at + 1, mark: "`", doubled: false) {
                flush()
                runs.append(InlineRun(text: String(chars[(at + 1)..<end]), style: .code))
                at = end + 1
                continue
            }
        }
        plain.append(chars[at])
        at += 1
    }
    flush()
    return runs
}

/**
 Where the mark closes: the next one, as long as the run between them is not empty and
 carries no mark of its own — the same `[^*]+` / `[^`]+` the browser's pattern uses.
 */
private func closing(_ chars: [Character], from: Int, mark: Character, doubled: Bool) -> Int? {
    var at = from
    while at < chars.count {
        if chars[at] == mark {
            if doubled {
                guard at + 1 < chars.count, chars[at + 1] == mark else {
                    at += 1
                    continue
                }
            }
            return at > from ? at : nil
        }
        if mark != "`", chars[at] == "*" { return nil }
        at += 1
    }
    return nil
}
