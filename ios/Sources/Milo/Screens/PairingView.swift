import SwiftUI

/// Pairing: scan the QR `milo pair` draws, or type the address and the code. The
/// scan is the friendlier half and comes first — the address is the part nobody
/// wants to type.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(MiloTheme.accentOn)
                        .frame(width: 64, height: 64)
                        .background(MiloTheme.accent, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
                        .padding(.bottom, MiloTheme.Space.two)
                    Text("Milo")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(MiloTheme.foreground)
                    Text("Pair this phone with the Milo daemon on your machine.")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.foreground2)
                }
                .padding(.top, MiloTheme.Space.six)

                MiloWideButton(
                    title: "Scan the QR from milo pair",
                    systemImage: "qrcode.viewfinder",
                    glass: true
                ) {
                    scanning = true
                }

                Text("or type it")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)

                VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                    MiloField(
                        label: "Address",
                        text: $model.pairingHost,
                        placeholder: "192.168.1.20:7717",
                        keyboard: .URL
                    )
                    MiloField(
                        label: "Code",
                        text: $model.pairingCode,
                        placeholder: "000000",
                        keyboard: .numberPad
                    )
                }

                if let error = model.pairingError {
                    Text(error)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                MiloWideButton(
                    title: model.pairing ? "Pairing…" : "Pair",
                    primary: true,
                    glass: true,
                    busy: model.pairing
                ) {
                    Task { await model.pair() }
                }
                .disabled(model.pairingCode.isEmpty || model.pairingHost.isEmpty)

                Text("Run `milo pair` on your machine. The address it prints is the tailnet or LAN one, never 127.0.0.1 — the phone has to reach it.")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            }
            .padding(MiloTheme.Space.five)
        }
        .scrollBounceBehavior(.basedOnSize)
        .sheet(isPresented: $scanning) {
            QRScannerSheet { code in
                Task { await model.pair(scanned: code) }
            }
        }
    }
}
