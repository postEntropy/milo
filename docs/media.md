# Media attachments

Incoming attachments are normalized in `src/core/media.ts`, regardless of whether
they arrive through the CLI, web app, Telegram or Discord. The gateway supplies the
bytes; core decides what can be read, what reaches the answering model, and what the
person is told was omitted.

## Limits and fallback behavior

- A turn accepts at most 50 MB of attachments in total, and each file is limited to
  50 MB. Downloads stop at the same limit rather than buffering an unbounded response.
- Plain text and extracted document text are previewed up to 100,000 characters.
  The complete extracted text is retained beside the attachment and can be paged with
  `read_attachment`.
- PDF text extraction uses `pdftotext`. Empty pages may be OCR'd with `pdftoppm` and
  `tesseract` (up to ten pages). For a model with image support, up to five pages are
  rendered when the original PDF cannot be sent natively. Every omitted page or visual
  fallback is disclosed in the turn.
- DOCX, XLSX and PPTX are read as text from their Office XML. Their images, layout,
  formulas as displayed, and other visual details are not represented. Extraction is
  bounded to 100 slides or sheets.
- Inline native PDF requests are capped at 10 MB. They are enabled only on a provider
  route configured with `nativePdf: true` (OpenAI or Anthropic wire), and a model must
  have document support in its profile. Set `models.<model>.document: true` to declare
  that support for a compatible custom model; `false` explicitly disables it. The
  profile's vision support is also required when document support is inferred from a
  known model family.
- An optional `media.vision` model can inspect images and rendered PDF pages for a
  different answering model. Its findings are passed as evidence, with image text
  treated as untrusted input. If helper analysis fails, the turn continues with a
  visible notice and the configured text/OCR fallback.

## Storage

Attachment bytes are stored outside session JSON under `~/.milo/documents/` and
`~/.milo/attachments/` with private file permissions. Session records hold paths and
names; extracted text sidecars stay next to the original document. Session history
keeps attachment references across compaction and forks so a person can inspect the
same file later.

Files currently have no automatic expiry. Clearing a session removes its references,
but does not erase shared attachment files; deleting a session also does not erase a
file that may be referenced elsewhere. This avoids breaking another session that
received the same content. Manage these directories directly when you want to remove
stored media, and keep a backup before bulk removal because older sessions may still
refer to those paths.
