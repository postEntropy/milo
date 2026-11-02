import SwiftUI
import UIKit

/**
 The mark a provider wears in a picker. Command Code and OpenRouter carry their
 own colour — the Command Code tile and the routing mark — so they are drawn as
 they are. The rest are templates and follow the theme's ink. A provider with no
 mark of its own falls back to a symbol, never to a blank.
 */
struct ProviderMark: View {
    let id: String
    var size: CGFloat = 22

    var body: some View {
        Group {
            if let image = Self.image(id) {
                Image(uiImage: image)
                    .renderingMode(Self.keepsColour(id) ? .original : .template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
            } else {
                Image(systemName: "cpu")
                    .font(.system(size: size * 0.78, weight: .semibold))
                    .frame(width: size, height: size)
            }
        }
        .foregroundStyle(MiloTheme.foreground)
        .accessibilityHidden(true)
    }

    /// The image for a provider, read straight from the module bundle. `Image`'s
    /// named lookup does not find a plain PNG in a SwiftPM resource bundle on
    /// iOS; the file URL does.
    private static func image(_ id: String) -> UIImage? {
        guard let asset = asset(id),
              let url = Bundle.module.url(forResource: asset, withExtension: "png")
        else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    /// The asset for a provider id, or nothing when the set has no mark for it.
    private static func asset(_ id: String) -> String? {
        switch id {
        case "commandcode": return "provider-commandcode"
        case "openai", "chatgpt": return "provider-openai"
        case "anthropic": return "provider-anthropic"
        case "openrouter": return "provider-openrouter"
        case "ollama": return "provider-ollama"
        case "opencode": return "provider-opencode"
        default: return nil
        }
    }

    /// Marks whose colour is part of the mark, rather than borrowed from the row.
    private static func keepsColour(_ id: String) -> Bool {
        id == "commandcode" || id == "openrouter"
    }
}
