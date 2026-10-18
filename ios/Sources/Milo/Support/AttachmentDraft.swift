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

    var image: Bool { mimeType.hasPrefix("image/") }
    var size: Int { data.count }

    /// The daemon's own ceiling — `MAX_UPLOAD` in `src/gateways/web/http.ts`. Refusing here
    /// says the reason where the file was chosen, instead of leaving a large POST to fail
    /// afterwards with nothing on screen to explain it.
    static let maxBytes = 50 * 1024 * 1024
}

/// The files picked and not yet sent, above the field: the strip the quoted words take,
/// one chip per file, each with the control that takes it off. It wears the composer's own
/// glass, so it stands over the thread the way the field under it does.
struct DraftStrip: View {
    let drafts: [AttachmentDraft]
    let onRemove: (AttachmentDraft) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: MiloTheme.Space.two) {
                ForEach(drafts) { draft in
                    chip(draft)
                }
            }
            .padding(.vertical, MiloTheme.Space.one)
        }
        .padding(.horizontal, MiloTheme.margin)
    }

    private func chip(_ draft: AttachmentDraft) -> some View {
        HStack(spacing: MiloTheme.Space.two) {
            Image(systemName: draft.image ? "photo" : "doc")
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
