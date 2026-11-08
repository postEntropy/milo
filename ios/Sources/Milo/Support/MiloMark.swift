import SwiftUI
import UIKit

private let markOriginX: CGFloat = 6.0
private let markOriginY: CGFloat = 6.31
private let markSpan: CGFloat = 32.0

struct MiloMark: View {
    var palette: MiloPaletteId? = nil
    var size: CGFloat = 18

    private static func unit(_ x: CGFloat, _ y: CGFloat) -> UnitPoint {
        UnitPoint(x: (x - markOriginX) / markSpan, y: (y - markOriginY) / markSpan)
    }

    var body: some View {
        let preset = (palette ?? MiloTheme.activePalette).preset
        let topStart = Self.unit(34.9329, 16.8512)
        let topEnd = Self.unit(9.06343, 16.8591)
        let bottomStart = Self.unit(9.06729, 27.7055)
        let bottomEnd = Self.unit(34.9362, 27.867)

        ZStack {
            MiloMarkTopShape()
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: Color.hex(preset.logoTop, opacity: 0.8), location: 0),
                            .init(color: Color.hex(preset.logoTop, opacity: 0.5), location: 1),
                        ],
                        startPoint: topStart,
                        endPoint: topEnd
                    )
                )
            MiloMarkBottomShape()
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: Color.hex(preset.logoBottom, opacity: 0.8), location: 0),
                            .init(color: Color.hex(preset.logoBottom, opacity: 0.5), location: 1),
                        ],
                        startPoint: bottomStart,
                        endPoint: bottomEnd
                    )
                )
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Renders the two-shape translucent mark into a `UIImage` with `.alwaysOriginal`
    /// rendering mode so native UIKit menus (`Picker`) display each palette's colours.
    static func menuImage(for palette: MiloPaletteId, size: CGFloat = 22, trailingSpace: CGFloat = 6) -> UIImage {
        let preset = palette.preset
        let rect = CGRect(origin: .zero, size: CGSize(width: size, height: size))
        let canvas = CGSize(width: size + trailingSpace, height: size)
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: canvas, format: format)

        let image = renderer.image { context in
            let cg = context.cgContext
            let space = CGColorSpaceCreateDeviceRGB()

            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(
                    x: (x - markOriginX) / markSpan * rect.width,
                    y: (y - markOriginY) / markSpan * rect.height
                )
            }

            func cgColor(_ hex: UInt32, alpha: CGFloat) -> CGColor {
                let r = CGFloat((hex >> 16) & 0xFF) / 255.0
                let g = CGFloat((hex >> 8) & 0xFF) / 255.0
                let b = CGFloat(hex & 0xFF) / 255.0
                return UIColor(red: r, green: g, blue: b, alpha: alpha).cgColor
            }

            let topPath = MiloMarkTopShape().path(in: rect).cgPath
            if let topGrad = CGGradient(
                colorsSpace: space,
                colors: [cgColor(preset.logoTop, alpha: 0.8), cgColor(preset.logoTop, alpha: 0.5)] as CFArray,
                locations: [0.0, 1.0]
            ) {
                cg.saveGState()
                cg.addPath(topPath)
                cg.clip()
                cg.drawLinearGradient(
                    topGrad,
                    start: pt(34.9329, 16.8512),
                    end: pt(9.06343, 16.8591),
                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
                )
                cg.restoreGState()
            }

            let bottomPath = MiloMarkBottomShape().path(in: rect).cgPath
            if let bottomGrad = CGGradient(
                colorsSpace: space,
                colors: [cgColor(preset.logoBottom, alpha: 0.8), cgColor(preset.logoBottom, alpha: 0.5)] as CFArray,
                locations: [0.0, 1.0]
            ) {
                cg.saveGState()
                cg.addPath(bottomPath)
                cg.clip()
                cg.drawLinearGradient(
                    bottomGrad,
                    start: pt(9.06729, 27.7055),
                    end: pt(34.9362, 27.867),
                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
                )
                cg.restoreGState()
            }
        }
        return image.withRenderingMode(.alwaysOriginal)
    }
}

private struct MiloMarkTopShape: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / markSpan
        let sy = rect.height / markSpan
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(
                x: rect.minX + (x - markOriginX) * sx,
                y: rect.minY + (y - markOriginY) * sy
            )
        }
        var p = Path()
        p.move(to: pt(24.3043, 6.36162))
        p.addCurve(to: pt(34.9329, 16.8512), control1: pt(30.164, 6.35984), control2: pt(34.9311, 11.0477))
        p.addCurve(to: pt(24.3107, 27.3473), control1: pt(34.9347, 22.6548), control2: pt(30.1704, 27.3455))
        p.addCurve(to: pt(16.0437, 23.4493), control1: pt(20.948, 27.3483), control2: pt(18.3243, 26.0127))
        p.addCurve(to: pt(9.47251, 17.6118), control1: pt(14.5743, 21.7978), control2: pt(11.3686, 18.8459))
        p.addCurve(to: pt(9.06354, 16.8449), control1: pt(9.21316, 17.443), control2: pt(9.05882, 17.1536))
        p.addCurve(to: pt(9.49587, 16.091), control1: pt(9.06838, 16.5364), control2: pt(9.23157, 16.2518))
        p.addCurve(to: pt(16.0397, 10.2646), control1: pt(11.4042, 14.9307), control2: pt(14.557, 11.9332))
        p.addCurve(to: pt(24.3043, 6.36162), control1: pt(18.3187, 7.69982), control2: pt(20.9416, 6.36264))
        p.closeSubpath()
        return p
    }
}

private struct MiloMarkBottomShape: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / markSpan
        let sy = rect.height / markSpan
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(
                x: rect.minX + (x - markOriginX) * sx,
                y: rect.minY + (y - markOriginY) * sy
            )
        }
        var p = Path()
        p.move(to: pt(19.758, 17.2788))
        p.addCurve(to: pt(9.06729, 27.7055), control1: pt(13.8984, 17.2424), control2: pt(9.10353, 21.9021))
        p.addCurve(to: pt(19.627, 38.264), control1: pt(9.03105, 33.509), control2: pt(13.7674, 38.2277))
        p.addCurve(to: pt(27.9169, 34.4149), control1: pt(22.9896, 38.2849), control2: pt(25.6212, 36.9648))
        p.addCurve(to: pt(34.5227, 28.6163), control1: pt(29.3961, 32.7721), control2: pt(32.6193, 29.8392))
        p.addCurve(to: pt(34.9362, 27.8518), control1: pt(34.7831, 28.449), control2: pt(34.9391, 28.1605))
        p.addCurve(to: pt(34.5084, 27.0953), control1: pt(34.9332, 27.5432), control2: pt(34.7717, 27.2577))
        p.addCurve(to: pt(27.9993, 21.2304), control1: pt(32.607, 25.9238), control2: pt(29.4721, 22.9077))
        p.addCurve(to: pt(19.758, 17.2788), control1: pt(25.7356, 18.6523), control2: pt(23.1206, 17.2996))
        p.closeSubpath()
        return p
    }
}
