import SwiftUI
import UIKit

/// A labelled field. Fields carry a border — the house style reserves borders for
/// fields, panels and content, never for something you press.
struct MiloField: View {
    let label: String
    @Binding var text: String
    var placeholder: String = ""
    var keyboard: UIKeyboardType = .default

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text(label)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
            TextField(placeholder, text: $text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.foreground)
                .padding(.horizontal, MiloTheme.Space.five)
                .padding(.vertical, MiloTheme.Space.three)
                .background(MiloTheme.surface, in: Capsule())
                .overlay(Capsule().stroke(MiloTheme.borderSoft, lineWidth: 1))
        }
    }
}

/// An icon control, filled and tight: the glyph is sized to the control it sits
/// in, and nothing is drawn around it — no rim, no chrome of its own.
struct MiloIconButton: View {
    let systemName: String
    var size: CGFloat = 18
    var span: CGFloat = 40
    var primary = false
    /// Liquid Glass instead of a filled disc: the way a control floats over content.
    var glass = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(primary ? MiloTheme.accentOn : MiloTheme.foreground)
                .frame(width: span, height: span)
                .background {
                    if !glass { Circle().fill(primary ? MiloTheme.accent : MiloTheme.surface) }
                }
                .glassEffect(glass ? .regular.interactive() : .identity, in: Circle())
        }

        .buttonStyle(PressableStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
    }
}

/// A line in a menu: its words, its mark, and the tone the mark is told to wear.
///
/// A menu paints the mark of every item with the surface's tint — the accent, which this
/// app spends on the pointer and on nothing else — and it reads that tone off the *button*
/// the item is made of, not off the mark inside it: a mark given a colour of its own comes
/// out orange anyway. So the line is declared whole here, button and all, and no call site
/// can hand over a mark the menu will not listen to.
///
/// A destructive line is left to the platform instead: there the red *is* the words' own
/// colour, and the mark is drawn in it.
func menuItem(
    _ title: String,
    _ symbol: String,
    disabled: Bool = false,
    action: @escaping () -> Void
) -> some View {
    Button(action: action) {
        Label {
            Text(title)
        } icon: {
            Image(systemName: symbol)
        }
    }
    .tint(MiloTheme.foreground)
    .disabled(disabled)
}

/// The press every filled control shares: it gives a little under the finger and
/// springs back, so a tap is felt without drawing anything around the control.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

/// A full-width control on a plain screen — the platform's own glass, like every control here.
struct MiloWideButton: View {
    let title: String
    var systemImage: String?
    /// Wearing the accent as its tint: the screen's primary action rather than one that only
    /// goes somewhere.
    var primary = false
    var busy = false
    let action: () -> Void

    private var shape: Capsule { Capsule() }

    private var material: Glass {
        (primary ? Glass.regular.tint(MiloTheme.accent) : .regular).interactive()
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: MiloTheme.Space.two) {
                if busy { ProgressView().controlSize(.small) }
                if let systemImage { Image(systemName: systemImage) }
                Text(title)
            }
            .font(MiloTheme.Text.base)
            .foregroundStyle(primary ? MiloTheme.accentOn : MiloTheme.foreground)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .glassEffect(material, in: shape)
        }
        .buttonStyle(PressableStyle())
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
    }
}
