import SwiftUI

/**
 The controls a session answers to, wherever they are offered: the press on its own row
 in the drawer, and the dots beside the new-session control in the session's own header.
 One declaration, so the two cannot drift — and the browser's own three, in the browser's
 own order.
 */
@ViewBuilder
func sessionActions(
    onRename: @escaping () -> Void,
    onExport: @escaping () -> Void,
    onDelete: @escaping () -> Void
) -> some View {
    Button(action: onRename) { menuLine("Rename", "pencil") }
    Button(action: onExport) { menuLine("Export", "arrow.down.doc") }
    Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
}

/**
 Renaming, wherever it is asked for: one alert, one starting point, one call. Presented
 with the id of the session to rename, nil for none, so a surface only has to name one.
 */
struct SessionRename: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var id: String?
    @State private var draft = ""

    func body(content: Content) -> some View {
        content
            .alert("Rename session", isPresented: showing) {
                TextField("Name", text: $draft)
                Button("Save") {
                    if let id { Task { await model.rename(id, to: draft) } }
                    id = nil
                }
                Button("Cancel", role: .cancel) { id = nil }
            }
            // Seeded as the alert opens: the words the session already goes by, or the
            // ones it opened with — the browser's own starting point, and never the
            // label a row shows, which stands in words for a session that has none. A
            // session the list has not caught up with leaves the field empty rather
            // than holding what the last rename left in it.
            .onChange(of: id) { _, named in
                guard let named else { return }
                let session = model.sessions.first { $0.id == named }
                draft = session?.title ?? session?.preview ?? ""
            }
    }

    private var showing: Binding<Bool> {
        Binding(get: { id != nil }, set: { if !$0 { id = nil } })
    }
}

extension View {
    /// Lets a surface offer renaming by naming the session, and hold nothing else.
    func sessionRename(_ id: Binding<String?>) -> some View {
        modifier(SessionRename(id: id))
    }
}
