import SwiftUI

/// How hard the model thinks, as one slider with a stop per level. The model picker and
/// the settings page both draw it from here, so the choice is asked in one shape.
///
/// The levels are the daemon's own list, sent with the handshake. The thumb moves to the
/// level's index, and the level it sits on is spelled in the screen's own ink while its
/// siblings stay muted — the stops are the reading of the position, not a second control.
struct ReasoningSlider: View {
    let efforts: [String]
    let value: String
    let onChange: (String) -> Void

    @ViewBuilder var body: some View {
        if !efforts.isEmpty {
            VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                Slider(value: position, in: 0...Double(max(efforts.count - 1, 1)), step: 1) {
                    Text("Reasoning effort")
                }
                .tint(MiloTheme.accent)
                .overlay {
                    GeometryReader { geometry in
                        let index = efforts.firstIndex(of: value) ?? 0
                        let travel = max(0, geometry.size.width - 30)
                        let progress = CGFloat(index) / CGFloat(max(efforts.count - 1, 1))
                        ZStack(alignment: .leading) {
                            Capsule().fill(MiloTheme.surfaceRaised).frame(height: 26)
                            Capsule().fill(MiloTheme.accent)
                                .frame(width: 15 + travel * progress, height: 26)
                            ForEach(Array(efforts.enumerated()), id: \.offset) { stop, _ in
                                if stop != index {
                                    Circle()
                                        .fill(stop < index ? Color.white.opacity(0.7) : MiloTheme.muted.opacity(0.6))
                                        .frame(width: 4, height: 4)
                                        .offset(x: 13 + travel * CGFloat(stop) / CGFloat(max(efforts.count - 1, 1)))
                                }
                            }
                            Circle().fill(.white).frame(width: 30, height: 30)
                                .shadow(color: .black.opacity(0.25), radius: 3, y: 2)
                                .offset(x: travel * progress)
                        }
                        .frame(height: geometry.size.height)
                    }
                    .background(MiloTheme.surface)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                .disabled(efforts.count < 2)
                .accessibilityValue(SettingsWording.of(value))
                .sensoryFeedback(.selection, trigger: value)

                HStack(spacing: 0) {
                    ForEach(efforts, id: \.self) { level in
                        Text(SettingsWording.of(level))
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(level == value ? MiloTheme.foreground : MiloTheme.muted)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
            }
        }
    }

    /// The thumb is the level's index in the daemon's list; a drag writes only when it
    /// lands on a different level, so resting on the one set asks the daemon nothing.
    private var position: Binding<Double> {
        Binding(
            get: { Double(efforts.firstIndex(of: value) ?? 0) },
            set: { next in
                let index = Int(next.rounded())
                guard efforts.indices.contains(index), efforts[index] != value else { return }
                onChange(efforts[index])
            }
        )
    }
}
