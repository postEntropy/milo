import Observation
import SwiftUI

enum MiloPaletteId: String, CaseIterable, Codable, Sendable, Identifiable {
    case terracotta
    case tangerine
    case apricot
    case peach
    case forest
    case mint
    case lime
    case cherry
    case rose
    case ocean
    case lagoon
    case berry
    case violet

    var id: String { rawValue }

    static let defaultPalette: MiloPaletteId = .peach

    static func resolve(_ raw: String?) -> MiloPaletteId {
        guard let raw, let found = MiloPaletteId(rawValue: raw) else {
            return .defaultPalette
        }
        return found
    }

    var preset: MiloPalettePreset {
        MiloPalettePreset.preset(for: self)
    }

    var label: String { preset.label }
}

struct MiloPalettePreset: Sendable {
    let id: MiloPaletteId
    let label: String
    let logoTop: UInt32
    let logoBottom: UInt32
    let lightAccent: UInt32
    let darkAccent: UInt32
    let lightAccentOn: UInt32
    let darkAccentOn: UInt32
    let userBubbleText: UInt32

    var accentColor: Color {
        Color.milo(light: lightAccent, dark: darkAccent)
    }

    var accentOnColor: Color {
        Color.milo(light: lightAccentOn, dark: darkAccentOn)
    }

    static let all: [MiloPalettePreset] = [
        MiloPalettePreset(id: .terracotta, label: "Terracotta", logoTop: 0xA83F1F, logoBottom: 0xD66A3A, lightAccent: 0xA83F1F, darkAccent: 0xCC5A32, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xF6D5C7),
        MiloPalettePreset(id: .tangerine, label: "Tangerine", logoTop: 0xE94B0C, logoBottom: 0xFF9A28, lightAccent: 0xC8430C, darkAccent: 0xDF5B20, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xFFE0C2),
        MiloPalettePreset(id: .apricot, label: "Apricot", logoTop: 0xD96B36, logoBottom: 0xE9AF56, lightAccent: 0xBD5828, darkAccent: 0xD46D3A, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xF9DFC8),
        MiloPalettePreset(id: .peach, label: "Peach", logoTop: 0xD96D5A, logoBottom: 0xF3B18F, lightAccent: 0xC25947, darkAccent: 0xD66B58, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xFFE8D3),
        MiloPalettePreset(id: .forest, label: "Forest", logoTop: 0x315C3B, logoBottom: 0x73A66A, lightAccent: 0x315C3B, darkAccent: 0x4B8354, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xDBEBDD),
        MiloPalettePreset(id: .mint, label: "Mint", logoTop: 0x3D9B83, logoBottom: 0x83CBB0, lightAccent: 0x2B7A65, darkAccent: 0x3B947C, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xD9F0E9),
        MiloPalettePreset(id: .lime, label: "Lime", logoTop: 0x799B22, logoBottom: 0xC0D64F, lightAccent: 0x5E7A18, darkAccent: 0x759624, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xEEF3D4),
        MiloPalettePreset(id: .cherry, label: "Cherry", logoTop: 0xC5294C, logoBottom: 0xF07551, lightAccent: 0xBD284A, darkAccent: 0xD44260, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xF7D6DE),
        MiloPalettePreset(id: .rose, label: "Rose", logoTop: 0xB84F72, logoBottom: 0xE9949C, lightAccent: 0xAE476A, darkAccent: 0xC96082, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xF5D9E4),
        MiloPalettePreset(id: .ocean, label: "Ocean", logoTop: 0x318EA8, logoBottom: 0x58B8A0, lightAccent: 0x27748B, darkAccent: 0x388EA6, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xD8EFF3),
        MiloPalettePreset(id: .lagoon, label: "Lagoon", logoTop: 0x3479C4, logoBottom: 0x54C6C0, lightAccent: 0x2B68AD, darkAccent: 0x4282C8, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xD9EBFC),
        MiloPalettePreset(id: .berry, label: "Berry", logoTop: 0x8F59B8, logoBottom: 0xD85D85, lightAccent: 0x814CA8, darkAccent: 0x9B65C2, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xEBDDFA),
        MiloPalettePreset(id: .violet, label: "Violet", logoTop: 0x6357B8, logoBottom: 0xC16BC4, lightAccent: 0x5A4EAD, darkAccent: 0x7668C9, lightAccentOn: 0xFFFFFF, darkAccentOn: 0xFFFFFF, userBubbleText: 0xE8E0FC),
    ]

    private static let byId: [MiloPaletteId: MiloPalettePreset] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    static func preset(for id: MiloPaletteId) -> MiloPalettePreset {
        byId[id] ?? byId[.peach]!
    }
}

@Observable
final class MiloPaletteStore: @unchecked Sendable {
    var active: MiloPaletteId = MiloPaletteId.resolve(UserDefaults.standard.string(forKey: "milo-palette"))
}

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

    private static let paletteStore = MiloPaletteStore()

    static var activePalette: MiloPaletteId {
        get { paletteStore.active }
        set { paletteStore.active = newValue }
    }

    // The pointer, not a paint.
    static var accent: Color { paletteStore.active.preset.accentColor }
    /// On top of an accent fill — the send control and the primary button.
    static var accentOn: Color { paletteStore.active.preset.accentOnColor }
    /// The words in the person's message, paired with the active accent fill.
    static var userBubbleText: Color { Color.hex(paletteStore.active.preset.userBubbleText) }
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
    static func hex(_ hex: UInt32, opacity: Double = 1) -> Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }

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
