import Photos
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What the composer's attachment sheet asks the system to open once the sheet has closed:
/// the camera, the full photo library chooser, or the Files browser.
enum AttachKind: CaseIterable {
    case camera
    case photo
    case file
}

extension View {
    /**
     Picking what rides with the message being written: the attachment sheet raised by `+`,
     the system choosers it hands off to, the reading of what came back, and the ceiling the
     daemon would refuse above.

     One implementation, so a file attached on a project's own page is read and chosen
     exactly as it is in an ordinary chat — the same sheet, the same MIME, the same 50 MB
     refusal, the same chip.
     */
    func attachmentPickers(
        drafts: Binding<[AttachmentDraft]>,
        menu: Binding<ComposerMenu?>,
        onModel: (() -> Void)? = nil,
        onProblem: @escaping (String) -> Void
    ) -> some View {
        modifier(
            AttachmentPicker(
                drafts: drafts,
                menu: menu,
                onModel: onModel,
                onProblem: onProblem
            )
        )
    }
}

private struct AttachmentPicker: ViewModifier {
    @Binding var drafts: [AttachmentDraft]
    @Binding var menu: ComposerMenu?
    let onModel: (() -> Void)?
    let onProblem: (String) -> Void

    private enum PendingAction {
        case attach(AttachKind)
        case model
    }

    @State private var asked: AttachKind?
    @State private var pending: PendingAction?

    /// What the Files picker offers: the kinds Milo reads, and the office documents the
    /// daemon has a reader for.
    private static let fileTypes: [UTType] = [.image, .audio, .pdf, .text]
        + ["docx", "xlsx", "pptx"].compactMap { UTType(filenameExtension: $0) }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: showingMenu, onDismiss: runPending) {
                AttachmentSheet(
                    drafts: $drafts,
                    hasModelRow: onModel != nil,
                    onClose: { menu = nil },
                    onAsk: { kind in
                        pending = .attach(kind)
                        menu = nil
                    },
                    onModel: {
                        pending = .model
                        menu = nil
                    },
                    onToggleRecent: { draft in
                        if let assetId = draft.assetId,
                           drafts.contains(where: { $0.assetId == assetId }) {
                            drafts.removeAll { $0.assetId == assetId }
                        } else {
                            collect([draft])
                        }
                    },
                    onProblem: { message in
                        menu = nil
                        onProblem(message)
                    }
                )
            }
            .fullScreenCover(isPresented: showing(.camera)) {
                CameraPicker { captured in
                    asked = nil
                    if let captured { collect([captured]) }
                }
                .ignoresSafeArea()
            }
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

    private var showingMenu: Binding<Bool> {
        Binding(
            get: { menu == .actions },
            set: { if !$0, menu == .actions { menu = nil } }
        )
    }

    /// Runs the chooser the sheet asked for after the sheet itself has finished closing, so
    /// two presentations never compete on the same view controller.
    private func runPending() {
        guard let next = pending else { return }
        pending = nil
        switch next {
        case .attach(.camera):
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                onProblem("Camera is unavailable on this device.")
                return
            }
            asked = .camera
        case .attach(let kind):
            asked = kind
        case .model:
            onModel?()
        }
    }

    /// One chooser at a time, raised by what the sheet asked for and put away with it.
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

/// The bottom sheet raised by the composer's `+`: a camera tile and recent photos across the
/// top, followed by the grouped card for files and (in an ordinary chat) the model picker.
private struct AttachmentSheet: View {
    @Binding var drafts: [AttachmentDraft]
    let hasModelRow: Bool
    let onClose: () -> Void
    let onAsk: (AttachKind) -> Void
    let onModel: () -> Void
    let onToggleRecent: (AttachmentDraft) -> Void
    let onProblem: (String) -> Void

    @Environment(AppModel.self) private var model
    @State private var assets: [PHAsset] = []
    @State private var loadingAssetIds: Set<String> = []
    @State private var sheetHeight: CGFloat = 320

    private static let tileSpan: CGFloat = 108
    private static let rowIconWidth: CGFloat = 28

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
            header

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: MiloTheme.Space.three) {
                    cameraTile
                    ForEach(assets, id: \.localIdentifier) { asset in
                        let id = asset.localIdentifier
                        let selected = drafts.contains { $0.assetId == id }
                        RecentPhotoTile(
                            asset: asset,
                            span: Self.tileSpan,
                            selected: selected,
                            busy: loadingAssetIds.contains(id)
                        ) {
                            toggleRecent(asset)
                        }
                    }
                }
                .padding(.horizontal, MiloTheme.margin)
            }

            groupedCard
                .padding(.horizontal, MiloTheme.margin)
        }
        .padding(.top, MiloTheme.Space.four)
        .padding(.bottom, MiloTheme.Space.five)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { _, height in
            if height > 0 { sheetHeight = height }
        }
        .presentationDetents([.height(sheetHeight)])
        .presentationDragIndicator(.hidden)
        .task { await loadRecentPhotos() }
    }

    private var header: some View {
        ZStack {
            Text("Add to session")
                .font(MiloTheme.Text.body.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)

            HStack {
                MiloIconButton(
                    systemName: "xmark",
                    size: 16,
                    span: 40,
                    glass: true,
                    action: onClose
                )
                .accessibilityLabel("Close")

                Spacer(minLength: MiloTheme.Space.two)

                Button {
                    onAsk(.photo)
                } label: {
                    Text("Photos")
                        .font(MiloTheme.Text.body.weight(.medium))
                        .foregroundStyle(MiloTheme.muted)
                        .padding(.vertical, MiloTheme.Space.two)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
            }
        }
        .padding(.horizontal, MiloTheme.margin)
    }

    private var cameraTile: some View {
        Button {
            onAsk(.camera)
        } label: {
            VStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "camera")
                    .font(.system(size: 24, weight: .regular))
                Text("Camera")
                    .font(MiloTheme.Text.base.weight(.medium))
            }
            .foregroundStyle(MiloTheme.foreground)
            .frame(width: Self.tileSpan, height: Self.tileSpan)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
        }
        .buttonStyle(PressableStyle())
    }

    private var groupedCard: some View {
        VStack(spacing: 0) {
            Button {
                onAsk(.file)
            } label: {
                HStack(spacing: MiloTheme.Space.four) {
                    Image(systemName: "doc.badge.arrow.up")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(MiloTheme.foreground2)
                        .frame(width: Self.rowIconWidth, alignment: .center)
                    Text("Add files")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.foreground)
                    Spacer(minLength: MiloTheme.Space.two)
                }
                .padding(.horizontal, MiloTheme.Space.four)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())

            if hasModelRow {
                Rectangle()
                    .fill(MiloTheme.borderSoft)
                    .frame(height: 1)
                    .padding(.leading, MiloTheme.Space.four + Self.rowIconWidth + MiloTheme.Space.four)
                    .padding(.trailing, MiloTheme.Space.four)

                Button(action: onModel) {
                    HStack(spacing: MiloTheme.Space.four) {
                        Image(systemName: "cpu")
                            .font(.system(size: 20, weight: .regular))
                            .foregroundStyle(MiloTheme.foreground2)
                            .frame(width: Self.rowIconWidth, alignment: .center)
                        Text("Model")
                            .font(MiloTheme.Text.body)
                            .foregroundStyle(MiloTheme.foreground)
                        Spacer(minLength: MiloTheme.Space.two)
                        if !model.modelLabel.isEmpty {
                            Text(model.modelLabel)
                                .font(MiloTheme.Text.body)
                                .foregroundStyle(MiloTheme.muted)
                                .lineLimit(1)
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .padding(.horizontal, MiloTheme.Space.four)
                    .frame(minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
            }
        }
        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
    }

    private func loadRecentPhotos() async {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        let status: PHAuthorizationStatus
        if current == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        } else {
            status = current
        }
        guard status == .authorized || status == .limited else { return }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 20
        let fetched = PHAsset.fetchAssets(with: .image, options: options)
        var list: [PHAsset] = []
        list.reserveCapacity(fetched.count)
        fetched.enumerateObjects { asset, _, _ in
            list.append(asset)
        }
        assets = list
    }

    private func toggleRecent(_ asset: PHAsset) {
        let id = asset.localIdentifier
        if drafts.contains(where: { $0.assetId == id }) {
            drafts.removeAll { $0.assetId == id }
            return
        }
        guard !loadingAssetIds.contains(id) else { return }
        loadingAssetIds.insert(id)
        let resourceName = PHAssetResource.assetResources(for: asset).first?.originalFilename
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current

        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, dataUTI, _, _ in
            Task { @MainActor in
                loadingAssetIds.remove(id)
                guard let data else {
                    onProblem("A picture could not be read.")
                    return
                }
                let type = dataUTI.flatMap { UTType($0) }
                let ext = type?.preferredFilenameExtension ?? "jpg"
                let mime = type?.preferredMIMEType ?? "image/jpeg"
                let name = resourceName ?? "photo.\(ext)"
                onToggleRecent(AttachmentDraft(name: name, mimeType: mime, data: data, assetId: id))
            }
        }
    }
}

/// One recent photo thumbnail in the attachment sheet's top carousel.
private struct RecentPhotoTile: View {
    let asset: PHAsset
    let span: CGFloat
    let selected: Bool
    let busy: Bool
    let action: () -> Void

    @State private var thumbnail: UIImage?

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .bottomTrailing) {
                ZStack {
                    if let thumbnail {
                        Image(uiImage: thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: span, height: span)
                            .clipped()
                    } else {
                        Color(.secondarySystemFill)
                            .frame(width: span, height: span)
                    }
                    if selected {
                        Color.black.opacity(0.22)
                    }
                    if busy {
                        Color.black.opacity(0.35)
                        ProgressView()
                            .tint(.white)
                    }
                }
                .frame(width: span, height: span)

                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(MiloTheme.accentOn)
                        .frame(width: 24, height: 24)
                        .background(MiloTheme.accent, in: Circle())
                        .padding(MiloTheme.Space.two)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .frame(width: span, height: span)
            .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            .animation(.snappy(duration: 0.18), value: selected)
        }
        .buttonStyle(PressableStyle())
        .disabled(busy)
        .accessibilityLabel("Recent photo")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: selected)
        .task(id: asset.localIdentifier) {
            loadThumbnail()
        }
    }

    private func loadThumbnail() {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let target = CGSize(width: span * 2, height: span * 2)
        PHImageManager.default().requestImage(
            for: asset,
            targetSize: target,
            contentMode: .aspectFill,
            options: options
        ) { image, _ in
            guard let image else { return }
            Task { @MainActor in
                thumbnail = image
            }
        }
    }
}
