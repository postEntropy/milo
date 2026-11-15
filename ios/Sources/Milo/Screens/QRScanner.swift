import AVFoundation
import SwiftUI

/**
 The camera, reading the link `milo pair` drew. Its own view controller because a
 capture session is not a `View` and has no business in the app's state; the code
 it reads is handed straight back.
 */
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void
    let onReady: () -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onError = onError
        controller.onReady = onReady
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        var onError: ((String) -> Void)?
        var onReady: (() -> Void)?
        // Only start/stop leave the main actor; their queue preserves ordering.
        private final class CaptureRunner: @unchecked Sendable {
            let session = AVCaptureSession()
            private let queue = DispatchQueue(label: "milo.qr.capture")
            func start(_ completed: @escaping @Sendable (Bool) -> Void) {
                queue.async { self.session.startRunning(); completed(self.session.isRunning) }
            }
            func stop() { queue.async { self.session.stopRunning() } }
        }
        private let runner = CaptureRunner()
        private var session: AVCaptureSession { runner.session }
        private var visible = true
        private var preview: AVCaptureVideoPreviewLayer?
        private var read = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black

            Task { [weak self] in
                let allowed = await AVCaptureDevice.requestAccess(for: .video)
                guard let self, self.visible else { return }
                guard allowed else {
                    self.onError?("Camera access is unavailable. Allow Camera in Settings or enter the pairing address and code manually.")
                    return
                }
                self.configure()
            }
        }

        private func configure() {
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                onError?("Could not open the camera. Enter the pairing address and code manually.")
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                onError?("Could not configure QR scanning. Enter the pairing address and code manually.")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer

            runner.start { [weak self] running in
                Task { @MainActor in
                    guard let self, self.visible else { return }
                    if running { self.onReady?() }
                    else { self.onError?("The camera could not start. Try again or enter the address and code manually.") }
                }
            }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            visible = false
            runner.stop()
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
                runner.stop()
                onCode?(code)
            }
        }
    }
}

/// The scanner as a sheet, with a way out and a word about what to point it at.
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var starting = true
    @State private var scannerID = UUID()

    var body: some View {
        ZStack(alignment: .top) {
            QRScanner(onCode: { code in
                onCode(code)
                dismiss()
            }, onError: { error = $0; starting = false }, onReady: { starting = false })
            .id(scannerID)
            .ignoresSafeArea()

            VStack(spacing: MiloTheme.Space.three) {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Close scanner")
                    .buttonStyle(.glass)
                    .tint(MiloTheme.foreground)
                }
                if starting { ProgressView("Starting camera…").padding().background(MiloTheme.background, in: Capsule()) }
                if let error {
                    Text(error)
                        .font(MiloTheme.Text.body)
                        .padding()
                        .background(MiloTheme.background, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    Button("Try again") { self.error = nil; starting = true; scannerID = UUID() }.buttonStyle(.glass)
                    Button("Enter address and code") { dismiss() }.buttonStyle(.glass)
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }.buttonStyle(.glass)
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
