import SwiftUI
import UIKit

struct SessionBackendMark: View {
    let backend: String
    var size: CGFloat = 18

    private var miloMark: UIImage? {
        guard let url = Bundle.module.url(forResource: "milo-mark-transparent", withExtension: "png") else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    var body: some View {
        Group {
            if backend == "command-code" {
                ProviderMark(id: "commandcode", size: size)
            } else if let miloMark {
                Image(uiImage: miloMark)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
            }
        }
        .accessibilityHidden(true)
    }
}
