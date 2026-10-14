import SwiftUI

@main
struct MiloApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(MiloTheme.accent)
        }
    }
}

/// Pairing until a device is paired, the chat after — the one fork the app has.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            MiloTheme.background.ignoresSafeArea()
            switch model.phase {
            case .pairing:
                PairingView()
            case .chat(let account):
                ChatView(account: account)
            }
        }
        .task { await model.load() }
        // Coming back to the app is when another surface's work is most likely to be
        // waiting: the sessions are re-read on wake, so one started on the computer is
        // in the drawer the moment it opens. Nothing pushes them — the list is pulled.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.refreshSessions() }
            // The routines too: what the daemon ran while the phone slept is on the
            // list, and the reminders are re-scheduled from it for the next stretch.
            Task { await model.refreshRoutines() }
        }
    }
}
