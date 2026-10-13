import SwiftUI
import UIKit

/**
 A turn's prose, drawn as what it is. The model writes markdown and the browser
 renders it; the phone was showing the delimiters — asterisks around a word, backticks
 around a path, a code block as a wall of monospaced text, and a list, a quotation and
 a table as the literal characters that wrote them.

 Blocks first, then inline within them: a fence is a block, and the inline pass would
 otherwise leave it as a paragraph of backticks.
 */
struct Prose: View {
    let text: String
    /// The tone the prose's own words wear — the foreground by default, and the on-colour
    /// of an accent when the words sit on the person's own bubble. The decorative marks
    /// (a list's bullet, a table's headers) keep their own muted tone.
    var color: Color = MiloTheme.foreground

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                draw(block)
            }
        }
    }

    @ViewBuilder
    private func draw(_ block: Block) -> some View {
        switch block {
        case .paragraph(let paragraph):
            Text(inline(paragraph))
                .font(.body)
                .lineSpacing(MiloTheme.leading)
                .foregroundStyle(color)
                .textSelection(.enabled)
        case .heading(let level, let line):
            Text(inline(line))
                .font(level <= 2 ? .title3.weight(.semibold) : .headline)
                .lineSpacing(MiloTheme.leading)
                .foregroundStyle(color)
                .textSelection(.enabled)
        case .code(let code):
            CodeBlock(code: code)
        case .list(let items):
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                ForEach(Array(marked(items).enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                        Text(item.marker)
                            .font(MiloTheme.Text.base.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(inline(item.text))
                            .font(.body)
                            .lineSpacing(MiloTheme.leading)
                            .foregroundStyle(color)
                            .textSelection(.enabled)
                    }
                    // A nested line steps in under the one it belongs to; the marker
                    // column travels with it.
                    .padding(.leading, CGFloat(item.indent) * MiloTheme.Space.four)
                }
            }
        case .quote(let quote):
            HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                Rectangle()
                    .fill(MiloTheme.muted.opacity(0.35))
                    .frame(width: 3)
                Text(inline(quote))
                    .font(.body)
                    .lineSpacing(MiloTheme.leading)
                    .foregroundStyle(color.opacity(0.85))
                    .textSelection(.enabled)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .table(let columns, let rows):
            table(columns: columns, rows: rows)
        }
    }

    /// A table is wider than a phone, so it scrolls sideways rather than squeezing its
    /// columns into a column of their own — the shape the generated widgets use too.
    private func table(columns: [String], rows: [[String]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: MiloTheme.Space.five, verticalSpacing: MiloTheme.Space.two) {
                GridRow {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        Text(inline(column))
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(columns.enumerated()), id: \.offset) { index, _ in
                            Text(inline(index < row.count ? row[index] : ""))
                                .font(MiloTheme.Text.base)
                                .lineSpacing(MiloTheme.leading)
                                .foregroundStyle(color)
                        }
                    }
                }
            }
            .padding(.vertical, MiloTheme.Space.one)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Block {
        case paragraph(String)
        case heading(level: Int, text: String)
        case code(String)
        case list([ListItem])
        case quote(String)
        case table(columns: [String], rows: [[String]])
    }

    /// One line of a list: how deep it sits, whether it is numbered, and its words.
    private struct ListItem {
        let indent: Int
        let ordered: Bool
        let text: String
    }

    private var blocks: [Block] {
        let lines = text.components(separatedBy: "\n")
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: [String] = []
        var fenced = false

        func endParagraph() {
            let joined = paragraph.joined(separator: "\n")
            if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.paragraph(joined)) }
            paragraph = []
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]

            // A fence opens or closes a block of code; nothing inside it is read.
            if line.hasPrefix("```") {
                if fenced {
                    blocks.append(.code(code.joined(separator: "\n")))
                    code = []
                    fenced = false
                } else {
                    endParagraph()
                    fenced = true
                }
                index += 1
                continue
            }
            if fenced {
                code.append(line)
                index += 1
                continue
            }

            // A blank line ends whatever paragraph was open.
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                endParagraph()
                index += 1
                continue
            }

            // A table: a row of cells, under a separator line of dashes.
            if line.contains("|"), index + 1 < lines.count, isTableSeparator(lines[index + 1]) {
                endParagraph()
                let columns = tableCells(line)
                var rows: [[String]] = []
                index += 2
                while index < lines.count, lines[index].contains("|") {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                blocks.append(.table(columns: columns, rows: rows))
                continue
            }

            // A line the model led with `#` is a heading; the inline pass leaves the
            // markers as text, which is the one thing worse than no heading at all.
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") {
                let markers = trimmed.prefix(while: { $0 == "#" }).count
                let title = trimmed.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                if !title.isEmpty {
                    endParagraph()
                    blocks.append(.heading(level: markers, text: title))
                    index += 1
                    continue
                }
            }

            // A quotation: consecutive `>` lines, read as one.
            if trimmed.hasPrefix(">") {
                endParagraph()
                var quoted: [String] = []
                while index < lines.count {
                    let mark = lines[index].trimmingCharacters(in: .whitespaces)
                    guard mark.hasPrefix(">") else { break }
                    quoted.append(String(mark.drop(while: { $0 == ">" }).drop(while: { $0 == " " })))
                    index += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }

            // A list: read while list lines hold, at whatever depth, as one block — a
            // nested run belongs under the line it is indented beneath.
            if listItem(line) != nil {
                endParagraph()
                var items: [ListItem] = []
                while index < lines.count, let next = listItem(lines[index]) {
                    items.append(next)
                    index += 1
                }
                blocks.append(.list(items))
                continue
            }

            paragraph.append(line)
            index += 1
        }

        // An unterminated fence is what a code block looks like while it streams, so it
        // is drawn as code rather than left as prose with a stray fence in it.
        if fenced || !code.isEmpty { blocks.append(.code(code.joined(separator: "\n"))) }
        endParagraph()
        return blocks
    }

    /// A list line, or nil: how deep it sits, whether it is numbered, and its words.
    /// The leading whitespace is the depth — two spaces per level, a tab counting two.
    private func listItem(_ line: String) -> ListItem? {
        let spaces = line.prefix(while: { $0 == " " || $0 == "\t" })
            .reduce(0) { $0 + ($1 == "\t" ? 2 : 1) }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return ListItem(indent: spaces / 2, ordered: false, text: String(trimmed.dropFirst(marker.count)))
        }
        let digits = trimmed.prefix(while: { $0.isNumber })
        if !digits.isEmpty {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") { return ListItem(indent: spaces / 2, ordered: true, text: String(rest.dropFirst(2))) }
        }
        return nil
    }

    /// The marker each line wears, numbered within its own level so a nested list counts
    /// 1, 2, 3 again under its parent rather than running on from it. A level left behind
    /// has its count forgotten.
    private func marked(_ items: [ListItem]) -> [(marker: String, text: String, indent: Int)] {
        var counters: [Int] = []
        return items.map { item in
            let level = max(0, item.indent)
            if counters.count > level + 1 { counters.removeLast(counters.count - level - 1) }
            while counters.count <= level { counters.append(0) }
            counters[level] += 1
            return (item.ordered ? "\(counters[level])." : "•", item.text, level)
        }
    }

    private func isTableSeparator(_ line: String) -> Bool {
        let cells = tableCells(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            !cell.isEmpty && cell.contains("-") && cell.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

    private func tableCells(_ line: String) -> [String] {
        var cells = line.trimmingCharacters(in: .whitespaces).components(separatedBy: "|")
        if cells.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeFirst() }
        if cells.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeLast() }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Emphasis, code spans and links — what the platform's own markdown understands,
    /// with the line breaks kept as written.
    private func inline(_ line: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: line, options: options)) ?? AttributedString(line)
    }
}

/// A fenced block: monospaced on its own surface, scrolling sideways rather than
/// wrapping, because a wrapped line of code stops being the line that was written.
/// No language label — the browser does not draw one, and the two surfaces say the
/// same things about the same data.
///
/// The browser draws no copy control here, because a pointer can drag a selection across
/// its box. On a phone the box is what the finger drags to scroll, so copying is a control
/// of its own — in the corner of the box, on the platform's glass, over the code.
struct CodeBlock: View {
    let code: String
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(MiloTheme.Text.mono)
                .foregroundStyle(MiloTheme.foreground)
                .textSelection(.enabled)
                .padding(.horizontal, MiloTheme.Space.three)
                .padding(.vertical, MiloTheme.Space.three)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .overlay(alignment: .topTrailing) { copyControl }
    }

    private var copyControl: some View {
        Button {
            UIPasteboard.general.string = code
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(MiloTheme.muted)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(copied ? "Copied" : "Copy the code")
        .padding(MiloTheme.Space.two)
    }
}
