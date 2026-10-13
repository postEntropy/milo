import SwiftUI

/**
 A turn's prose, drawn as what it is. The model writes markdown and the browser
 renders it; the phone was showing the delimiters — asterisks around a word, backticks
 around a path, and a code block as a wall of monospaced text.

 Blocks first, then inline within them: a fence is a block, and the inline pass would
 otherwise leave it as a paragraph of backticks.
 */
struct Prose: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
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
                }
            }
        }
    }

    private enum Block {
        case paragraph(String)
        case heading(level: Int, text: String)
        case code(String)
    }

    private var blocks: [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: [String] = []
        var fenced = false

        func endParagraph() {
            let text = paragraph.joined(separator: "\n")
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.paragraph(text)) }
            paragraph = []
        }

        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if fenced {
                    blocks.append(.code(code.joined(separator: "\n")))
                    code = []
                    fenced = false
                } else {
                    endParagraph()
                    fenced = true
                }
                continue
            }
            if fenced {
                code.append(line)
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
                    continue
                }
            }
            paragraph.append(line)
        }

        // An unterminated fence is what a code block looks like while it streams, so it
        // is drawn as code rather than left as prose with a stray fence in it.
        if fenced || !code.isEmpty { blocks.append(.code(code.joined(separator: "\n"))) }
        endParagraph()
        return blocks
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
