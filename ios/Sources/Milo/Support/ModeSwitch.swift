import SwiftUI

/// Chat or Work: the platform's own segmented control, because this is the shape iOS gives
/// to "two sides of one thing" — one list with two worlds, not a switch of its own invention.
/// The system draws the raised half, its material, its slide and its contrast in both themes.
/// The drawer is its one place: it says which half of the session list is drawn, so choosing
/// the world and reading it are the same control.
struct ModeSwitch: View {
    /// Whether Work is the half in front.
    let work: Bool
    let onChat: () -> Void
    let onWork: () -> Void

    var body: some View {
        Picker("Chat or Work", selection: Binding(
            get: { work },
            set: { next in
                if next { onWork() } else { onChat() }
            }
        )) {
            Text("Chat").tag(false)
            Text("Work").tag(true)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .sensoryFeedback(.selection, trigger: work)
    }
}
