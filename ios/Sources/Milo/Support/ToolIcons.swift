/// The mark a tool call wears on this surface.
///
/// The choice of *which* mark a tool gets is one question with an answer per surface:
/// the browser draws its own line art (`web/src/ui/tool-icons.ts`), the chat gateways
/// wear an emoji (`src/gateways/tool-line.ts`), and the phone answers with SF Symbols —
/// because an emoji beside a drawn interface, or a web icon ported stroke by stroke,
/// would read as a different hand in the same row.
enum ToolIcons {
    /// The name-to-symbol table, kept beside the browser's own so the two read against
    /// each other. Only the tools the browser maps are mapped here, so a tool draws the
    /// same thing on both drawable surfaces; anything else is the plain mark below.
    private static let symbols: [String: String] = [
        "read_file": "doc.text",
        "list_dir": "folder",
        // Which files match a pattern, against which lines inside them carry a term:
        // different questions, so different marks.
        "glob": "doc.on.doc",
        "grep": "magnifyingglass",
        "fetch_url": "link",
        "write_file": "doc.badge.plus",
        "edit_file": "pencil",
        "remember": "cylinder",
        "recall": "clock.arrow.circlepath",
        "search_history": "clock.arrow.circlepath",
        "web_search": "globe",
        "read_skill": "note.text",
        "task": "sparkles",
        "shell_command": "terminal",
        "browser_open": "safari",
        "browser_snapshot": "eye",
        "browser_screenshot": "camera",
        "browser_act": "cursorarrow",
        // Every email tool wears the one mail mark, so a call reads the same whichever
        // of them ran — the page of the mailbox, not the verb.
        "gmail_search": "envelope",
        "gmail_read": "envelope",
        "gmail_modify": "envelope",
        "mail_labels": "envelope",
        // Drive's own colours are the product's mark, which this surface does not draw
        // yet; a drive is the honest stand-in until it does.
        "drive_search": "externaldrive",
        "drive_read": "externaldrive",
    ]

    /// A tool's mark, and a plain one for a tool this table has never heard of.
    static func symbol(_ name: String) -> String {
        // A tool that runs on someone else's server wears the server mark.
        if name.hasPrefix("mcp__") { return "server.rack" }
        return symbols[name] ?? "gearshape"
    }
}
