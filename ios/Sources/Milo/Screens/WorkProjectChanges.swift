import SwiftUI

struct ProjectChanges: View {
    let projectId: String

    @Environment(AppModel.self) private var model
    @State private var diff: WorkDiff?
    @State private var error: String?
    /// Recording the folder as it is now, while it is being recorded.
    @State private var tracking = false
    /// The changed file whose hunks are open, risen from the bottom of the screen.
    @State private var reading: WorkDiffFile?

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Text("Changes")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: MiloTheme.Space.two)
                if let diff, diff.isGit, !diff.files.isEmpty {
                    Text("\(diff.files.count) \(diff.files.count == 1 ? "file" : "files")")
                        .font(MiloTheme.Text.meta.monospacedDigit())
                        .foregroundStyle(MiloTheme.muted)
                }
            }

            if let error {
                MiloErrorPill(text: error)
            }

            if let diff {
                if !diff.isGit || !diff.committed {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        // What this is, then what pressing the control below would do: the
                        // words read first, and the one thing to press sits under them. A
                        // repository with nothing committed has no state to compare against —
                        // every file in it would read as new — so that is said instead of the
                        // whole folder.
                        Text(diff.isGit
                            ? "Nothing is recorded in this repository yet, so every file in it counts as new."
                            : "\(diff.reason ?? "") Milo reads a folder’s changes through git, so there is nothing here to compare this one to.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                        Text("Git keeps the history locally, in a .git folder inside the project. Nothing is sent anywhere.")
                            .font(MiloTheme.Text.meta)
                            .foregroundStyle(MiloTheme.muted)
                        // Their folder, their repository: pressing this is the person's own act,
                        // and it is the only thing that makes this section say anything at all.
                        // A capsule the size of what it says — the composer's own glass, not the
                        // wide control a screen's bottom bar is made of.
                        Button {
                            Task { await track() }
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                if tracking {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "arrow.triangle.branch")
                                        .font(.system(size: 13, weight: .medium))
                                }
                                Text(tracking ? "Recording…" : diff.isGit ? "Record the first state" : "Start a repository")
                                    .font(MiloTheme.Text.small)
                            }
                            .foregroundStyle(MiloTheme.foreground2)
                            .padding(.horizontal, MiloTheme.Space.four)
                            .padding(.vertical, MiloTheme.Space.two + 1)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(tracking)
                        .glassEffect(.regular.interactive(), in: Capsule())
                        .accessibilityLabel(diff.isGit
                            ? "Record what is in this folder now as its first state"
                            : "Start a git repository in this folder")
                        .padding(.top, MiloTheme.Space.one)
                    }
                } else if diff.files.isEmpty {
                    Text("No changes")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        ForEach(diff.files) { file in
                            DiffFileRow(file: file, onOpen: { reading = file })
                        }
                    }
                }

                if diff.isGit, diff.truncated {
                    Text("Only the first \(diff.files.count) changed files are shown — there are more than fit here.")
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                }
            } else if error == nil {
                HStack(spacing: MiloTheme.Space.two) {
                    ProgressView().controlSize(.small)
                    Text("Reading the changes…")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
        }
        .task { await read() }
        .onChange(of: model.workMoved) { _, _ in Task { await read() } }
        // The file's own hunks, risen from the bottom: a diff is read on its own, and a long
        // one would otherwise stretch the project's page it changed in.
        .sheet(item: $reading) { file in DiffDetail(file: file) }
    }

    private func read() async {
        do {
            diff = try await model.projectDiff(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Recording the folder as its first state, and drawing the changes it made readable —
    /// empty, because there is now something to compare against — rather than asking the
    /// daemon for them again.
    private func track() async {
        tracking = true
        defer { tracking = false }
        do {
            diff = try await model.startTracking(projectId)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/**
 One changed file as the list draws it: what it is called, where it came from, and how much
 moved. A tap rises its hunks from the bottom of the screen rather than opening them under
 the row — a diff is read on its own, and a long one spread under the row would stretch the
 page it changed in.
 */
private struct DiffFileRow: View {
    let file: WorkDiffFile
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            DiffSummary(file: file, place: .row)
                .padding(.vertical, MiloTheme.Space.two)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }
}

/// A changed file's own line: what it is called, where it came from, and how much moved.
/// Drawn in the list and again at the top of its own drawer, from one place, so the two
/// cannot come to say different things about the same file — each at the step its own place
/// reads a line at.
private struct DiffSummary: View {
    /// Where the line stands: one row among the list's, or the name of what a drawer holds.
    enum Place {
        case row
        case title
    }

    let file: WorkDiffFile
    let place: Place

    /// The file's name: a row carries it at the step the list's rows are drawn at, and the
    /// drawer, which has nothing above it, a step above that — enough to read as the name of
    /// what the drawer holds, without shouting over the code inside it.
    private var name: Font {
        place == .title ? MiloTheme.Text.base.weight(.semibold).monospaced() : MiloTheme.Text.small.monospaced()
    }

    /// Where it came from and how much moved, a step under the name wherever it is drawn.
    private var detail: Font {
        place == .title ? MiloTheme.Text.small : MiloTheme.Text.meta
    }

    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Text(file.path)
                .font(name)
                .foregroundStyle(MiloTheme.foreground)
                .lineLimit(1)
                // A path too long to fit gives way at its head, never at the file's own name:
                // the last segment is the one that says which file this is, and half a
                // directory still says where it sits.
                .truncationMode(.head)
            if let from = file.from {
                Text("was \(from)")
                    .font(detail)
                    .foregroundStyle(MiloTheme.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: MiloTheme.Space.two)
            // The counts are only drawn when something moved: a rename or a
            // permission change has no lines of its own, and `+0 −0` says nothing.
            if file.additions > 0 || file.deletions > 0 {
                HStack(spacing: MiloTheme.Space.one) {
                    if file.additions > 0 {
                        Text("+\(file.additions)").foregroundStyle(MiloTheme.success)
                    }
                    if file.deletions > 0 {
                        Text("−\(file.deletions)").foregroundStyle(MiloTheme.danger)
                    }
                }
                .font(detail.monospacedDigit())
            }
        }
    }
}

/**
 One changed file's hunks, risen from the bottom of the screen.

 The marking is the diff's own: an added line green, a removed one red, both numbers in the
 gutter so a line can be found in the file it is from. What git called the change is not
 drawn beside the name: the path names the file, a rename says where it came from, and the
 counts say how much moved.
 */
private struct DiffDetail: View {
    let file: WorkDiffFile

    var body: some View {
        DetailSheet {
            VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                DiffSummary(file: file, place: .title)

                // The same box a code block is drawn in: monospaced, scrolling sideways
                // rather than wrapping — a wrapped line of a diff stops being that line. Not
                // marked as a scroll box: nothing drags behind a sheet.
                if !file.hunks.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(file.hunks) { hunk in
                                Text("@@ \(hunk.header) @@")
                                    .font(MiloTheme.Text.meta.monospaced())
                                    .foregroundStyle(MiloTheme.muted)
                                    .padding(.top, MiloTheme.Space.three)
                                    .padding(.bottom, MiloTheme.Space.one)
                                ForEach(runs(of: hunk.lines)) { run in
                                    // One wash behind the whole run, not one per line: the
                                    // lines touch inside it, so a changed block reads as a
                                    // single block instead of a column of small ones.
                                    VStack(alignment: .leading, spacing: 0) {
                                        ForEach(run.lines) { line in
                                            DiffLineRow(line: line, language: file.path)
                                        }
                                    }
                                    .background(run.wash)
                                }
                            }
                        }
                        .padding(MiloTheme.Space.three)
                    }
                    .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                }

                // Why there is nothing above to draw, where there is something to say: a
                // binary file, only its mode changed, or a file git does not track yet.
                if let note = file.note {
                    Text(note)
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                }
            }
        }
    }

    /// The hunk's lines cut into runs of one kind, in the order they were written: the
    /// background belongs to the run, so two added lines in a row share one rectangle.
    private func runs(of lines: [WorkDiffLine]) -> [DiffLineRun] {
        var runs: [DiffLineRun] = []
        for line in lines {
            if runs.last?.kind == line.kind {
                runs[runs.count - 1].lines.append(line)
            } else {
                runs.append(DiffLineRun(kind: line.kind, lines: [line]))
            }
        }
        return runs
    }
}

/// One run of consecutive lines that went the same way, drawn under a single wash.
private struct DiffLineRun: Identifiable {
    let kind: String
    var lines: [WorkDiffLine]

    var id: String { "\(kind)-\(lines.first?.id ?? "")" }

    /// A wash, not a fill: which way the line went is read at a glance, and the code on top of
    /// it is still what is being read — so the colour is strong enough to name the line and no
    /// stronger. The browser mixes the same two into the same tone.
    var wash: Color {
        if kind == "add" { return MiloTheme.success.opacity(0.20) }
        if kind == "remove" { return MiloTheme.danger.opacity(0.17) }
        return .clear
    }
}

/// One line of a hunk: its two line numbers, the diff's own marker, and the text — coloured
/// out of the roles the shared lexer reads, which is the one thing a diff's line and a reply's
/// block say alike.
private struct DiffLineRow: View {
    let line: WorkDiffLine
    /// What the line is read as: the changed file's own name, since a diff carries no tag.
    let language: String?

    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Text(line.old.map(String.init) ?? "")
                .frame(width: 44, alignment: .trailing)
            Text(line.new.map(String.init) ?? "")
                .frame(width: 44, alignment: .trailing)
            Text(line.mark)
                .foregroundStyle(line.isAdd ? MiloTheme.success : line.isRemove ? MiloTheme.danger : MiloTheme.muted)
            // An empty line is one space, so the row is the height its gutter numbers are and
            // the two of them still line up down the hunk.
            Text(line.text.isEmpty ? AttributedString(" ") : coloured(line.text, language: language))
            Spacer(minLength: 0)
        }
        // The size a file is read at in its own drawer: a changed line is code too, and the
        // two drawers read alike now that both rise from the same place.
        .font(MiloTheme.Text.mono)
        .padding(.horizontal, MiloTheme.Space.two)
    }
}

// MARK: - The folder of a project

/**
 The tree of a project's folder, and one file of it read.

 Read-only: the person edits in their own editor and the agent through its own tools, so
 this draws what is there and opens a file as text. The tree is the daemon's own walk —
 the same one the agent's tools use — so what is drawn here and what a search finds
 cannot disagree about what is in the folder.
 */
