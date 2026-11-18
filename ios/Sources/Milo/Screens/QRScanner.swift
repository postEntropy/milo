@preconcurrency import AVFoundation
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
        // Capture session setup, start, and stop run on the serial capture queue so
        // AVCaptureSession configuration never blocks the main actor.
        private final class CaptureRunner: @unchecked Sendable {
            let session = AVCaptureSession()
            private let queue = DispatchQueue(label: "milo.qr.capture")
            private var configured = false

            func configureAndStart(
                delegate: AVCaptureMetadataOutputObjectsDelegate,
                onConfigured: @escaping @Sendable (Result<Void, Error>) -> Void,
                onStarted: @escaping @Sendable (Bool) -> Void
            ) {
                queue.async {
                    if !self.configured {
                        guard let device = AVCaptureDevice.default(for: .video) else {
                            onConfigured(.failure(CaptureError.message("Could not open the camera. Enter the pairing address and code manually.")))
                            return
                        }
                        do {
                            let input = try AVCaptureDeviceInput(device: device)
                            self.session.beginConfiguration()
                            defer { self.session.commitConfiguration() }
                            guard self.session.canAddInput(input) else {
                                onConfigured(.failure(CaptureError.message("Could not open the camera. Enter the pairing address and code manually.")))
                                return
                            }
                            self.session.addInput(input)

                            let output = AVCaptureMetadataOutput()
                            guard self.session.canAddOutput(output) else {
                                onConfigured(.failure(CaptureError.message("Could not configure QR scanning. Enter the pairing address and code manually.")))
                                return
                            }
                            self.session.addOutput(output)
                            output.setMetadataObjectsDelegate(delegate, queue: .main)
                            output.metadataObjectTypes = [.qr]
                            self.configured = true
                        } catch {
                            onConfigured(.failure(CaptureError.message("Could not open the camera. Enter the pairing address and code manually.")))
                            return
                        }
                    }
                    onConfigured(.success(()))
                    self.session.startRunning()
                    onStarted(self.session.isRunning)
                }
            }

            func stop() { queue.async { self.session.stopRunning() } }

            private enum CaptureError: LocalizedError {
                case message(String)
                var errorDescription: String? {
                    switch self {
                    case .message(let text): return text
                    }
                }
            }
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

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            visible = true
            read = false
            if preview != nil { configure() }
        }

        private func configure() {
            runner.configureAndStart(
                delegate: self,
                onConfigured: { [weak self] result in
                    Task { @MainActor in
                        guard let self, self.visible else { return }
                        switch result {
                        case .success:
                            if self.preview == nil {
                                let layer = AVCaptureVideoPreviewLayer(session: self.session)
                                layer.videoGravity = .resizeAspectFill
                                layer.frame = self.view.bounds
                                self.view.layer.addSublayer(layer)
                                self.preview = layer
                            }
                        case .failure(let error):
                            self.onError?(error.localizedDescription)
                        }
                    }
                },
                onStarted: { [weak self] running in
                    Task { @MainActor in
                        guard let self, self.visible else { return }
                        if running { self.onReady?() }
                        else { self.onError?("The camera could not start. Try again or enter the address and code manually.") }
                    }
                }
            )
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
