import SwiftUI
import WebKit

/// An HTML page the model wrote, drawn live. The daemon serves it with its own sandbox, so
/// what the page may do is the daemon's decision rather than this app's — the same
/// arrangement the browser's panel keeps, where the page is framed rather than trusted.
struct PanelPage: View {
    let tab: PanelTab
    @Environment(AppModel.self) private var model

    var body: some View {
        if let url = tab.artifact.flatMap({ model.panelURL($0.id) }) {
            WebPage(url: url)
        } else {
            PanelLine(text: "That page has no file behind it.")
        }
    }
}

/// The page, in the platform's own web view. It is loaded once, when the tab is drawn: a
/// tab is its own view (see `SidePanel`), so another page is another load rather than this
/// one being pointed somewhere else.
private struct WebPage: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = .clear
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
