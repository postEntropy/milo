import SwiftUI
import UIKit

/// The mark shared by the Crew drawer tab and bot-management tool lines.
struct CrewDrawerMark: View {
    var size: CGFloat = 18

    var body: some View {
        Canvas { context, canvasSize in
            let s = min(canvasSize.width, canvasSize.height) / 24.0
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x * s, y: y * s, width: w * s, height: h * s) }

            let head = Path(roundedRect: rect(4, 7, 16, 14), cornerSize: CGSize(width: 5.5 * s, height: 5.5 * s))
            context.stroke(head, with: .foreground, style: StrokeStyle(lineWidth: 1.8 * s, lineCap: .round, lineJoin: .round))

            var lines = Path()
            lines.move(to: pt(12, 7))
            lines.addLine(to: pt(12, 4))
            lines.move(to: pt(2.5, 12.5))
            lines.addLine(to: pt(2.5, 15.5))
            lines.move(to: pt(21.5, 12.5))
            lines.addLine(to: pt(21.5, 15.5))
            context.stroke(lines, with: .foreground, style: StrokeStyle(lineWidth: 1.8 * s, lineCap: .round))

            context.fill(Path(ellipseIn: rect(10.8, 1.8, 2.4, 2.4)), with: .foreground)
            context.fill(Path(roundedRect: rect(8.3, 11.5, 2.4, 5), cornerSize: CGSize(width: 1.2 * s, height: 1.2 * s)), with: .foreground)
            context.fill(Path(roundedRect: rect(13.3, 11.5, 2.4, 5), cornerSize: CGSize(width: 1.2 * s, height: 1.2 * s)), with: .foreground)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Renders `CrewDrawerMark` as a template `UIImage` so a pinned Crew tab uses the
    /// exact same mark as the Hub, optically sized and centered inside a 26pt tab canvas.
    @MainActor
    static func tabImage(size: CGFloat = 25, canvasSize: CGFloat = 26) -> UIImage {
        let canvas = CGSize(width: canvasSize, height: canvasSize)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: canvas, format: format)
        return renderer.image { context in
            let cg = context.cgContext
            let s = size / 24.0
            // Vertical ink spans y=1.8 (antenna top) to y=21.9 (head bottom stroke), mid=11.85.
            let dx = (canvasSize - size) / 2
            let dy = (canvasSize - size) / 2 + (12.0 - 11.85) * s
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: dx + x * s, y: dy + y * s) }
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
                CGRect(x: dx + x * s, y: dy + y * s, width: w * s, height: h * s)
            }

            UIColor.black.setStroke()
            UIColor.black.setFill()
            cg.setLineWidth(1.8 * s)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)

            let head = UIBezierPath(roundedRect: rect(4, 7, 16, 14), cornerRadius: 5.5 * s)
            head.lineWidth = 1.8 * s
            head.lineCapStyle = .round
            head.lineJoinStyle = .round
            head.stroke()

            let lines = UIBezierPath()
            lines.move(to: pt(12, 7))
            lines.addLine(to: pt(12, 4))
            lines.move(to: pt(2.5, 12.5))
            lines.addLine(to: pt(2.5, 15.5))
            lines.move(to: pt(21.5, 12.5))
            lines.addLine(to: pt(21.5, 15.5))
            lines.lineWidth = 1.8 * s
            lines.lineCapStyle = .round
            lines.stroke()

            UIBezierPath(ovalIn: rect(10.8, 1.8, 2.4, 2.4)).fill()
            UIBezierPath(roundedRect: rect(8.3, 11.5, 2.4, 5), cornerRadius: 1.2 * s).fill()
            UIBezierPath(roundedRect: rect(13.3, 11.5, 2.4, 5), cornerRadius: 1.2 * s).fill()
        }.withRenderingMode(.alwaysTemplate)
    }
}

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
        "read_x_post": "link",
        "read_attachment": "doc.text",
        "write_file": "doc.badge.plus",
        "edit_file": "pencil",
        // One change across several files, and the project's own formatter.
        "apply_patch": "square.and.pencil",
        "format": "wand.and.stars",
        "remember": "cylinder",
        "recall": "clock.arrow.circlepath",
        "search_history": "clock.arrow.circlepath",
        // The saved sessions: a box of them, the box the browser draws for the same tool.
        "sessions": "archivebox",
        "web_search": "globe",
        "read_skill": "note.text",
        "view_image": "eye",
        "instructions": "note.text",
        "memories": "cylinder",
        "routine": "repeat",
        "providers": "cpu",
        "settings": "gearshape",
        "task_lists": "checklist",
        "job_status": "clock",
        "job_kill": "stop.fill",
        "git": "point.3.connected.trianglepath.dotted",
        "git_commit": "point.3.connected.trianglepath.dotted",
        "task": "sparkles",
        "crew": "sparkles",
        "delegated_work": "clock.badge.checkmark",
        "shell_command": "terminal",
        "browser_open": "safari",
        "browser_snapshot": "eye",
        "browser_screenshot": "camera",
        "browser_act": "cursorarrow",
        "computer_list": "macwindow.on.rectangle",
        "computer_open": "macwindow",
        "computer_snapshot": "eye",
        "computer_act": "cursorarrow",
        // Every email tool wears the one mail mark, so a call reads the same whichever
        // of them ran — the page of the mailbox, not the verb.
        "gmail_search": "envelope",
        "gmail_read": "envelope",
        "gmail_modify": "envelope",
        "gmail_draft": "envelope",
        "gmail_send": "envelope",
        "mail_labels": "envelope",
        // Drive's own colours are the product's mark, which this surface does not draw
        // yet; a drive is the honest stand-in until it does.
        "drive_search": "externaldrive",
        "drive_read": "externaldrive",
    ]

    private static let labels: [String: String] = [
        "read_file": "Read",
        "list_dir": "Listed",
        "glob": "Found files",
        "grep": "Searched",
        "fetch_url": "Fetched",
        "read_x_post": "Read post",
        "read_attachment": "Read attachment",
        "git": "Git",
        "git_commit": "Committed",
        "write_file": "Wrote",
        "edit_file": "Edited",
        "apply_patch": "Patched",
        "format": "Formatted",
        "remember": "Remembered",
        "recall": "Recalled",
        "sessions": "Sessions",
        "search_history": "Searched history",
        "web_search": "Searched web",
        "read_skill": "Read skill",
        "view_image": "Viewed image",
        "instructions": "Instructions",
        "memories": "Memories",
        "routine": "Routine",
        "providers": "Providers",
        "settings": "Settings",
        "task_lists": "Task lists",
        "job_status": "Job status",
        "job_kill": "Stopped job",
        "task": "Task",
        "crew": "Crew",
        "delegated_work": "Delegated work",
        "todo": "Plan",
        "send_file": "Sent file",
        "panel": "Panel",
        "shell_command": "Shell",
        "browser_open": "Opened page",
        "browser_snapshot": "Snapshot",
        "browser_screenshot": "Screenshot",
        "browser_act": "Browser",
        "computer_list": "Listed windows",
        "computer_open": "Opened window",
        "computer_snapshot": "Observed window",
        "computer_act": "Desktop",
        "gmail_search": "Searched email",
        "gmail_read": "Read email",
        "gmail_modify": "Modified email",
        "gmail_draft": "Drafted email",
        "gmail_send": "Sent email",
        "mail_labels": "Email labels",
        "drive_search": "Searched Drive",
        "drive_read": "Read Drive",
    ]

    /// A tool's mark, and a plain one for a tool this table has never heard of.
    static func symbol(_ name: String) -> String {
        // A tool that runs on someone else's server wears the server mark.
        if name.hasPrefix("mcp__") { return "server.rack" }
        return symbols[name] ?? "gearshape"
    }

    /// Pending-action headings for approval prompts, matching the server's `toolApprovalTitle`.
    private static let approvalTitles: [String: String] = [
        "computer_open": "Allow window access",
        "computer_act": "Allow desktop action",
        "shell_command": "Allow shell command",
        "write_file": "Allow writing file",
        "edit_file": "Allow editing file",
        "apply_patch": "Allow applying patch",
        "format": "Allow formatting",
        "git_commit": "Allow git commit",
        "gmail_send": "Allow sending email",
        "gmail_draft": "Allow drafting email",
        "gmail_modify": "Allow modifying email",
        "mail_labels": "Allow email label change",
        "browser_open": "Allow opening page",
        "browser_act": "Allow browser action",
        "routine": "Allow routine change",
        "providers": "Allow provider change",
        "settings": "Allow settings change",
        "delegated_work": "Allow delegated work",
        "crew": "Allow crew change",
        "sessions": "Allow session change",
        "instructions": "Allow instruction change",
        "memories": "Allow memory change",
        "job_kill": "Allow stopping job",
        "send_file": "Allow sending file",
    ]

    /// The human-readable label for a tool name, matching the server's `toolDisplayName`.
    static func label(_ name: String) -> String {
        if let label = labels[name] { return label }
        if name.hasPrefix("mcp__") {
            let parts = name.dropFirst(5).split(separator: "__", maxSplits: 1)
            if parts.count == 2 { return "\(parts[0]): \(parts[1])" }
        }
        return name
    }

    /// Pending-action heading for an approval prompt, matching `toolApprovalTitle`.
    static func approvalTitle(_ name: String) -> String {
        approvalTitles[name] ?? "Allow \(label(name))"
    }
}
