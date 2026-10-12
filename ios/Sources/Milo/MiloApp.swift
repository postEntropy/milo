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
    }
}
