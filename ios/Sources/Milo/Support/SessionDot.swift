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
    @State private var pulsing = false

    var body: some View {
        ZStack {
            if state == .running && !reduceMotion {
                Circle()
                    .fill(MiloTheme.accent.opacity(0.35))
                    .frame(width: size * 1.8, height: size * 1.8)
                    .scaleEffect(pulsing ? 1.3 : 0.8)
                    .opacity(pulsing ? 0 : 0.8)
            }
            Circle()
                .fill(MiloTheme.accent)
                .frame(width: size, height: size)
                .scaleEffect(state == .running && !reduceMotion ? (pulsing ? 1.05 : 0.95) : 1)
        }
        .frame(width: size * 1.8, height: size * 1.8)
        .onAppear {
            if state == .running && !reduceMotion {
                withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
        }
        .onChange(of: state) { _, next in
            if next == .running && !reduceMotion {
                withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            } else {
                pulsing = false
            }
        }
        .accessibilityLabel(state == .running ? "Running" : "Unread")
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
