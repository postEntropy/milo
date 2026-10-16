import BackgroundTasks
import Foundation

/**
 The turn that outlives the screen. iOS suspends an app within seconds of it leaving the
 foreground and takes the socket with it, so a reply can only arrive — and be said — while
 the app is still running: a plain background hold buys about half a minute, and this is
 the API that buys minutes.

 It is the system's own bargain, so its price is stated here. The task can only start from
 a person's action, which is why the request goes out on the send and not when the app
 leaves; the system draws its own progress interface while the work continues, and the
 person can cancel the task from it; and the system can end the task abruptly under
 resource pressure, so a turn longer than it is willing to give outlives it. None of that
 loses the answer — it is on the daemon, and the chat replays it on return — but it does
 mean the notice is not promised for a reply slower than the system's patience.

 What the system asks of the app is the identifier declared in `Info.plist`
 (`BGTaskSchedulerPermittedIdentifiers`), which is the same string built here from the
 app's own bundle id.
 */
@MainActor
final class ContinuedTurn {
    static let shared = ContinuedTurn()

    /// The name this app's task goes by, after its bundle id: `Info.plist` declares the
    /// same string, and both follow `bundleID` in `xtool.yml`.
    private static let name = "reply"

    /// Nil only where the app has no bundle id at all, which is not a thing an installed
    /// app can be.
    private static var identifier: String? {
        Bundle.main.bundleIdentifier.map { "\($0).\(name)" }
    }

    /// How often the count moves. A streaming reply arrives in hundreds of pieces and the
    /// system only needs to see that the work is moving; `Progress` warns that a very
    /// granular count costs, and the count is drawn for nobody — the progress is the
    /// indeterminate kind.
    private static let step: TimeInterval = 1

    /// The task the system granted, while it runs: what progress is reported to, and what
    /// has to be handed back when the turn is over.
    private var task: BGContinuedProcessingTask?
    /// Whether a request is already in flight. One pending request per identifier, and a
    /// second submission over a live one is refused rather than queued.
    private var asked = false
    private var lastStep = Date.distantPast

    /// Binds the handler the system calls when it takes the task. Called once at launch,
    /// and safe to call again: a second registration answers `false` and leaves the first
    /// handler in place.
    func register() {
        guard let identifier = Self.identifier else { return }
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { [weak self] task in
            guard let task = task as? BGContinuedProcessingTask else { return }
            Task { @MainActor in self?.took(task) }
        }
    }

    /// Whether the system is holding the phone on a turn right now.
    var holds: Bool { task != nil }

    /**
     Asks the system for the minutes, on the person's own send. A request the system
     refuses is not said on the screen: what remains is the plain hold this app has always
     taken, so a refusal costs the longer window and nothing else.
     */
    func begin() {
        guard !asked, task == nil, let identifier = Self.identifier else { return }
        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier,
            title: "Milo is replying",
            subtitle: "The answer lands in the chat."
        )
        // Queued rather than failed: the turn is worth starting a little late, and the
        // plain hold covers the wait where the system is too busy to start it at all.
        request.strategy = .queue
        do {
            try BGTaskScheduler.shared.submit(request)
            asked = true
        } catch {
            // Nothing to say: the answer still arrives, and the notice keeps the shorter
            // window it had before any of this existed.
        }
    }

    /// A step of the turn, for the progress the system watches — the one thing the system
    /// ends a task for is a task that reads as stuck. The total is left unpromised on
    /// purpose: nothing here can know how long a turn will take, and a percentage would be
    /// a number made up.
    func advance() {
        guard let task else { return }
        let now = Date()
        guard now.timeIntervalSince(lastStep) >= Self.step else { return }
        lastStep = now
        task.progress.completedUnitCount += 1
    }

    /// The turn is over, or the phone is leaving the conversation it was waiting on: the
    /// system's own interface goes with it, so nothing on the screen still reads as
    /// running.
    func end() {
        asked = false
        lastStep = .distantPast
        if let task {
            self.task = nil
            task.setTaskCompleted(success: true)
        }
        // A request the system queued and never started is taken back too: one that began
        // after the turn was over would hold the phone awake for nothing, and put an
        // interface on the screen for work that had already finished.
        if let identifier = Self.identifier {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        }
    }

    /// The system took the task: the app is kept running from here, and the interface the
    /// person can cancel from appears as soon as the screen goes.
    private func took(_ task: BGContinuedProcessingTask) {
        self.task = task
        lastStep = Date()
        // No total to give, so the progress is the indeterminate kind: it says "working,
        // length unknown" rather than a bar that would have to lie about how far along.
        task.progress.totalUnitCount = -1
        task.expirationHandler = { [weak self] in
            // Reported here, synchronously, and not on a task of its own: the handler is the
            // last moment the task can be wound up before its time is out, and a task left
            // unreported when the time expires is one the system kills the app over — which
            // is what the person sees as the app closing itself.
            MainActor.assumeIsolated { self?.lost() }
        }
    }

    private func lost() {
        guard let task else { return }
        self.task = nil
        asked = false
        lastStep = .distantPast
        // Reported even here, and unsuccessfully, which is the whole reason this handler
        // exists: a task left unreported when its own time runs out is one the system kills
        // the app over, and being killed is what the person sees as the app closing itself.
        task.setTaskCompleted(success: false)
    }
}
