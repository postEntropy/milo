@preconcurrency import ActivityKit
import MiloActivity
import OSLog

@MainActor
final class MiloLiveActivityController {
    private static let logger = Logger(subsystem: "dev.milo.app", category: "LiveActivity")
    private var activity: Activity<MiloActivityAttributes>?

    func start(sessionID: String) async {
        guard !sessionID.isEmpty, ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        if activity == nil {
            activity = Activity<MiloActivityAttributes>.activities.first {
                $0.attributes.sessionID == sessionID
            }
        }
        guard activity == nil else {
            await update(.thinking)
            return
        }

        let attributes = MiloActivityAttributes(sessionID: sessionID)
        let content = ActivityContent(
            state: MiloActivityAttributes.ContentState(phase: .thinking),
            staleDate: nil
        )
        do {
            activity = try Activity.request(attributes: attributes, content: content, pushType: nil)
        } catch {
            Self.logger.error("Could not start the turn Live Activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    func update(_ phase: MiloActivityAttributes.ContentState.Phase) async {
        guard let activity else { return }
        let content = ActivityContent(
            state: MiloActivityAttributes.ContentState(phase: phase),
            staleDate: nil
        )
        await activity.update(content)
    }

    func finish() async {
        guard let activity else { return }
        let content = ActivityContent(
            state: MiloActivityAttributes.ContentState(phase: .complete),
            staleDate: nil
        )
        await activity.end(content, dismissalPolicy: .after(.now + 8))
        self.activity = nil
    }
}
