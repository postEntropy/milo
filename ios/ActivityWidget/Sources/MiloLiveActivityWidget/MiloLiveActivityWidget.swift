import ActivityKit
import MiloActivity
import SwiftUI
import UIKit
import WidgetKit

@main
struct MiloLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MiloActivityAttributes.self) { context in
            HStack(spacing: 12) {
                MiloMark()
                VStack(alignment: .leading, spacing: 3) {
                    Text("Milo")
                        .font(.headline)
                    Text(context.state.label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if context.state.phase != .complete {
                    ProgressView()
                        .tint(.secondary)
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
            .padding(.horizontal, 18)
            .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
            .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    MiloMark()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.phase == .complete {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    } else {
                        ProgressView()
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text("Milo")
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                MiloMark()
            } compactTrailing: {
                if context.state.phase == .complete {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.green)
                } else {
                    ProgressView()
                }
            } minimal: {
                MiloMark()
            }
            .keylineTint(.accentColor)
        }
    }
}

private struct MiloMark: View {
    var body: some View {
        Image(systemName: "sparkle")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.tint)
            .frame(width: 28, height: 28)
            .background(.tint.opacity(0.14), in: Circle())
    }
}

private extension MiloActivityAttributes.ContentState {
    var label: String {
        switch phase {
        case .thinking: "Thinking"
        case .replying: "Writing a reply"
        case .complete: "Reply complete"
        }
    }
}
