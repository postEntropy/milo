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
                .padding(.horizontal, MiloTheme.Space.four)
                .padding(.vertical, MiloTheme.Space.three)
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                        .stroke(MiloTheme.borderSoft, lineWidth: 1)
                )
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

/// A menu line and its mark. The mark keeps the tone of the words beside it: a menu is
/// not where the accent points at anything, and a list of tinted glyphs is paint. A
/// destructive line is drawn as a plain `Label` instead — there the red *is* the words'
/// own colour, and a mark set apart from them would sit grey beside red.
func menuLine(_ title: String, _ symbol: String) -> some View {
    Label {
        Text(title)
    } icon: {
        Image(systemName: symbol).foregroundStyle(MiloTheme.foreground)
    }
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

/// A full-width filled control — the shape an action takes on a plain screen.
struct MiloWideButton: View {
    let title: String
    var systemImage: String?
    var primary = false
    var busy = false
    let action: () -> Void

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
            .background(
                primary ? MiloTheme.accent : MiloTheme.surface,
                in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
            )
        }
        .buttonStyle(PressableStyle())
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
    }
}
