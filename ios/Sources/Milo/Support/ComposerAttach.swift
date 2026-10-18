import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// What the composer's `+` asks for while its panel is closing: the platform's own chooser
/// for the pictures, or for the files.
enum AttachKind: CaseIterable {
    case photo
    case file
}

/// The two ways in, as the panel draws them. Spelled once because every composer that
/// carries a `+` names the same two — the chat's and a project's own page's.
@MainActor
func composerActionRows(
    model: AppModel,
    /// The way to the model picker, when the model is a line of this panel. `nil` where the
    /// surface put the model on a line of its own under the field — one choice reached one
    /// way, never two.
    modelRow: (() -> Void)?,
    ask: @escaping (AttachKind) -> Void
) -> [MenuRow] {
    // The files, and how hard the model thinks: what belongs to the message is what is
    // being written. Each line carries the mark of what it does, the way every other line
    // of a panel does.
    let attach = [
        MenuRow(title: "Photo", symbol: "photo") { ask(.photo) },
        MenuRow(title: "File", symbol: "doc") { ask(.file) },
    ]
    let picker = modelRow.flatMap { open in
        MenuRow(
            title: "Model",
            subtitle: model.modelLabel.isEmpty ? nil : model.modelLabel,
            symbol: "cpu",
            action: open
        )
    }
    // The bulb is the browser's own mark for this control, off its reasoning pill; the
    // levels live inside it as a submenu, so the root panel names what is being chosen and
    // a press unfolds the levels in place.
    guard !model.efforts.isEmpty else { return attach + (picker.map { [$0] } ?? []) }
    return attach + (picker.map { [$0] } ?? []) + [
        MenuRow(
            title: "Reasoning effort",
            symbol: "lightbulb",
            children: model.efforts.map { value in
                MenuRow(
                    title: SettingsWording.of(value),
                    chosen: value == model.effort
                ) {
                    // The panel stays open: choosing how hard to think is not leaving, and
                    // the tick has to be seen moving onto what was chosen.
                    Task { await model.setEffort(value) }
                }
            }
        ),
    ]
}

extension View {
    /**
     Picking what rides with the message being written: the chooser each way in, the
     reading of what came back, and the ceiling the daemon would refuse above.

     One implementation, so a file attached on a project's own page is read exactly as it
     is in an ordinary chat — the same MIME, the same 50 MB refusal, the same chip.
     */
    func attachmentPickers(
        drafts: Binding<[AttachmentDraft]>,
        asked: Binding<AttachKind?>,
        onProblem: @escaping (String) -> Void
    ) -> some View {
        modifier(AttachmentPicker(drafts: drafts, asked: asked, onProblem: onProblem))
    }
}

private struct AttachmentPicker: ViewModifier {
    @Binding var drafts: [AttachmentDraft]
    @Binding var asked: AttachKind?
    let onProblem: (String) -> Void

    /// What the Files picker offers: the kinds Milo reads, and the office documents the
    /// daemon has a reader for.
    private static let fileTypes: [UTType] = [.image, .audio, .pdf, .text]
        + ["docx", "xlsx", "pptx"].compactMap { UTType(filenameExtension: $0) }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: showing(.photo)) {
                PhotoPicker { providers in
                    asked = nil
                    Task { collect(await pictures(providers)) }
                }
            }
            .fileImporter(
                isPresented: showing(.file),
                allowedContentTypes: Self.fileTypes,
                allowsMultipleSelection: true
            ) { result in
                asked = nil
                switch result {
                case .success(let urls): collect(files(urls))
                case .failure(let error): onProblem((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
                }
            }
    }

    /// One chooser at a time, raised by what the panel asked for and put away with it.
    private func showing(_ kind: AttachKind) -> Binding<Bool> {
        Binding(
            get: { asked == kind },
            set: { if !$0 { asked = nil } }
        )
    }

    /// The pictures the chooser handed back, read into what the composer holds. Each is taken
    /// under the image type it actually carries, so the file keeps the bytes it has rather
    /// than being re-encoded — the picker was asked for the same. One that cannot be read says
    /// so rather than leaving a chip that carries nothing.
    private func pictures(_ providers: [NSItemProvider]) async -> [AttachmentDraft] {
        var picked: [AttachmentDraft] = []
        for (index, provider) in providers.enumerated() {
            guard let identifier = provider.registeredTypeIdentifiers
                .first(where: { UTType($0)?.conforms(to: .image) == true }),
                let type = UTType(identifier) else {
                onProblem("A picture could not be read.")
                continue
            }
            let data = await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
                provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in
                    continuation.resume(returning: data)
                }
            }
            guard let data else {
                onProblem("A picture could not be read.")
                continue
            }
            // The chooser names no picture, and several picked at once would otherwise be a
            // row of chips saying the same thing.
            let name = "photo-\(index + 1)" + (type.preferredFilenameExtension.map { ".\($0)" } ?? ".jpg")
            picked.append(AttachmentDraft(name: name, mimeType: type.preferredMIMEType ?? "image/jpeg", data: data))
        }
        return picked
    }

    /// The files the Files picker handed back. Reading one out of the sandbox the picker
    /// keeps it in takes a security scope, which is given up as soon as the bytes are read.
    private func files(_ urls: [URL]) -> [AttachmentDraft] {
        var picked: [AttachmentDraft] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                picked.append(AttachmentDraft(name: url.lastPathComponent, mimeType: mime, data: data))
            } catch {
                onProblem("\(url.lastPathComponent) could not be read.")
            }
        }
        return picked
    }

    /// Adds the picked files to the message being written. One the daemon would refuse is
    /// refused here, where it was chosen, rather than left to fail as a large upload later.
    private func collect(_ picked: [AttachmentDraft]) {
        for draft in picked {
            guard draft.size <= AttachmentDraft.maxBytes else {
                onProblem("\(draft.name) is larger than 50 MB.")
                continue
            }
            drafts.append(draft)
        }
    }
}
