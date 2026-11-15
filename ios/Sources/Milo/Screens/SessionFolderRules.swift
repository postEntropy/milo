import SwiftUI

struct ProjectRulesSection: View {
    let projectId: String
    /// Has the agent write the file, with the words the daemon gave.
    let onWrite: (String) -> Void

    @Environment(AppModel.self) private var model
    @State private var rules: ProjectRules?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Rules")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            if let error {
                MiloErrorPill(text: error)
            } else if let rules {
                if rules.carriesRules {
                    Text("This folder’s rules are in \(rules.file ?? "AGENTS.md"). A session started here follows them.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else if rules.isUnreadable {
                    Text("This folder has an \(rules.file ?? "AGENTS.md") that could not be read: \(rules.error ?? "")")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    // What the rules are, said once, and the one control that makes them: a
                    // session told to read the folder and write the file, which the person then
                    // watches — not a file written behind their back. A capsule the size of what
                    // it says, the same glass the rest of the screen presses.
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Text("This folder has no AGENTS.md — the file that tells a session started here how the project is worked in: its commands, its layout, its conventions.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                        Button {
                            onWrite(rules.prompt)
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                Image(systemName: "square.and.pencil")
                                    .font(.system(size: 13, weight: .medium))
                                Text("Write the rules")
                                    .font(MiloTheme.Text.small)
                            }
                            .foregroundStyle(MiloTheme.foreground2)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .padding(.vertical, MiloTheme.Space.two + 1)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .glassEffect(.regular.interactive(), in: Capsule())
                        .accessibilityLabel("Ask Milo to read this folder and write its AGENTS.md")
                    }
                }
            }
        }
        .task { await read() }
        // The daemon said a piece of work moved — the same signal the running dot follows —
        // so the folder is read again rather than left as it was before the turn.
        .onChange(of: model.workMoved) { _, _ in Task { await read() } }
    }

    private func read() async {
        do {
            rules = try await model.projectRules(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

