import Foundation
import UserNotifications

/**
 The phone's own reminders. The daemon fires routines, but it cannot reach a closed
 phone — that takes a real push, which takes an Apple Developer account and a server
 that speaks APNs. Instead the app reads the routines and asks the system to raise a
 **local** notification at each one's next fire times. No entitlement and no server
 is needed for that.

 The price is stated plainly: this is a reminder that a routine is *due*, not proof it
 ran. It still comes if `milo serve` is asleep, and it cannot carry the answer — a tap
 opens the app to the run itself.
 */
@MainActor
final class RoutineReminders: NSObject, UNUserNotificationCenterDelegate {
    /// What every reminder's identifier starts with, so the app replaces only its own
    /// and leaves anything else the system holds for it.
    private static let prefix = "routine."
    /// iOS keeps at most 64 pending requests per app. Take the nearest, which are the
    /// ones that matter; the rest arrive on the next sync.
    private static let limit = 60

    private let center = UNUserNotificationCenter.current()
    /// Whether reminders may be raised: nil until the person has been asked.
    private(set) var authorized: Bool?
    /// What a tapped reminder asked to open, handed home by the app.
    var onTap: ((String) -> Void)?

    override init() {
        super.init()
        center.delegate = self
    }

    /// The system's own reading of the permission, without prompting.
    private func status() async -> Bool? {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        case .denied: return false
        default: return nil
        }
    }

    /// Asks once. Safe every time the screen opens: the system prompts only the first
    /// time and the answer is read back after, so a person who said no is not nagged.
    func requestAuthorization() async {
        if await status() == nil {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        authorized = await status()
    }

    /// Replaces what is scheduled with a reminder at each of the routines' next fire
    /// times. The only place the app writes to the notification center, so a routine
    /// that is paused or removed takes its reminders with it.
    func sync(_ routines: [RoutineSummary]) async {
        if authorized == nil { authorized = await status() }

        let mine = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(Self.prefix) }
        center.removePendingNotificationRequests(withIdentifiers: mine)

        guard authorized == true else { return }

        let now = Date().timeIntervalSince1970 * 1000
        let upcoming = routines
            .filter(\.enabled)
            .flatMap { routine in routine.upcoming.filter { $0 > now }.map { (routine: routine, at: $0) } }
            .sorted { $0.at < $1.at }

        for entry in upcoming.prefix(Self.limit) {
            let content = UNMutableNotificationContent()
            content.title = entry.routine.label
            content.body = "Tap to read what it said."
            content.sound = .default
            content.threadIdentifier = Self.prefix + entry.routine.id
            content.userInfo = ["routineId": entry.routine.id]

            let date = Date(timeIntervalSince1970: entry.at / 1000)
            let components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: date
            )
            let request = UNNotificationRequest(
                identifier: "\(Self.prefix)\(entry.routine.id).\(Int(entry.at))",
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            )
            try? await center.add(request)
        }
    }

    // MARK: - The system's own callbacks

    /// A reminder arriving while the app is open is shown as a banner rather than
    /// swallowed: the person still reads that the routine is due.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// A tap carries the routine it names home, so the app opens on it.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let id = response.notification.request.content.userInfo["routineId"] as? String else { return }
        await MainActor.run { onTap?(id) }
    }
}
