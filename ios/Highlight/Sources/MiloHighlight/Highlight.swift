import Foundation

/**
 Syntax colouring, decided once for every surface that draws code: the diff of a project's
 folder, a fenced block in a reply, a file read back.

 This is the core's `src/core/highlight.ts` written out in Swift, held to the same cases on
 disk (`test/fixtures/highlight.json`). The two surfaces have no runtime in common, so the
 roles read out of the same code have to be the same on both, or the same file reads one way
 in the browser and another on the phone.

 Roles, not colours — this says what a run of characters *is*. The phone paints each role with
 `MiloTheme`, the browser with `--code-*`, and neither of them decides it here.

 Families, not grammars: a language is a comment syntax, a keyword list, and whether it quotes
 with backticks or triple quotes. This is not a parser — the point is that reading code is
 pleasant, never that every token is placed by a specification.
 */

/// What a run of characters is, in the words every surface shares.
public enum CodeRole: String, Sendable {
    case plain
    case comment
    case string
    case number
    case keyword
}

/// One run of characters: the whole of a piece of code lands in runs, in order, with nothing
/// between them, so a surface can draw them one after another and add nothing of its own.
public struct CodeRun: Equatable, Sendable {
    public let role: CodeRole
    public let text: String

    public init(role: CodeRole, text: String) {
        self.role = role
        self.text = text
    }
}

/// The languages this colours. `plain` is text we have no rules for: strings and numbers only.
public enum CodeLanguage: String, Sendable {
    case ts
    case js
    case swift
    case python
    case shell
    case css
    case json
    case yaml
    case ruby
    case plain
}

/**
 The runs of one piece of code.

 `language` is a fence's tag or a file's own name — anything `languageOf` can read.
 */
public func highlight(_ code: String, language: String? = nil) -> [CodeRun] {
    let lang = languageOf(language)
    let family = FAMILY[lang] ?? .none
    let keywords = KEYWORDS[lang] ?? []
    let characters = Array(code)
    var runs: [CodeRun] = []
    var index = 0

    while index < characters.count {
        let character = characters[index]

        // A comment runs to the end of its line, or to the `*/` that closes it — and an
        // unclosed one takes the rest of the block, which is what a reply still streaming
        // looks like.
        if family == .slash, starts(characters, index, "//") {
            let end = lineEnd(characters, index)
            push(&runs, .comment, characters[index..<end])
            index = end
            continue
        }
        if family == .slash, starts(characters, index, "/*") {
            let close = find(characters, index + 2, "*/")
            let end = close.map { $0 + 2 } ?? characters.count
            push(&runs, .comment, characters[index..<end])
            index = end
            continue
        }
        if family == .hash, character == "#" {
            let end = lineEnd(characters, index)
            push(&runs, .comment, characters[index..<end])
            index = end
            continue
        }

        // A triple quote is a string that runs past its own line — Python's one way of
        // writing prose inside code.
        if lang == .python, starts(characters, index, "\"\"\"") || starts(characters, index, "'''") {
            let fence = String(characters[index..<index + 3])
            let close = find(characters, index + 3, fence)
            let end = close.map { $0 + 3 } ?? characters.count
            push(&runs, .string, characters[index..<end])
            index = end
            continue
        }

        // A quoted string ends at its own closing quote on the same line: a lone apostrophe in
        // a sentence is not a string, and one left open would otherwise swallow the rest of a
        // file. A backtick (JavaScript's template) is the exception, written to span lines.
        if character == "\"" || character == "'" || character == "`" {
            if let end = stringEnd(characters, index, character, across: character == "`") {
                push(&runs, .string, characters[index..<end])
                index = end
            } else {
                push(&runs, .plain, characters[index..<index + 1])
                index += 1
            }
            continue
        }

        if isDigit(character) || (character == "." && isDigit(at(characters, index + 1))) {
            let end = numberEnd(characters, index)
            push(&runs, .number, characters[index..<end])
            index = end
            continue
        }

        if isIdentifierStart(character) {
            let end = identifierEnd(characters, index)
            let word = String(characters[index..<end])
            push(&runs, keywords.contains(word) ? .keyword : .plain, characters[index..<end])
            index = end
            continue
        }

        push(&runs, .plain, characters[index..<index + 1])
        index += 1
    }

    return runs
}

/**
 A fence's tag, or a file's own name, read as one of the languages above.

 A hint we do not know — a `rust` fence, a `.hbs` file — is `plain` rather than a guess, since
 colouring by the wrong rules is worse than not colouring. A *missing* hint is the exception: a
 fence opened without a tag is most often TypeScript or JavaScript, which is what `ts` is here,
 and the one thing that loses is a `#` comment that is not a comment.
 */
public func languageOf(_ hint: String? = nil) -> CodeLanguage {
    let named = (hint ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if named.isEmpty { return .ts }
    let file = named.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? named
    if let direct = ALIASES[file] { return direct }
    guard let dot = file.lastIndex(of: ".") else { return .plain }
    let suffix = String(file[file.index(after: dot)...])
    return ALIASES[suffix] ?? .plain
}

// MARK: - What each language is

/// How a language marks a comment. `none` is JSON, which has none.
private enum Family {
    case slash
    case hash
    case none
}

private let FAMILY: [CodeLanguage: Family] = [
    .ts: .slash,
    .js: .slash,
    .swift: .slash,
    .css: .slash,
    .json: .none,
    .plain: .none,
    .python: .hash,
    .shell: .hash,
    .yaml: .hash,
    .ruby: .hash,
]

/**
 What carries meaning in each language. Deliberately short: a word list is what a reader
 recognises at a glance, and a longer one (every builtin, every framework name) turns a block
 into confetti.
 */
private let OWN_KEYWORDS: [CodeLanguage: Set<String>] = [
    .ts: [
        "abstract", "any", "as", "async", "await", "break", "case", "catch", "class", "const",
        "continue", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
        "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof",
        "interface", "let", "new", "of", "readonly", "return", "satisfies", "static", "super",
        "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "yield",
    ],
    .js: [
        "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
        "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if",
        "import", "in", "instanceof", "let", "new", "of", "return", "static", "super", "switch",
        "this", "throw", "try", "typeof", "var", "void", "while", "yield",
    ],
    .swift: [
        "actor", "any", "as", "async", "await", "break", "case", "catch", "class", "continue",
        "default", "defer", "deinit", "do", "else", "enum", "extension", "fileprivate", "final",
        "for", "func", "guard", "if", "import", "in", "init", "internal", "is", "lazy", "let",
        "open", "override", "private", "protocol", "public", "repeat", "return", "self", "some",
        "static", "struct", "switch", "throw", "throws", "try", "typealias", "var", "weak",
        "where", "while",
    ],
    .python: [
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
        "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "self", "try", "while",
        "with", "yield",
    ],
    .shell: [
        "case", "do", "done", "elif", "else", "esac", "exit", "export", "fi", "for", "function",
        "if", "in", "local", "readonly", "return", "set", "shift", "then", "trap", "unset",
        "until", "while",
    ],
    .css: [],
    .json: [],
    .yaml: [],
    .ruby: [
        "begin", "break", "case", "class", "def", "do", "else", "elsif", "end", "ensure", "for",
        "if", "in", "module", "next", "require", "rescue", "return", "self", "then", "unless",
        "until", "when", "while", "yield",
    ],
    .plain: [],
]

/// The words every language reads the same way, added to whatever it knows of its own.
private let LITERALS: Set<String> = ["false", "nil", "none", "null", "true", "undefined"]

private let KEYWORDS: [CodeLanguage: Set<String>] = {
    var all: [CodeLanguage: Set<String>] = [:]
    for (language, words) in OWN_KEYWORDS {
        all[language] = words.union(LITERALS)
    }
    return all
}()

private let ALIASES: [String: CodeLanguage] = [
    "ts": .ts,
    "tsx": .ts,
    "mts": .ts,
    "cts": .ts,
    "typescript": .ts,
    "js": .js,
    "jsx": .js,
    "mjs": .js,
    "cjs": .js,
    "javascript": .js,
    "swift": .swift,
    "py": .python,
    "python": .python,
    "sh": .shell,
    "bash": .shell,
    "zsh": .shell,
    "shell": .shell,
    "console": .shell,
    "dockerfile": .shell,
    "makefile": .shell,
    "css": .css,
    "scss": .css,
    "less": .css,
    "json": .json,
    "jsonc": .json,
    "yaml": .yaml,
    "yml": .yaml,
    "rb": .ruby,
    "ruby": .ruby,
    "md": .plain,
    "markdown": .plain,
    "txt": .plain,
    "text": .plain,
    "log": .plain,
]

// MARK: - Reading one piece of code

/// Adds a run, joining it to the one before when they carry the same role.
private func push(_ runs: inout [CodeRun], _ role: CodeRole, _ characters: ArraySlice<Character>) {
    guard !characters.isEmpty else { return }
    let text = String(characters)
    if let last = runs.last, last.role == role {
        runs[runs.count - 1] = CodeRun(role: role, text: last.text + text)
    } else {
        runs.append(CodeRun(role: role, text: text))
    }
}

/// Where the line holding `from` ends — the newline itself belongs to the line before it.
private func lineEnd(_ characters: [Character], _ from: Int) -> Int {
    var index = from
    while index < characters.count, characters[index] != "\n" {
        index += 1
    }
    return index
}

/// Where a string opened at `from` ends, closing quote included — or nil when nothing closed
/// it, which leaves the quote to stand for itself.
private func stringEnd(_ characters: [Character], _ from: Int, _ quote: Character, across: Bool) -> Int? {
    let stop = across ? characters.count : lineEnd(characters, from)
    var index = from + 1
    while index < stop {
        if characters[index] == "\\" {
            index += 2
            continue
        }
        if characters[index] == quote {
            return index + 1
        }
        index += 1
    }
    return across ? characters.count : nil
}

/// Where the number starting at `from` ends: digits, `_` separators, one dot, and a hex tail.
private func numberEnd(_ characters: [Character], _ from: Int) -> Int {
    var index = from
    if at(characters, index) == "0", at(characters, index + 1) == "x" || at(characters, index + 1) == "X" {
        index += 2
        while index < characters.count, isHexDigit(characters[index]) || characters[index] == "_" {
            index += 1
        }
        return index
    }
    var dot = false
    while index < characters.count {
        let character = characters[index]
        if isDigit(character) || character == "_" {
            index += 1
            continue
        }
        if character == ".", !dot {
            dot = true
            index += 1
            continue
        }
        break
    }
    return index
}

private func identifierEnd(_ characters: [Character], _ from: Int) -> Int {
    var index = from
    while index < characters.count, isIdentifierPart(characters[index]) {
        index += 1
    }
    return index
}

private func at(_ characters: [Character], _ index: Int) -> Character? {
    index >= 0 && index < characters.count ? characters[index] : nil
}

private func starts(_ characters: [Character], _ index: Int, _ text: String) -> Bool {
    let needle = Array(text)
    guard index + needle.count <= characters.count else { return false }
    for offset in 0..<needle.count where characters[index + offset] != needle[offset] {
        return false
    }
    return true
}

private func find(_ characters: [Character], _ from: Int, _ text: String) -> Int? {
    let needle = Array(text)
    guard !needle.isEmpty else { return from }
    var index = from
    while index + needle.count <= characters.count {
        if starts(characters, index, text) {
            return index
        }
        index += 1
    }
    return nil
}

private func isDigit(_ character: Character?) -> Bool {
    guard let character else { return false }
    return character >= "0" && character <= "9"
}

private func isHexDigit(_ character: Character) -> Bool {
    isDigit(character) || (character >= "a" && character <= "f") || (character >= "A" && character <= "F")
}

private func isIdentifierStart(_ character: Character) -> Bool {
    (character >= "a" && character <= "z")
        || (character >= "A" && character <= "Z")
        || character == "_"
        || character == "$"
}

private func isIdentifierPart(_ character: Character) -> Bool {
    isIdentifierStart(character) || isDigit(character)
}
