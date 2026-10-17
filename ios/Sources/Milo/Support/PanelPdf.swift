import PDFKit
import SwiftUI

/// A PDF, read in the platform's own viewer. Its bytes come from the daemon over HTTP with
/// the token in the query, because a reader sends no header of ours.
struct PanelPdf: View {
    let tab: PanelTab
    @Environment(AppModel.self) private var model
    @State private var document: PDFDocument?
    @State private var failure: String?

    var body: some View {
        Group {
            if let document {
                PdfReader(document: document)
            } else if let failure {
                PanelLine(text: failure)
            } else {
                PanelLine(text: "Reading the PDF…")
            }
        }
        .task(id: tab.key) { await load() }
    }

    private func load() async {
        guard let id = tab.artifact?.id else {
            failure = "That tab has no file behind it."
            return
        }
        do {
            // The bytes are fetched first and the document built from them, rather than
            // handing the reader a URL to fetch on its own: a reader loading the network on
            // the drawing thread is a panel that stops moving while it answers.
            document = PDFDocument(data: try await model.panelData(id))
            if document == nil { failure = "That file is not a PDF this can read." }
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// The viewer itself. Fitting the page to the panel's width is the one thing a reader this
/// size should do on its own; everything else is the person's own movement.
private struct PdfReader: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}
