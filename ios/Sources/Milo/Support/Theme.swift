import SwiftUI

/**
 The tokens the whole app draws from — one scale for colour, radius and type,
 the same values the terminal and the browser are held to. Nothing here picks a
 size of its own, so a new screen cannot invent a look the others do not have.
 */
enum MiloTheme {
    // Surfaces. The platform's own backgrounds for now, so the app reads as native;
    // the warm palette the browser uses can return by changing these four lines.
    // The accent is a pointer, and everything the person presses is a filled
    // surface rather than an outline.
    static let background = Color(.systemBackground)
    static let surface = Color(.secondarySystemBackground)
    static let surfaceWarm = Color(.tertiarySystemFill)
    static let surfaceRaised = Color(.tertiarySystemBackground)

    // Text.
    static let foreground = Color(.label)
    static let foreground2 = Color(.label).opacity(0.85)
    static let muted = Color(.secondaryLabel)

    // Hairlines — for fields, panels and content chrome; never for a control.
    static let border = Color.milo(light: 0xDED8CB, dark: 0x3A3B34)
    static let borderSoft = Color.milo(light: 0xE7E1D5, dark: 0x32332D)

    // The pointer, not a paint.
    static let accent = Color.milo(light: 0xC4541C, dark: 0xD9703A)
    /// On top of an accent fill — the send control and the primary button.
    static let accentOn = Color.milo(light: 0xFFFFFF, dark: 0xFFFFFF)
    static let secondary = Color.milo(light: 0x508080, dark: 0x6FA3A3)
    static let success = Color.milo(light: 0x587E20, dark: 0x7FA83F)
    static let warning = Color.milo(light: 0x8A6209, dark: 0xC0912A)
    static let danger = Color.milo(light: 0xDA392F, dark: 0xE86A5F)

    enum Radius {
        static let xs: CGFloat = 8
        static let sm: CGFloat = 10
        static let md: CGFloat = 14
        static let lg: CGFloat = 18
        static let xl: CGFloat = 22
    }

    enum Space {
        static let one: CGFloat = 4
        static let two: CGFloat = 8
        static let three: CGFloat = 12
        static let four: CGFloat = 16
        static let five: CGFloat = 20
        static let six: CGFloat = 24
    }

    /// Roles, not sizes: the platform's own ladder, so a screen cannot pick a
    /// type size the rest of the system does not know.
    enum Text {
        static let meta = Font.caption2
        static let small = Font.caption
        static let base = Font.subheadline
        static let body = Font.body
        static let title = Font.title2.weight(.semibold)
        static let mono = Font.system(.subheadline, design: .monospaced)
        /// A call's line, the one monospace a step smaller: the browser sets a tool line
        /// under the code blocks it sits between, and the phone draws the same line at
        /// the same step.
        static let monoSmall = Font.system(.caption, design: .monospaced)
    }
}

extension Color {
    /// A colour that answers to the phone's setting, from the token's light and
    /// dark pair — the same pairing `styles.css` keeps for the browser.
    static func milo(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}
