import SwiftUI

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

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
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
                .foregroundStyle(MiloTheme.foreground)
                .textSelection(.enabled)
        case .heading(let level, let line):
            Text(inline(line))
                .font(level <= 2 ? .title3.weight(.semibold) : .headline)
                .foregroundStyle(MiloTheme.foreground)
                .textSelection(.enabled)
        case .code(let code):
            CodeBlock(code: code)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .font(MiloTheme.Text.base.monospacedDigit())
                            .foregroundStyle(MiloTheme.muted)
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(inline(item))
                            .font(.body)
                            .foregroundStyle(MiloTheme.foreground)
                            .textSelection(.enabled)
                    }
                }
            }
        case .quote(let quote):
            HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                Rectangle()
                    .fill(MiloTheme.muted.opacity(0.35))
                    .frame(width: 3)
                Text(inline(quote))
                    .font(.body)
                    .foregroundStyle(MiloTheme.foreground2)
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
                                .foregroundStyle(MiloTheme.foreground)
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
        case list(items: [String], ordered: Bool)
        case quote(String)
        case table(columns: [String], rows: [[String]])
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

            // A list: bullet or numbered, read while the kind holds.
            if let item = listItem(line) {
                endParagraph()
                var items: [String] = []
                while index < lines.count, let next = listItem(lines[index]), next.ordered == item.ordered {
                    items.append(next.text)
                    index += 1
                }
                blocks.append(.list(items: items, ordered: item.ordered))
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

    private func listItem(_ line: String) -> (ordered: Bool, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return (false, String(trimmed.dropFirst(marker.count)))
        }
        let digits = trimmed.prefix(while: { $0.isNumber })
        if !digits.isEmpty {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") { return (true, String(rest.dropFirst(2))) }
        }
        return nil
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
struct CodeBlock: View {
    let code: String

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
    }
}
