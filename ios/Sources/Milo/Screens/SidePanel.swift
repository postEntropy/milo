import SwiftUI

/**
 The panel beside the chat: a document, a picture, a PDF, a page or the live browser, slid
 in from the trailing edge — the sessions drawer's own move, mirrored. The chat is the layer
 that travels, so the rounded edge and the shadow belong to it; this one is a column on the
 panel's own tone.

 It holds nothing of its own: what is open is the daemon's, and closing a tab is asked of
 the daemon, whose answer arrives as the next panel. That round trip is the browser's own, so
 two screens watching one chat cannot come to disagree about what is on it.

 The tabs and the one in front arrive already picked — the caller's own gate is what says
 there is a panel at all — so nothing here has to draw a state the daemon cannot send.
 */
struct SidePanel: View {
    let tabs: [PanelTab]
    let active: PanelTab
    /// How wide the column comes out, from the screen it is standing in — see the chat's own
    /// `panelWidth`, which is the one place that decides it.
    let width: CGFloat
    let onClose: () -> Void
    @Environment(AppModel.self) private var model
    /// Bumped by the refresh control. A document's words are read when its tab is drawn, so
    /// reading them again is the whole of what refreshing does here.
    @State private var nonce = 0

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            column
                .frame(width: width)
                .background(MiloTheme.surface.ignoresSafeArea())
        }
        .frame(maxHeight: .infinity)
    }

    private var column: some View {
        VStack(spacing: 0) {
            header
            if tabs.count > 1 { strip }
            content
        }
    }

    private var header: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Text(title)
                .font(MiloTheme.Text.base.weight(.medium))
                .foregroundStyle(MiloTheme.foreground)
                .lineLimit(1)
            Spacer(minLength: MiloTheme.Space.two)
            // Only where it does something: a document is re-read from the daemon, and every
            // other kind is the file as the daemon serves it — a control that redrew the same
            // address would be one that promises more than it does.
            if active.kind == .document {
                MiloIconButton(systemName: "arrow.clockwise", size: 15, span: 34) { nonce += 1 }
                    .accessibilityLabel("Read the file again")
            }
            MiloIconButton(systemName: "xmark", size: 15, span: 34) { onClose() }
                .accessibilityLabel("Close the panel")
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.two)
    }

    /// The tabs, when there is more than one. Each is its own filled chip — the front one a
    /// step raised — holding a press that brings it forward and another that closes it, named
    /// by key rather than by place so a press cannot race the list shifting under it.
    private var strip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: MiloTheme.Space.two) {
                ForEach(tabs) { tab in
                    chip(tab)
                }
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.bottom, MiloTheme.Space.two)
        }
    }

    private func chip(_ tab: PanelTab) -> some View {
        let front = tab.key == active.key
        return HStack(spacing: MiloTheme.Space.one) {
            Button { model.activatePanelTab(tab.key) } label: {
                HStack(spacing: MiloTheme.Space.one) {
                    Image(systemName: symbol(for: tab.kind))
                        .font(.system(size: 12, weight: .medium))
                    Text(tab.title ?? name(for: tab.kind))
                        .font(MiloTheme.Text.small)
                        .lineLimit(1)
                }
                .padding(.leading, MiloTheme.Space.three)
                .padding(.vertical, MiloTheme.Space.two)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())

            Button { model.closePanelTab(tab.key) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .padding(.trailing, MiloTheme.Space.three)
                    .padding(.vertical, MiloTheme.Space.two)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("Close \(tab.title ?? name(for: tab.kind))")
        }
        .foregroundStyle(front ? MiloTheme.foreground : MiloTheme.muted)
        .background(front ? MiloTheme.surfaceRaised : MiloTheme.surfaceWarm, in: Capsule())
    }

    @ViewBuilder
    private var content: some View {
        Group {
            switch active.kind {
            case .document: PanelDocument(tab: active, nonce: nonce)
            case .image: PanelImage(tab: active)
            case .pdf: PanelPdf(tab: active)
            case .page: PanelPage(tab: active)
            case .browser: PanelBrowser(tab: active)
            case .file, .other: PanelFile(tab: active)
            }
        }
        // A tab is its own surface: another one has to build its own view rather than hand
        // the last one's a different file — a reader already holding a document would
        // otherwise go on drawing it.
        .id(active.key)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.bottom, MiloTheme.Space.three)
    }

    private var title: String {
        active.title ?? name(for: active.kind)
    }

    /// What a tab of each kind is called where the daemon named none — the words the
    /// browser's own panel uses, so one tab does not go by two names.
    private func name(for kind: PanelKind) -> String {
        switch kind {
        case .document: return "Document"
        case .page: return "Page"
        case .image: return "Picture"
        case .pdf: return "PDF"
        case .browser: return "Browser"
        case .file, .other: return "File"
        }
    }

    /// The mark a kind wears. What a tab *is* was decided by the daemon; the mark is this
    /// app's own, the way the browser keeps its own table for the same six.
    private func symbol(for kind: PanelKind) -> String {
        switch kind {
        case .document: return "doc.text"
        case .page: return "safari"
        case .image: return "photo"
        case .pdf: return "doc.richtext"
        case .browser: return "globe"
        case .file, .other: return "doc"
        }
    }
}
