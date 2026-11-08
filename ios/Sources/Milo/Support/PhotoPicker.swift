import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The platform's own photo chooser, drawn by the system over this screen and answering with
/// the pictures the person picked.
///
/// `PhotosPicker` is the SwiftUI door to this same sheet, and it is spelled in a cross-import
/// overlay — `_PhotosUI_SwiftUI` — that this project's build does not put on the module map,
/// so the overlay never loads and the type is not in scope. The picker is reached directly
/// instead: the same controller SwiftUI would have presented, and the same sheet either way.
struct PhotoPicker: UIViewControllerRepresentable {
    /// How many pictures may be picked at once. Zero is as many as the person likes.
    var limit = 0
    let onPick: ([NSItemProvider]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = limit
        // The bytes the picture already has, rather than the picker's own transcode of it:
        // a photo the daemon never needs re-encoded should not be re-encoded on the way out.
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    /// The sheet's own delegate. The choice is handed on; whether the sheet is up at all
    /// belongs to the binding that raised it, so there is one account of that and not two.
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onPick: ([NSItemProvider]) -> Void

        init(onPick: @escaping ([NSItemProvider]) -> Void) {
            self.onPick = onPick
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            onPick(results.map(\.itemProvider))
        }
    }
}

/// The platform's camera capture controller, opened full-screen from the attachment sheet's
/// camera tile and returning the captured image as an `AttachmentDraft`.
struct CameraPicker: UIViewControllerRepresentable {
    let onPick: (AttachmentDraft?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let onPick: (AttachmentDraft?) -> Void

        init(onPick: @escaping (AttachmentDraft?) -> Void) {
            self.onPick = onPick
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let raw = info[.originalImage] as? UIImage else {
                onPick(nil)
                return
            }
            let image: UIImage
            if raw.imageOrientation == .up {
                image = raw
            } else {
                let format = UIGraphicsImageRendererFormat()
                format.scale = raw.scale
                image = UIGraphicsImageRenderer(size: raw.size, format: format).image { _ in
                    raw.draw(in: CGRect(origin: .zero, size: raw.size))
                }
            }
            guard let data = image.jpegData(compressionQuality: 0.9) else {
                onPick(nil)
                return
            }
            let name = "camera-\(Int(Date().timeIntervalSince1970)).jpg"
            onPick(AttachmentDraft(name: name, mimeType: "image/jpeg", data: data))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onPick(nil)
        }
    }
}
