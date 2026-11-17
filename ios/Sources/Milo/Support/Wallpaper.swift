import SwiftUI

enum MiloWallpaperKind: String, CaseIterable, Identifiable {
    case plain
    case mesh

    static let storageKey = "milo-wallpaper"
    static let defaultKind: Self = .mesh

    var id: String { rawValue }

    var label: String {
        switch self {
        case .plain: "Plain"
        case .mesh: "Mesh"
        }
    }
}

/// Atmospheric background built from the active palette's hues over `MiloTheme.background`.
/// Tinted corners give floating Liquid Glass controls something to refract while keeping the
/// reading column nearly plain for prose contrast.
struct MiloWallpaper: View {
    @AppStorage(MiloWallpaperKind.storageKey) private var rawKind = MiloWallpaperKind.defaultKind.rawValue
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme

    private var kind: MiloWallpaperKind {
        MiloWallpaperKind(rawValue: rawKind) ?? .defaultKind
    }

    var body: some View {
        ZStack {
            MiloTheme.background
            if kind == .mesh {
                mesh
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    private var mesh: some View {
        let preset = model.effectivePalette.preset
        let top = Color.hex(preset.logoTop)
        let bottom = Color.hex(preset.logoBottom)
        let accent = preset.accentColor
        let dark = colorScheme == .dark
        let base = MiloTheme.background

        let topWash = top.opacity(dark ? 0.24 : 0.16)
        let bottomWash = bottom.opacity(dark ? 0.18 : 0.15)
        let topSoft = top.opacity(dark ? 0.14 : 0.09)
        let bottomSoft = bottom.opacity(dark ? 0.11 : 0.08)
        let accentSoft = accent.opacity(dark ? 0.12 : 0.08)
        let midSoft = bottom.opacity(dark ? 0.06 : 0.04)

        return MeshGradient(
            width: 3,
            height: 3,
            points: [
                [0.0, 0.0], [0.5, 0.0], [1.0, 0.0],
                [0.0, 0.45], [0.52, 0.48], [1.0, 0.52],
                [0.0, 1.0], [0.5, 1.0], [1.0, 1.0],
            ],
            colors: [
                topWash, bottomSoft, base,
                base, midSoft, topSoft,
                bottomWash, accentSoft, topWash,
            ],
            smoothsColors: true
        )
    }
}

extension View {
    /// Applies the active app wallpaper (or plain `MiloTheme.background`) across full-screen surfaces.
    func miloWallpaperBackground() -> some View {
        background {
            MiloWallpaper()
                .ignoresSafeArea()
        }
    }

    /// Liquid Glass surface for top-level cards sitting over the app canvas.
    func miloGlassCard(
        radius: CGFloat = MiloTheme.Radius.lg,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        let base: Glass = tint.map { Glass.regular.tint($0) } ?? .regular
        let material = interactive ? base.interactive() : base
        return glassEffect(material, in: RoundedRectangle(cornerRadius: radius))
    }
}
