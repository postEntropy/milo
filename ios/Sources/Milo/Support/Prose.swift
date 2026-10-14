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
    /// Whether this text is still arriving from the model. New glyphs fade into place;
    /// settled prose keeps selection and the quote action.
    var isStreaming = false
    /// What to do with words picked out of this prose, or nil where they cannot be quoted.
    /// Where it is set every block of words is drawn by a text view that can raise the
    /// offer; where it is not, by `Text` — the branch the person's own bubble keeps.
    var onQuote: ((String) -> Void)? = nil

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
            words(inline(paragraph), font: .body, face: bodyFace, tone: color)
        case .heading(let level, let line):
            words(
                inline(line),
                font: level <= 2 ? .title3.weight(.semibold) : .headline,
                face: level <= 2 ? titleFace : headlineFace,
                tone: color
            )
        case .code(let code):
            CodeBlock(code: code)
        case .list(let items):
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                ForEach(Array(marked(items).enumerated()), id: \.offset) { _, item in
                    // Aligned by the tops where the words are the platform's own text view,
                    // and by their first baselines where they are `Text` — the two line the
                    // mark up with the first line in their own way.
                    HStack(
                        alignment: onQuote == nil ? .firstTextBaseline : .top,
                        spacing: MiloTheme.Space.two
                    ) {
                        listMark(item)
                        words(inline(item.text), font: .body, face: bodyFace, tone: color)
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
                words(inline(quote), font: .body, face: bodyFace, tone: color.opacity(0.85))
            }
            .fixedSize(horizontal: false, vertical: true)
        case .table(let columns, let rows):
            table(columns: columns, rows: rows)
        case .rule:
            rule
        case .image(let alt, let url):
            picture(alt: alt, url: url)
        }
    }

    /// A hairline across the column — the one divider prose is allowed, because the model
    /// asked for a break.
    private var rule: some View {
        Rectangle()
            .fill(MiloTheme.borderSoft)
            .frame(height: 1)
            .frame(maxWidth: .infinity)
            .padding(.vertical, MiloTheme.Space.two)
    }

    /// A picture in the reply, drawn where it sits. It loads from the URL the text carries,
    /// so it appears as it is read; one that will not load says so rather than leaving an
    /// empty box.
    private func picture(alt: String, url: String) -> some View {
        AsyncImage(url: URL(string: url)) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFit()
            case .empty:
                RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                    .fill(MiloTheme.surface)
                    .frame(height: 160)
            case .failure:
                Text(alt.isEmpty ? "The image could not be shown." : alt)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
            @unknown default:
                EmptyView()
            }
        }
        .frame(maxWidth: 280, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .accessibilityLabel(alt.isEmpty ? "Image" : alt)
    }

    /// A table is wider than a phone, so it scrolls sideways rather than squeezing its
    /// columns into a column of their own — the shape the generated widgets use too.
    private func table(columns: [String], rows: [[String]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: MiloTheme.Space.five, verticalSpacing: MiloTheme.Space.two) {
                GridRow {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        words(
                            inline(column),
                            font: MiloTheme.Text.small.weight(.semibold),
                            face: smallStrongFace,
                            tone: MiloTheme.muted
                        )
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(columns.enumerated()), id: \.offset) { index, _ in
                            words(
                                inline(index < row.count ? row[index] : ""),
                                font: MiloTheme.Text.base,
                                face: baseFace,
                                tone: color
                            )
                        }
                    }
                }
            }
            .padding(.vertical, MiloTheme.Space.one)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .marksScrollBox()
    }

    /// A run of words, drawn the one way where this prose can be quoted and the other way
    /// where it cannot. `Prose` walks the same parsed blocks either way; what changes is
    /// the surface the words are painted on, never the words themselves.
    @ViewBuilder
    private func words(_ attributed: AttributedString, font: Font, face: UIFont, tone: Color) -> some View {
        if isStreaming {
            StreamingText(attributed: attributed, font: font, tone: tone)
        } else if let onQuote {
            SelectableText(attributed: attributed, face: face, tone: UIColor(tone), onQuote: onQuote)
        } else {
            Text(attributed)
                .font(font)
                .lineSpacing(MiloTheme.leading)
                .foregroundStyle(tone)
                .textSelection(.enabled)
        }
    }

    /// The mark a list line wears — a box on a task line, its bullet or number otherwise —
    /// in a column of its own, outside the words. The browser draws its own bullets outside
    /// the text too, so a quotation carries the line and not the mark.
    @ViewBuilder
    private func listMark(_ item: (marker: String, text: String, indent: Int, checked: Bool?)) -> some View {
        Group {
            if let checked = item.checked {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 14))
                    .foregroundStyle(checked ? MiloTheme.muted : MiloTheme.foreground2)
            } else {
                Text(item.marker)
                    .font(MiloTheme.Text.base.monospacedDigit())
                    .foregroundStyle(MiloTheme.muted)
            }
        }
        .frame(minWidth: 14, alignment: .trailing)
        .padding(.top, markerDrop)
    }

    /// The platform's own faces, the ones the role ladder in `Theme.swift` names: a text
    /// view takes the font where `Text` takes the role. Read at the size the phone is set
    /// to now, so a change in text size moves both paths together.
    private var bodyFace: UIFont { UIFont.preferredFont(forTextStyle: .body) }
    private var baseFace: UIFont { UIFont.preferredFont(forTextStyle: .subheadline) }
    private var headlineFace: UIFont { UIFont.preferredFont(forTextStyle: .headline) }
    private var titleFace: UIFont { Self.weighed(.title3, .semibold) }
    private var smallStrongFace: UIFont { Self.weighed(.caption1, .semibold) }

    /// A role's own size with the weight `UIFont.TextStyle` does not carry — the two
    /// headings and the table's header, which the ladder sets semibold.
    private static func weighed(_ style: UIFont.TextStyle, _ weight: UIFont.Weight) -> UIFont {
        UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: style).pointSize, weight: weight)
    }

    /// How far the mark drops onto the first line of the words beside it: the difference
    /// between the two faces' ascents, since a row of words drawn by the platform's own
    /// text view is aligned by its top. Nothing on the `Text` path, where the mark and the
    /// words line up by their baselines instead.
    private var markerDrop: CGFloat {
        guard onQuote != nil else { return 0 }
        return bodyFace.ascender - baseFace.ascender
    }

    private enum Block {
        case paragraph(String)
        case heading(level: Int, text: String)
        case code(String)
        case list([ListItem])
        case quote(String)
        case table(columns: [String], rows: [[String]])
        /// A horizontal rule: three or more of one mark, alone on a line.
        case rule
        /// A picture on a line of its own.
        case image(alt: String, url: String)
    }

    /// One line of a list: how deep it sits, whether it is numbered, and its words — and,
    /// for a task line, the box at its head.
    private struct ListItem {
        let indent: Int
        let ordered: Bool
        let text: String
        /// A task-list box: `true` for `[x]`, `false` for `[ ]`, nil for an ordinary item.
        var checked: Bool? = nil
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

            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // A horizontal rule, and a picture alone on its line — both read before the
            // heading and the list, whose checks a run of `-` or `*` would otherwise
            // swallow into a paragraph of its own characters.
            if isRule(trimmed) {
                endParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }
            if let picture = imageLine(trimmed) {
                endParagraph()
                blocks.append(.image(alt: picture.alt, url: picture.url))
                index += 1
                continue
            }

            // A line the model led with `#` is a heading; the inline pass leaves the
            // markers as text, which is the one thing worse than no heading at all.
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
            let content = String(trimmed.dropFirst(marker.count))
            let task = taskMark(content)
            return ListItem(indent: spaces / 2, ordered: false, text: task?.text ?? content, checked: task?.checked)
        }
        let digits = trimmed.prefix(while: { $0.isNumber })
        if !digits.isEmpty {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") { return ListItem(indent: spaces / 2, ordered: true, text: String(rest.dropFirst(2))) }
        }
        return nil
    }

    /// A GFM task box at the head of a list item's words: `[ ]` open, `[x]` done. Nil for
    /// an ordinary item, so a bullet keeps its bullet.
    private func taskMark(_ text: String) -> (checked: Bool, text: String)? {
        guard let mark = ["[x] ", "[X] ", "[ ] "].first(where: { text.hasPrefix($0) }) else { return nil }
        return (mark != "[ ] ", String(text.dropFirst(mark.count)))
    }

    /// The marker each line wears, numbered within its own level so a nested list counts
    /// 1, 2, 3 again under its parent rather than running on from it. A level left behind
    /// has its count forgotten.
    private func marked(_ items: [ListItem]) -> [(marker: String, text: String, indent: Int, checked: Bool?)] {
        var counters: [Int] = []
        return items.map { item in
            let level = max(0, item.indent)
            if counters.count > level + 1 { counters.removeLast(counters.count - level - 1) }
            while counters.count <= level { counters.append(0) }
            counters[level] += 1
            return (item.ordered ? "\(counters[level])." : "•", item.text, level, item.checked)
        }
    }

    /// A horizontal rule: three or more of one mark (`-`, `*` or `_`) and nothing else,
    /// the spaces between them allowed as CommonMark allows them.
    private func isRule(_ line: String) -> Bool {
        let marks = line.filter { $0 != " " }
        guard marks.count >= 3 else { return false }
        return marks.allSatisfy { $0 == "-" } || marks.allSatisfy { $0 == "*" } || marks.allSatisfy { $0 == "_" }
    }

    /// A line that is one picture and nothing else: `![alt](url)`.
    private func imageLine(_ line: String) -> (alt: String, url: String)? {
        guard line.hasPrefix("!["), let mid = line.range(of: "]("), line.hasSuffix(")") else { return nil }
        let alt = String(line[line.index(line.startIndex, offsetBy: 2)..<mid.lowerBound])
        let url = String(line[mid.upperBound..<line.index(before: line.endIndex)])
        guard !url.isEmpty, URL(string: url) != nil else { return nil }
        return (alt, url)
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
    /// with the line breaks kept as written — plus the two GFM bits it does not: a
    /// struck-through run, and a bare URL made into a link.
    ///
    /// A link wears the prose's own colour and an underline. Left alone it takes the
    /// app's tint — the accent — and on the person's own bubble that accent is the bubble
    /// itself, so a link drawn in it disappears into the fill it sits on. The underline
    /// is what keeps it reading as a link once the colour stops saying so.
    private func inline(_ line: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard var parsed = try? AttributedString(markdown: line, options: options) else {
            return AttributedString(line)
        }
        parsed = applyingStrikethrough(parsed)
        parsed = autolinking(parsed)
        let links: [Range<AttributedString.Index>] = parsed.runs.compactMap { run in
            run.link == nil ? nil : run.range
        }
        for range in links {
            parsed[range].foregroundColor = color
            parsed[range].underlineStyle = .single
        }
        return parsed
    }

    /// `~~struck~~`: the marks go, what was between them is struck through. Foundation's
    /// parser does not know GFM strikethrough, so the pairs are paired here and the text is
    /// rebuilt from the pieces around them.
    private func applyingStrikethrough(_ attributed: AttributedString) -> AttributedString {
        guard String(attributed.characters).contains("~~") else { return attributed }
        var out = AttributedString()
        var start = attributed.startIndex
        var cursor = attributed.startIndex
        var striking = false

        func flush(_ end: AttributedString.Index) {
            guard start < end else { return }
            var piece = AttributedString(attributed[start..<end])
            if striking { piece.strikethroughStyle = .single }
            out.append(piece)
        }

        while cursor < attributed.endIndex {
            let next = attributed.characters.index(after: cursor)
            if String(attributed.characters[cursor]) == "~",
               next < attributed.endIndex,
               String(attributed.characters[next]) == "~" {
                flush(cursor)
                striking.toggle()
                let after = attributed.characters.index(after: next)
                cursor = after
                start = after
                continue
            }
            cursor = next
        }
        flush(attributed.endIndex)
        return out
    }

    /// Bare `http(s)` URLs the parser left as text, made into links — a URL the person can
    /// tap rather than read. One already inside a link is left to that link.
    private func autolinking(_ attributed: AttributedString) -> AttributedString {
        guard let regex = try? Regex("https?://[^\\s<>()\\[\\]]+") else { return attributed }
        let plain = String(attributed.characters)
        guard !plain.isEmpty else { return attributed }
        var result = attributed
        for match in plain.matches(of: regex) {
            guard let lower = AttributedString.Index(match.range.lowerBound, within: result),
                  let upper = AttributedString.Index(match.range.upperBound, within: result) else { continue }
            let range = lower..<upper
            if result[range].link != nil { continue }
            if let url = URL(string: String(plain[match.range])) { result[range].link = url }
        }
        return result
    }
}

/// Marks a view as a box that scrolls sideways on its own, publishing its frame so a drag
/// on the screen can be told whether it began inside one — the drag then belongs to the box.
private struct ScrollBoxMark: ViewModifier {
    func body(content: Content) -> some View {
        content.background {
            GeometryReader { geo in
                Color.clear.preference(key: ScrollBoxKey.self, value: [geo.frame(in: .global)])
            }
        }
    }
}

private extension View {
    func marksScrollBox() -> some View { modifier(ScrollBoxMark()) }
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
        .marksScrollBox()
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
