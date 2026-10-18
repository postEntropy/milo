import SwiftUI

/// A refusal, said once, in the platform's own glass — worn the way every control here is,
/// tinted with the colour that means it went wrong. Shared by the screens that read from
/// the daemon and can be refused: the same sentence must not be drawn two ways.
struct MiloErrorPill: View {
    let text: String

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.danger)
                Text(text)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.danger)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.two)
            .glassEffect(.regular.tint(MiloTheme.danger.opacity(0.28)), in: Capsule())
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
