import Foundation

/**
 The value of a widget's input, by the id the model gave it. A `number` and a
 `slider` hold a number, a `select` a string, a `checkbox` a flag — and an id the
 model referenced but never declared is simply absent.
 */
public enum GenUiValue: Equatable, Sendable {
    case number(Double)
    case text(String)
    case flag(Bool)
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
    case .text, .none: return nil
    }
}

private func isDigit(_ char: Character) -> Bool {
    char >= "0" && char <= "9"
}

private func isLetter(_ char: Character) -> Bool {
    (char >= "a" && char <= "z") || (char >= "A" && char <= "Z")
}
