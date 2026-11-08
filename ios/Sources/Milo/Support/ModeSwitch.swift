import SwiftUI
import UIKit

/// Chat or Work, drawn by the same native segmented control in the drawer and the chat.
struct ModeSwitch: View {
    let work: Bool
    let onChat: () -> Void
    let onWork: () -> Void
    var height: CGFloat = 42

    var body: some View {
        WorldSegments(work: work, height: height, onChat: onChat, onWork: onWork)
            .frame(height: height)
            .glassEffect(.regular.interactive(), in: Capsule())
            .sensoryFeedback(.selection, trigger: work)
    }
}

/// Giving UIKit the actual bounds grows the selected segment along with its surface.
private struct WorldSegments: UIViewRepresentable {
    let work: Bool
    let height: CGFloat
    let onChat: () -> Void
    let onWork: () -> Void

    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: ["Chat", "Work"])
        control.accessibilityLabel = "Chat or Work"
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return control
    }

    func updateUIView(_ control: UISegmentedControl, context: Context) {
        context.coordinator.parent = self
        control.selectedSegmentIndex = work ? 1 : 0
        control.setTitleTextAttributes([.font: UIFont.preferredFont(forTextStyle: .subheadline)], for: .normal)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UISegmentedControl, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? uiView.intrinsicContentSize.width, height: height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject {
        var parent: WorldSegments
        init(_ parent: WorldSegments) { self.parent = parent }

        @objc func changed(_ control: UISegmentedControl) {
            if control.selectedSegmentIndex == 1 { parent.onWork() }
            else { parent.onChat() }
        }
    }
}
