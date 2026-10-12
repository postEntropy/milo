import AVFoundation
import SwiftUI

/**
 The camera, reading the link `milo pair` drew. Its own view controller because a
 capture session is not a `View` and has no business in the app's state; the code
 it reads is handed straight back.
 */
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var read = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black

            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer

            // Starting the session blocks while the camera comes up. It is a
            // short wait, once, on a screen whose whole purpose is the camera.
            session.startRunning()
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            session.stopRunning()
        }

        /// Called on the main queue, which is the queue the output was given.
        nonisolated func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput objects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            MainActor.assumeIsolated {
                // One link is one pairing: stop reading so a second frame cannot
                // start a second claim.
                guard !read else { return }
                read = true
                session.stopRunning()
                onCode?(code)
            }
        }
    }
}

/// The scanner as a sheet, with a way out and a word about what to point it at.
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .top) {
            QRScanner { code in
                onCode(code)
                dismiss()
            }
            .ignoresSafeArea()

            VStack(spacing: MiloTheme.Space.three) {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.glass)
                    .tint(MiloTheme.foreground)
                }
                Text("Point the camera at the QR `milo pair` printed.")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.foreground)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.vertical, MiloTheme.Space.two)
                    .background(MiloTheme.surface.opacity(0.9), in: Capsule())
            }
            .padding(MiloTheme.Space.four)
        }
    }
}
