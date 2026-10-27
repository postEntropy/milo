import SwiftUI

/**
 The tokens the whole app draws from — one scale for colour, radius and type,
 the same values the terminal and the browser are held to. Nothing here picks a
 size of its own, so a new screen cannot invent a look the others do not have.
 */
enum MiloTheme {
    // Surfaces. The platform's own backgrounds, so the app reads as native; the one tone the
    // browser also draws on is spelled out below, and the rest can follow the same way.
    // The accent is a pointer, and everything the person presses is a filled
    // surface rather than an outline.
    static let background = Color(.systemBackground)
    static let surface = Color(.secondarySystemBackground)
    /// The ground code is read on — a fenced block, a tool's output, a diff of one. The
    /// browser's own `--surface-warm`, because those boxes are read on both surfaces: a
    /// translucent system fill is not a ground at all, it takes the tone of whatever stands
    /// behind it.
    static let surfaceWarm = Color.milo(light: 0xF2F2F4, dark: 0x161617)
    static let surfaceRaised = Color(.tertiarySystemBackground)

    /// What the travelling chat casts on the sessions behind it, at the seam where the
    /// two layers meet — the shadow belongs to the layer on top. A dark page leaves a
    /// shadow almost nothing to darken, so it takes a heavier alpha there: the same
    /// pairing the browser keeps for its own `--shadow-seam`.
    static let seamShadow = Color(UIColor { traits in
        UIColor.black.withAlphaComponent(traits.userInterfaceStyle == .dark ? 0.6 : 0.18)
    })

    // Text.
    static let foreground = Color(.label)
    static let foreground2 = Color(.label).opacity(0.85)
    static let muted = Color(.secondaryLabel)
    /// A step under `muted`, for a line that has to be quieter than the platform's own
    /// secondary still allows. A fixed light/dark pair rather than an opacity on `label`:
    /// an opacity blends toward the page, so it would dim in the dark and turn pale in the
    /// light, where this darkens in both.
    static let muted2 = Color.milo(light: 0x5A5A61, dark: 0x87878F)

    // Hairlines — for fields, panels and content chrome; never for a control.
    static let border = Color.milo(light: 0xDED8CB, dark: 0x3A3B34)
    static let borderSoft = Color.milo(light: 0xE7E1D5, dark: 0x32332D)

    // The pointer, not a paint.
    static let accent = Color.milo(light: 0xC4541C, dark: 0xD9703A)
    /// On top of an accent fill — the send control and the primary button.
    static let accentOn = Color.milo(light: 0xFFFFFF, dark: 0xFFFFFF)
    /// The words in the person's message: a warm tint that sits more gently on the
    /// orange bubble than white, while staying light in both appearances.
    static let userBubbleText = Color.milo(light: 0xFFE8D3, dark: 0xFFE8D3)
    static let secondary = Color.milo(light: 0x508080, dark: 0x6FA3A3)
    static let success = Color.milo(light: 0x587E20, dark: 0x7FA83F)
    /// The green a control is filled with, lighter than the `success` a status dot is read
    /// off, and the ink that reads on it — the browser's own pairing for a light fill,
    /// which is why its second appearance pairs that green with a near-black.
    static let successSoft = Color.milo(light: 0x91BC4E, dark: 0x9FBD70)
    static let successOn = Color.milo(light: 0x191A18, dark: 0x191A18)
    static let warning = Color.milo(light: 0x8A6209, dark: 0xC0912A)
    static let danger = Color.milo(light: 0xDA392F, dark: 0xE86A5F)

    // The roles code is coloured by (`src/core/highlight.ts`, ported in `ios/Highlight`). A
    // comment is the page's own quiet text and plain code is what code already was; the three
    // hues are deliberately none of the tones above — the accent is a pointer, and green and
    // red are the diff's own wash, where a coloured line sits.
    static let codeKeyword = Color.milo(light: 0x8A4E86, dark: 0xC79AD0)
    static let codeString = Color.milo(light: 0x2E6FA8, dark: 0x7FB2E8)
    static let codeNumber = Color.milo(light: 0xA9740F, dark: 0xD6A23A)

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

    /// How much extra space a line of reading text gets, in points. The platform's own
    /// leading is about 1.3× the size of the body and the browser reads its prose at 1.65×;
    /// this is 1.5×, which is what those three and a half points come to at 17pt.
    static let leading: CGFloat = 3.5

    /// The margin the reading column and the bars above and below it share, so the text,
    /// the composer and the controls line up on the same two edges.
    static let margin: CGFloat = Space.five

    /// Roles, not sizes: the platform's own ladder, so a screen cannot pick a
    /// type size the rest of the system does not know.
    enum Text {
        static let meta = Font.caption2
        static let small = Font.caption
        static let base = Font.subheadline
        static let body = Font.body
        static let title = Font.title2.weight(.semibold)
        /// The code every surface draws — a fenced block in a reply, a diff's line, a tool's
        /// output, a file read back. Two steps under the body: monospace sets wider than the
        /// reading face at the same size, and the box it is drawn in is the narrowest one on
        /// the screen, so this is the step that reads level with the prose around it.
        static let mono = Font.system(.footnote, design: .monospaced)
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
