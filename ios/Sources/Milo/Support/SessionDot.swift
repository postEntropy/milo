import SwiftUI

/**
 The mark a session wears at the row's edge, wherever a list draws one.

 A dot that breathes says a turn is running there right now; a dot standing still says
 the session moved after it was last looked at, and there is something to read. One view
 so the drawer, a project's page and the card a long press lifts cannot drift — and so
 the motion is switched off for a person who asked the system for less of it.
 */
struct SessionDot: View {
    enum State {
        case running
        case unread
    }

    let state: State
    var size: CGFloat = 7

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    var body: some View {
        Circle()
            .fill(MiloTheme.accent)
            .frame(width: size, height: size)
            .opacity(dimmed ? 0.45 : 1)
            .animation(pulse, value: dimmed)
            .onAppear { dimmed = state == .running && !reduceMotion }
            .onChange(of: state) { _, next in dimmed = next == .running && !reduceMotion }
            .accessibilityLabel(state == .running ? "Running" : "Unread")
    }

    /// The breath the running dot takes: slow, endless, and none at all when motion is
    /// reduced — the still dot is then the only difference between the two states.
    private var pulse: Animation? {
        state == .running && !reduceMotion
            ? .easeInOut(duration: 1.8).repeatForever(autoreverses: true)
            : nil
    }
}

/**
 The mark a session's row wears, read off the session's own state: one dot, never two.
 Running outranks unread — it is the newer news — so a session that is both drawing a turn
 and holding something unread reads as running until the turn ends.
 */
struct SessionMark: View {
    var running: Bool?
    var unread: Bool?
    var size: CGFloat = 7

    var body: some View {
        if running == true {
            SessionDot(state: .running, size: size)
        } else if unread == true {
            SessionDot(state: .unread, size: size)
        }
    }
}
