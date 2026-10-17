import SwiftUI
import UIKit

/**
 The live browser Milo is driving, drawn as it happens.

 The frames come from the daemon's own screencast and are drawn as they arrive rather than
 handed to a web view: a view drawing that stream never says when it stopped, and a browser
 frozen on its last frame reads as a page that is simply still. Here the silence itself is
 the signal — after the browser's own four seconds without a picture the stream is treated as
 dead and reopened, and only once its own three attempts are spent does the panel stop and
 offer the way back, over the last frame it did draw.

 The person's taps and keys go the other way, normalized to the page's viewport. This is
 where a step Milo must not take itself — a sign-in, a code, a payment — is handed over.
 */
struct PanelBrowser: View {
    let tab: PanelTab
    @Environment(AppModel.self) private var model

    /// The last frame drawn. Kept across a stream that ended: the picture of a moment ago is
    /// more use than an empty box, as long as what it is — a picture of a moment ago — is
    /// said under it.
    @State private var frame: UIImage?
    /// What to say where the picture would be, or under it when there is one.
    @State private var trouble: String?
    /// Whether the panel has spent its own attempts: the way back is the person's press.
    @State private var givenUp = false
    /// What is being typed into the page, sent when the field is committed.
    @State private var typed = ""
    /// Whether this drag has already said where the pointer went, so one gesture does not send
    /// a move for every point of itself.
    @State private var moved = false
    /// The box the page is drawn in, so a touch becomes a place on the page. The wire wants
    /// the viewport's own fractions, and the page is drawn to fill this box.
    @State private var stageBox: CGSize = .zero
    /// A new value opens the stream again from the start — the way back once the panel has
    /// given up on its own.
    @State private var run = 0

    /// How many times the panel reopens a stream that ended, and how long a stream may be
    /// silent before it is treated as dead. The browser's own numbers, so a live view that has
    /// stopped behaves the same way on both surfaces.
    private static let attempts = 3
    private static let quiet: TimeInterval = 4
    /// How far a drag may travel and still be a press on the page rather than a scroll of it.
    private static let tap: CGFloat = 8

    var body: some View {
        VStack(spacing: MiloTheme.Space.three) {
            address
            stage
            if frame != nil, trouble != nil { word }
            field
        }
        .task(id: run) { await watch() }
    }

    private var address: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Image(systemName: "globe")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(MiloTheme.muted)
            Text(readable)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    /// The address as a person reads it: the daemon's own `location.href` arrives
    /// percent-encoded where the URL is not ASCII, which is correct and unreadable. Display
    /// only, and anything undecodable is left as it came.
    private var readable: String {
        guard let url = tab.url else { return "The browser is not on a page." }
        return url.removingPercentEncoding ?? url
    }

    private var stage: some View {
        ZStack {
            if let frame {
                Image(uiImage: frame)
                    .resizable()
                    .scaledToFit()
                    .contentShape(Rectangle())
                    .gesture(page)
            } else {
                word.padding(MiloTheme.Space.four)
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(stageAspect, contentMode: .fit)
        .background(MiloTheme.surfaceWarm)
        .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .onGeometryChange(for: CGSize.self) { $0.size } action: { _, size in stageBox = size }
    }

    /// The page's own shape, so the box around it is the page rather than a guess: a frame is
    /// the viewport's size, and the coordinates sent back are relative to it.
    private var stageAspect: CGFloat {
        guard let frame, frame.size.height > 0 else { return 4 / 3 }
        return frame.size.width / frame.size.height
    }

    /// What the panel has to say: the daemon's own words where it gave them, the wait while
    /// there is nothing yet, and the way back once the attempts are spent.
    private var word: some View {
        PanelLine(
            text: trouble ?? "Connecting to the live view…",
            action: givenUp ? (title: "Retry", run: { givenUp = false; run += 1 }) : nil
        )
    }

    /// The pointer and keys, onto the page. A press is a click where the finger landed; a drag
    /// is the page being scrolled, which is what a drag means on a phone. Where the finger went
    /// is said once per gesture — a move per point would swamp the socket, as it does in the
    /// browser.
    private var page: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { drag in
                guard !moved else { return }
                moved = true
                let at = place(drag.startLocation)
                model.sendPanelInput(.move(x: at.x, y: at.y))
            }
            .onEnded { drag in
                moved = false
                let translation = drag.translation
                if abs(translation.width) < Self.tap, abs(translation.height) < Self.tap {
                    // A press is a click where the finger landed, not where it lifted.
                    let at = place(drag.startLocation)
                    model.sendPanelInput(.click(x: at.x, y: at.y))
                } else {
                    let at = place(drag.location)
                    // A finger going up scrolls the page down, which is a wheel of its own
                    // sign: `deltaY` is positive downwards.
                    model.sendPanelInput(.scroll(x: at.x, y: at.y, deltaY: -Double(translation.height)))
                }
            }
    }

    /// A touch as a fraction of the page, held inside it: the page cannot be acted on outside
    /// itself, and a finger on the box's very edge rounds past the end.
    private func place(_ point: CGPoint) -> (x: Double, y: Double) {
        guard stageBox.width > 0, stageBox.height > 0 else { return (0, 0) }
        return (
            min(max(point.x / stageBox.width, 0), 1),
            min(max(point.y / stageBox.height, 0), 1)
        )
    }

    /// The field for what cannot be typed at the page directly. Text goes as the text itself,
    /// which lands in a field however the page listens; the return that committed it goes as
    /// the key, so a page waiting on one sees it.
    private var field: some View {
        HStack(spacing: MiloTheme.Space.two) {
            TextField("Type into the page", text: $typed)
                .font(MiloTheme.Text.base)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .onSubmit(commit)
                .padding(.horizontal, MiloTheme.Space.four)
                .frame(height: 40)
                .background(MiloTheme.surfaceWarm, in: Capsule())
            MiloIconButton(systemName: "delete.left", size: 16, span: 40) {
                model.sendPanelInput(.key("Backspace", modifiers: 0))
            }
            .accessibilityLabel("Delete a character")
        }
    }

    private func commit() {
        if !typed.isEmpty {
            model.sendPanelInput(.type(typed))
            typed = ""
        }
        model.sendPanelInput(.key("Enter", modifiers: 0))
    }

    /**
     Opens the stream, and reopens it while there is a reason to.

     A refusal is not one: the daemon answered, and asking it the same question again cannot
     change what it said — the browser being off is a state, and its own words are the line.
     */
    private func watch() async {
        guard let url = model.browserFramesURL else {
            trouble = "The daemon's address cannot reach the live view."
            return
        }
        for attempt in 1...Self.attempts {
            trouble = nil
            let stream = BrowserStream(url: url, quiet: Self.quiet)
            let verdict = await stream.read { jpeg in
                if let image = UIImage(data: jpeg) { frame = image }
            }
            if Task.isCancelled { return }
            switch verdict {
            case .refused(let words):
                trouble = words
                return
            case .ended:
                if attempt == Self.attempts {
                    givenUp = true
                    trouble = "The live view stopped."
                    return
                }
                trouble = "The live view went quiet — reconnecting…"
                // One breath, so a stream that closes the moment it opens is not reopened in
                // a tight loop.
                try? await Task.sleep(for: .milliseconds(400))
            }
        }
    }
}

/// The daemon's screencast as it arrives: one request that never ends, handed over a picture at
/// a time.
///
/// `multipart/x-mixed-replace` is a content type the loading system knows: it calls the
/// delegate at the beginning of every part and hands over the contents between two such calls,
/// so the boundaries never reach this app — each part *is* a frame. That is the shape this is
/// built around (`urlSession(_:dataTask:didReceive:completionHandler:)` says so in its own
/// documentation), and reading the raw bytes for boundaries instead was reading a form that
/// never arrives: the second call — a part beginning, carrying that part's `content-type:
/// image/jpeg` — looked like a second answer, and the stream was refused for it.
///
/// A delegate rather than `URLSession.bytes`, because that sequence suspends once per byte and
/// one frame is a hundred thousand of them. The delegate queue is the main one, so every
/// callback lands where the rest of the app already is.
@MainActor
final class BrowserStream: NSObject, URLSessionDataDelegate {
    /// What a stream came to.
    enum Verdict {
        /// The daemon would not open it, and said why. Retrying would ask the same question.
        case refused(String)
        /// It ended: closed, failed, or gone quiet for longer than it is allowed.
        case ended
    }

    /// The content type the stream is, and the picture type each part of it carries.
    private static let streamType = "multipart/x-mixed-replace"
    private static let pictureType = "image/"

    private let url: URL
    private let quiet: TimeInterval
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var onFrame: ((Data) -> Void)?
    private var continuation: CheckedContinuation<Verdict, Never>?
    /// A refusal, and the body behind it: the daemon answers a refusal with the reason in
    /// `{ error: "…" }`, and that sentence is the one already written for this state.
    private var refusal: String?
    private var refusalBody = Data()
    /// What has arrived since the last part began — one picture, once the next part does.
    private var frame = Data()
    /// Whether the response's own head has been read. Every call after it is a part beginning
    /// rather than another answer.
    private var head = false
    /// When a picture last landed, which is the only thing that says the stream is alive.
    private var heard = Date()
    private var watchdog: Task<Void, Never>?

    init(url: URL, quiet: TimeInterval) {
        self.url = url
        self.quiet = quiet
    }

    /// Reads until the stream ends, is refused, or goes quiet, and answers which. A caller
    /// whose own work is cancelled has the stream let go of, rather than left open for a panel
    /// that is no longer drawn.
    func read(onFrame: @escaping (Data) -> Void) async -> Verdict {
        self.onFrame = onFrame
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
        self.session = session
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                // A cancellation that landed before this ran has nothing to tear down yet, and
                // a stream opened for a panel that is already gone would be one nobody closes:
                // the daemon keeps its screencast up until the last watcher lets go.
                guard !Task.isCancelled else {
                    continuation.resume(returning: .ended)
                    return
                }
                self.continuation = continuation
                let task = session.dataTask(with: url)
                self.task = task
                task.resume()
            }
        } onCancel: {
            Task { @MainActor in self.finish() }
        }
    }

    /// The silence itself as the signal: a stream that stopped without closing is the one
    /// failure a picture cannot report. What is watched is pictures, not bytes — a stream
    /// sending something that is not one has stopped as surely as one sending nothing. One
    /// task, polled rather than re-armed per picture, however fast the pictures come.
    private func watch() {
        heard = Date()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self else { return }
                if Date().timeIntervalSince(self.heard) >= self.quiet {
                    self.finish()
                    return
                }
            }
        }
    }

    private func received(_ data: Data) {
        if refusal != nil {
            if refusalBody.count < Self.bodyLimit {
                refusalBody.append(data.prefix(Self.bodyLimit - refusalBody.count))
            }
            return
        }
        guard head else { return }
        frame.append(data)
    }

    /// Hands over what has been gathered since the last part began, if it is really a picture.
    /// A part's own trailing CRLF is not always kept out of the next one's bytes, so it is
    /// trimmed; and something that is not a JPEG is dropped rather than drawn — what reports a
    /// stream that has stopped sending pictures is the watchdog, not a frame nobody can read.
    private func emit() {
        var bytes = frame
        frame.removeAll(keepingCapacity: true)
        while bytes.first == 13 || bytes.first == 10 { bytes.removeFirst() }
        guard bytes.count > 2, bytes[0] == 0xFF, bytes[1] == 0xD8 else { return }
        heard = Date()
        onFrame?(bytes)
    }

    /// Enough of a refusal's body to hold the sentence the daemon writes in it.
    private static let bodyLimit = 4096

    /// Ends the stream once, whatever ended it, and answers whoever is waiting on it.
    private func finish() {
        task?.cancel()
        session?.invalidateAndCancel()
        watchdog?.cancel()
        watchdog = nil
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(returning: verdict())
    }

    private func verdict() -> Verdict {
        guard let refusal else { return .ended }
        return .refused(Self.errorLine(refusalBody) ?? refusal)
    }

    /// Where the stream was asked for, for the refusal line: the address alone, never the token
    /// that rides in its query — a secret belongs on no screen.
    private var asked: String {
        let host = url.host ?? "?"
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(host)\(port)\(url.path)"
    }

    /// The `error` a JSON body carries, when it carries one.
    private static func errorLine(_ body: Data) -> String? {
        struct Answer: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Answer.self, from: body))?.error
    }

    nonisolated func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        // The delegate queue is the main one (see `read`), so this is already the actor the
        // rest of the app is on — `assumeIsolated` is how that is said to the compiler without
        // hopping, which would put the bytes out of the order they arrived in.
        MainActor.assumeIsolated {
            // The head has been read: this call is a part beginning, and the only thing that
            // says the picture being collected is whole. Its own headers name a JPEG, which is
            // expected here and is not a second answer to judge.
            if head {
                emit()
                completionHandler(.allow)
                return
            }
            // What arrived is named in every refusal, and the status and content type are what
            // the person can act on: a sentence that only says a thing could not be read leaves
            // nowhere to go, on a surface where the panel is the only report there is.
            guard let http = response as? HTTPURLResponse else {
                refusal = "The live view answered without an HTTP response (\(type(of: response)))."
                completionHandler(.cancel)
                return
            }
            head = true
            if !(200..<300).contains(http.statusCode) {
                refusal = "The live view was refused (\(http.statusCode)) at \(asked)."
                completionHandler(.allow)
                return
            }
            // The wait is over once the daemon has answered; the watchdog starts here and not
            // when the request went out, because opening a browser is the daemon's own few
            // seconds and a surface that counted them as a stall would kill every cold start.
            watch()
            // The stream, or a picture out of it. `multipart/x-mixed-replace` is handed over
            // part by part, and the call that begins a part carries that part's own headers —
            // so even the first call can say `image/jpeg`, which is the stream arriving rather
            // than an answer that is not one. Everything else — a JSON refusal carried with a
            // 2xx, the web app's own page where the route should be — is named, not drawn.
            let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
            guard contentType.hasPrefix(Self.streamType) || contentType.hasPrefix(Self.pictureType) else {
                refusal = "The live view came back as \(http.value(forHTTPHeaderField: "Content-Type") ?? "no content type") at \(asked), which is not the stream this panel reads."
                completionHandler(.cancel)
                return
            }
            completionHandler(.allow)
        }
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated { received(data) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            // The last part is complete when the task is: there is no next call to say so.
            emit()
            finish()
        }
    }
}
