import SwiftUI

struct SessionBackendMark: View {
    let backend: String
    var size: CGFloat = 18

    var body: some View {
        Group {
            if backend == "command-code" {
                ProviderMark(id: "commandcode", size: size)
            } else {
                MiloMark(size: size)
            }
        }
        .accessibilityHidden(true)
    }
}
