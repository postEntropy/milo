import Foundation
import UIKit
import UserNotifications

/**
 The phone's own notifications, in one place because the system gives an app a single
 delegate and a single permission: the reminders the app schedules from the routines,
 and the banner that says Milo answered while the app was off screen.

 The daemon fires routines and writes the answers, but it cannot reach a closed phone —
 that takes a real push, which takes an Apple Developer account and a server that speaks
 APNs. Everything here is a **local** notification, raised by the app itself: no
 entitlement and no server needed for that.

 Each one pays a price, and both are stated plainly. A routine reminder is a reminder
 that a routine is *due*, not proof it ran: it still comes if `milo serve` is asleep,
 and it cannot carry the answer — a tap opens the app to the run itself. A reply notice
 can only be raised while the app is still running, so it covers a reply that lands
 inside the stretch of background time the chat holds open for a turn (see `AppModel`),
 about half a minute after leaving the screen; an answer that arrives later is read on
 return, with no banner. Neither is a substitute for a push.
 */
@MainActor
final class PhoneNotifications: NSObject, UNUserNotificationCenterDelegate {
    /// The instance the app holds. It is the notification center's delegate, and that
    /// reference is weak — so the object has to be alive, and bound, by the time the
    /// app finishes launching: a notification tapped while the app is closed is what
    /// starts it, and the system hands that tap over the moment launch is done.
    static let shared = PhoneNotifications()

    /// The key the reply notice's switch is stored under, read here and written by the
    /// settings screen's control: one string, so the reading and the writing cannot come
    /// to name two different keys.
    static let replySetting = "notify-on-reply"

    /// What every reminder's identifier starts with, so the app replaces only its own
    /// and leaves anything else the system holds for it. The reply notices carry a name
    /// of their own — one identifier each, grouped as their own thread — so a routine
    /// sync never takes one of them away.
    private static let prefix = "routine."
    private static let reply = "reply"
    /// iOS keeps at most 64 pending requests per app. Take the nearest, which are the
    /// ones that matter; the rest arrive on the next sync.
    private static let limit = 60
    /// How much of a reply a banner carries. A banner shows a few lines and is cut off
    /// without asking, so the words are cut here instead — at a word.
    private static let replyWords = 160

    private let center = UNUserNotificationCenter.current()

    /// What a tap named, and where it is to be opened: a routine reminder carries the
    /// routine, a reply notice the session its answer is in.
    enum Tapped: Equatable {
        case routine(String)
        case session(String)
    }

    /// What a tap named, kept until the app claims it. A tap that *launched* the app
    /// arrives before anything of the app is listening — the same race that has the
    /// delegate bound at launch — and a tap handed to nobody is a notification that opens
    /// nothing at all.
    private(set) var pendingTap: Tapped?
    /// What a tap named, handed home by the app while it is listening.
    var onTap: ((Tapped) -> Void)?

    override private init() {
        super.init()
        center.delegate = self
    }

    /// Hands a tap home, and keeps it for an app that is not listening yet.
    private func hand(_ named: Tapped) {
        pendingTap = named
        onTap?(named)
    }

    /// Takes what a tap named, where the app had not claimed it yet.
    func takePendingTap() -> Tapped? {
        defer { pendingTap = nil }
        return pendingTap
    }

    /// Whether the reply notice is on. A decision about this phone's own screen rather
    /// than about the install — no other surface can raise a banner on this device — so
    /// the switch that moves it lives on the phone.
    var replyNoticeOn: Bool {
        UserDefaults.standard.bool(forKey: Self.replySetting)
    }

    /// The system's own reading of the permission, without prompting: nil until the
    /// person has been asked at least once.
    func authorization() async -> Bool? {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        case .denied: return false
        default: return nil
        }
    }

    /// Asks once, and answers with the system's reading either way. Safe every time a
    /// screen opens: the system prompts only the first time, so a person who said no is
    /// not nagged.
    @discardableResult
    func requestAuthorization() async -> Bool? {
        if await authorization() == nil {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        return await authorization()
    }

    /// The banner that says Milo answered, carrying the first of the reply's own words and
    /// the session they landed in. Raised only where the app is not on screen — `AppModel`
    /// decides that, since it is the one that knows whether the answer is already in front
    /// of the person.
    func notifyReply(_ words: String, session: String) async {
        guard await authorization() == true else { return }
        let said = Self.snippet(words)
        guard !said.isEmpty else { return }

        let content = UNMutableNotificationContent()
        content.title = "Milo replied"
        content.body = said
        content.sound = .default
        content.threadIdentifier = Self.reply
        // Which session the answer is in, so a tap opens onto that answer: an app that
        // opened on the fresh session it starts by default would hide the very reply the
        // notice was about.
        if !session.isEmpty { content.userInfo = ["sessionId": session] }
        // No trigger: a notice that a reply has landed is worth nothing later, so it is
        // handed to the system at once.
        let request = UNNotificationRequest(
            identifier: "\(Self.reply).\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        try? await center.add(request)
    }

    /// Replaces what is scheduled with a reminder at each of the routines' next fire
    /// times. The only place the app writes the routine reminders, so a routine that is
    /// paused or removed takes its reminders with it.
    func sync(_ routines: [RoutineSummary]) async {
        let mine = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(Self.prefix) }
        center.removePendingNotificationRequests(withIdentifiers: mine)

        guard await authorization() == true else { return }

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

    /// A reply's words as much as a banner can carry: the lines flattened into one run,
    /// and the tail cut at a word rather than through one.
    private static func snippet(_ words: String) -> String {
        let flattened = words.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard flattened.count > replyWords else { return flattened }
        let head = flattened.prefix(replyWords)
        let cut = head.lastIndex(of: " ").map { String(head[..<$0]) } ?? String(head)
        return cut + "…"
    }

    // MARK: - The system's own callbacks

    /*
     Both of these are the framework's own completion-handler forms rather than the `async`
     ones, and both hand their work to the app on a task instead of doing it in the call.
     That is not a style choice: UIKit delivers a notification tap from inside its own block
     — `_performBlockAfterCATransactionCommitSynchronizes:`, part of its
     snapshot/state-restoration path — and a callback that suspends inside that block (an
     `async` method with an `await` in it) is one its assertion handler aborts on. It was
     exactly that abort, `SIGABRT` out of `userNotificationCenter(_:didReceive:)`, that
     closed the app when a reply's notice was tapped.
     */

    /// A notification arriving while the app is open is shown as a banner rather than
    /// swallowed: the person still reads that the routine is due.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// A tap carries what it named home, so the app opens on it: a routine reminder names
    /// the routine, and a reply notice names the session its answer is in.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let named = response.notification.request.content.userInfo
        if let id = named["routineId"] as? String {
            Task { @MainActor in hand(.routine(id)) }
        } else if let id = named["sessionId"] as? String {
            Task { @MainActor in hand(.session(id)) }
        }
        completionHandler()
    }
}
