import SwiftUI

/**
 The wait made visible: three dots breathing, with no number running under the
 reader — the elapsed time is said once, settled, when the turn ends.
 */
struct WaitDots: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(MiloTheme.accent)
                    .frame(width: 5, height: 5)
                    .opacity(phase == index ? 0.25 : 1)
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(280))
                withAnimation(.easeInOut(duration: 0.22)) { phase = (phase + 1) % 3 }
            }
        }
        .accessibilityLabel("Milo is working")
    }
}

/// The line that stands in for a turn still being written.
struct WaitLine: View {
    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            WaitDots()
            Text("Thinking")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
        }
    }
}
