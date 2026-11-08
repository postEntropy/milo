import SwiftUI

/// A file the person picked and the daemon has not been given yet: the bytes are held here
/// until they are posted, which is what lets the message draw the picture before the upload
/// has landed. What comes back is a `FrameAttachment`, named by the id the daemon registered
/// it under — the received file on the wire, this one in hand.
struct AttachmentDraft: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let mimeType: String
    let data: Data
    /// The photo-library identifier when picked from the recent photos strip, so the strip
    /// reflects which thumbnails are already attached and can toggle them on and off.
    var assetId: String? = nil

    var image: Bool { mimeType.hasPrefix("image/") }
    var size: Int { data.count }

    /// The daemon's own ceiling — `MAX_UPLOAD` in `src/gateways/web/http.ts`. Refusing here
    /// says the reason where the file was chosen, instead of leaving a large POST to fail
    /// afterwards with nothing on screen to explain it.
    static let maxBytes = 50 * 1024 * 1024
}

/// The files picked and not yet sent, above the field: a thumbnail with its remove button for
/// a picture, and a glass chip for any other document.
struct DraftStrip: View {
    let drafts: [AttachmentDraft]
    let onRemove: (AttachmentDraft) -> Void

    private static let thumbSpan: CGFloat = 68

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: MiloTheme.Space.two) {
                ForEach(drafts) { draft in
                    item(draft)
                }
            }
            .padding(.vertical, MiloTheme.Space.one)
        }
        .padding(.horizontal, MiloTheme.margin)
    }

    @ViewBuilder
    private func item(_ draft: AttachmentDraft) -> some View {
        if draft.image, let picture = UIImage(data: draft.data) {
            ZStack(alignment: .topTrailing) {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFill()
                    .frame(width: Self.thumbSpan, height: Self.thumbSpan)
                    .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))

                Button {
                    onRemove(draft)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(.black.opacity(0.6), in: Circle())
                        .padding(MiloTheme.Space.one)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Remove \(draft.name)")
            }
        } else {
            fileChip(draft)
        }
    }

    private func fileChip(_ draft: AttachmentDraft) -> some View {
        HStack(spacing: MiloTheme.Space.two) {
            Image(systemName: "doc")
                .font(.system(size: 14))
                .foregroundStyle(MiloTheme.accent)
            Text(draft.name)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.foreground2)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 180, alignment: .leading)
            Button {
                onRemove(draft)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(MiloTheme.muted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Remove \(draft.name)")
        }
        .padding(.leading, MiloTheme.Space.three)
        .padding(.trailing, MiloTheme.Space.one)
        .padding(.vertical, MiloTheme.Space.one)
        .glassEffect(.regular, in: Capsule())
    }
}

/// The files on the person's own message, drawn from the bytes still in hand. A file the
/// daemon delivered comes by its id through `Attachments`; this is the other half — the
/// picture shown from what was picked, before the daemon has been given it, so a message
/// never appears to have sent a file it did not.
struct DraftAttachments: View {
    let items: [AttachmentDraft]

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            ForEach(items) { item in
                if item.image, let picture = UIImage(data: item.data) {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 280, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                } else {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "doc")
                        Text(item.name).lineLimit(1)
                        Spacer(minLength: MiloTheme.Space.two)
                        Text(Attachments.bytes(item.size))
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .padding(MiloTheme.Space.three)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                }
            }
        }
    }
}
