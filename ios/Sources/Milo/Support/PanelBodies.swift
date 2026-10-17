import SwiftUI

/**
 A line the panel has to say — a file it could not read, a picture still on its way. Drawn
 where the thing itself would be rather than left as an empty box: a panel that shows nothing
 and says nothing is the one failure a look cannot report.
 */
struct PanelLine: View {
    let text: String
    var tone: Color = MiloTheme.muted
    /// The way out, where there is one — a retry. The platform's own glass, like every control
    /// on this surface.
    var action: (title: String, run: () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
            Text(text)
                .font(MiloTheme.Text.base)
                .foregroundStyle(tone)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                MiloWideButton(title: action.title, primary: true, action: action.run)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A text or code file, read from the daemon and drawn as prose or as monospace. Read when
/// the tab is drawn and again on a refresh, because the file is the source of truth: the
/// panel only ever holds a reading of it.
struct PanelDocument: View {
    let tab: PanelTab
    /// A new value re-reads the same file — what the panel's refresh control raises.
    let nonce: Int
    @Environment(AppModel.self) private var model
    @State private var read: (text: String, truncated: Bool)?
    @State private var failure: String?

    var body: some View {
        ScrollView {
            Group {
                if let read {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                        if markdown {
                            Prose(text: read.text)
                        } else {
                            Text(read.text)
                                .font(MiloTheme.Text.mono)
                                .foregroundStyle(MiloTheme.foreground)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if read.truncated { cut }
                    }
                } else if let failure {
                    PanelLine(text: failure)
                } else {
                    PanelLine(text: "Reading…")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: nonce) { await load() }
    }

    /// Said where the words stop, rather than left as a file that appears to end there.
    private var cut: some View {
        Text("The file is larger than the panel draws — only the first 512 KB is shown.")
            .font(MiloTheme.Text.small)
            .foregroundStyle(MiloTheme.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Whether the file is drawn as prose. The name decides it, the way the browser's own
    /// panel decides it — the same two extensions, so one file does not read as markdown on
    /// one surface and as monospace on the other.
    private var markdown: Bool {
        let name = (tab.artifact?.name ?? "").lowercased()
        return name.hasSuffix(".md") || name.hasSuffix(".markdown")
    }

    private func load() async {
        guard let id = tab.artifact?.id else {
            failure = "That tab has no file behind it."
            return
        }
        read = nil
        failure = nil
        do {
            read = try await model.panelText(id)
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// A picture, drawn at the panel's own width. Its bytes come from the daemon by id, with the
/// token in the query, which is the request an image loader can make.
struct PanelImage: View {
    let tab: PanelTab
    @Environment(AppModel.self) private var model

    var body: some View {
        if let url = tab.artifact.flatMap({ model.panelURL($0.id) }) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                case .failure:
                    PanelLine(text: "That picture could not be drawn.")
                default:
                    PanelLine(text: "Loading the picture…")
                }
            }
        } else {
            PanelLine(text: "That tab has no picture behind it.")
        }
    }
}

/// A file the panel has no way to draw: a row that hands it to the system, which is where the
/// browser's own panel hands it too.
struct PanelFile: View {
    let tab: PanelTab
    @Environment(AppModel.self) private var model

    var body: some View {
        if let artifact = tab.artifact, let url = model.attachmentURL(artifact.id) {
            Link(destination: url) {
                HStack(spacing: MiloTheme.Space.three) {
                    Image(systemName: "arrow.down.doc")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(MiloTheme.foreground)
                    VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                        Text(artifact.name)
                            .font(MiloTheme.Text.base)
                            .foregroundStyle(MiloTheme.foreground)
                            .lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(MiloTheme.Space.three)
                .background(MiloTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
            }
        } else {
            PanelLine(text: "That tab has no file behind it.")
        }
    }
}
