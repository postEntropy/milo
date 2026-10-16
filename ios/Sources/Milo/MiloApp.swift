import SwiftUI
import UIKit

/**
 The one launch-time hook the app needs. The notification center's delegate has to be
 bound before the app finishes launching: a notification tapped while the app is closed
 is what starts it, and the system hands that tap to the delegate as soon as launch is
 done — bind it any later, which is where a `@State` on the App lands, and the response
 is dropped. That looks like a banner that closes and opens nothing.
 */
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Touching the instance is what binds it: its own `init` makes it the delegate.
        _ = PhoneNotifications.shared
        // The handler the system calls when it takes the turn's continued task. Launch is
        // where a background task's handler belongs: the system can run one before any
        // screen exists.
        ContinuedTurn.shared.register()
        return true
    }
}

@main
struct MiloApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    @AppStorage("appearance") private var appearance = "system"

    private var colorScheme: ColorScheme? {
        switch appearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(MiloTheme.accent)
                .preferredColorScheme(colorScheme)
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
            switch phase {
            case .active:
                // Whatever was being waited for while the phone was away is on the screen
                // now.
                model.becameActive()
                Task { await model.refreshSessions() }
                // The routines too: what the daemon ran while the phone slept is on the
                // list, and the reminders are re-scheduled from it for the next stretch.
                Task { await model.refreshRoutines() }
            case .background:
                // Leaving the screen is the one moment the app can ask the system to stay
                // awake a little longer — which is what the reply notice needs to have
                // anything to say at all.
                model.enteredBackground()
            default:
                break
            }
        }
    }
}
