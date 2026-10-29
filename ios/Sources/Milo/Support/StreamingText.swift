import SwiftUI

/// How long a block takes to come all the way in.
private let blockArrival: TimeInterval = 0.55
/// Updates closer together than this belong to the block already open: the stream hands the
/// reply over in small pieces, and a block is what the eye reads as one thing landing. This is
/// the size knob — a longer window means bigger, calmer pieces and fewer of them.
private let blockWindow: TimeInterval = 0.3
/// A block never starts from nothing: coming in from full transparency reads as a typewriter,
/// and a reply nobody can read until it has settled is the thing this is here to avoid.
private let blockFloor: Double = 0.5
/// Marks which block a character arrived in. The layout is drawn a run at a time, so a
/// boundary in the words is what lets a block that is still landing be settled apart from the
/// characters already written beside it on the same line. The mark is never read back — the
/// renderer works in character indices — it only draws the line between one block and the next.
private enum StreamBlock: AttributedStringKey {
    typealias Value = Int
    static let name = "miloStreamBlock"
}

/// A streaming reply's words, with each block of them fading in as it lands. What is already
/// written stays still, so a paragraph does not flash on every token — and the words the stream
/// adds to a line that is already on screen come in on the same clock as the block they belong
/// to, instead of appearing at full strength the moment they arrive.
///
/// The unit is the block the stream handed over, not the line and not the token. An arrival is
/// when a block began; every character from there on is drawn on that block's clock until the
/// next block opens, so pieces the stream delivers word by word still land as one readable
/// thing. Coalescing the updates is the whole point: one clock restarted on every token is a
/// clock that never runs, which is a fade nothing can see.
///
/// The words cannot be picked out while they arrive: the next token would take the selection
/// out from under the finger holding it. Selection, and **Quote** with it, belongs to the
/// settled prose behind this one.
struct StreamingText: View {
    let attributed: AttributedString
    let font: Font
    let tone: Color

    /// One block of the reply: the first character it introduced, and when it landed.
    struct Arrival: Equatable {
        let from: Int
        let at: Date
    }

    @State private var arrivals: [Arrival] = [Arrival(from: 0, at: Date())]
    /// A reply keeps arriving after the person leaves the screen — that is what the phone's
    /// notice is for — but nothing is being looked at, so the clock that fades it in has no
    /// one to fade for. Left running it is a redraw of the whole answer sixty times a second
    /// in the background, which is where the app was when the watchdog took it.
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // The words drawn are the words this view was handed, cut at each block's start so
        // the renderer can settle a block apart from what is already written. The cut is made
        // here, on the way in, rather than kept in a state of its own: a copy in `@State` is a
        // second place the words could come from, and an update it missed left a shorter
        // answer on screen than the one that had arrived.
        let marked = Self.marking(attributed, arrivals: arrivals)
        TimelineView(
            .animation(minimumInterval: 1.0 / 60.0, paused: arrivals.isEmpty || scenePhase != .active)
        ) { timeline in
            Text(marked)
                .font(font)
                .lineSpacing(MiloTheme.leading)
                .foregroundStyle(tone)
                .textRenderer(StreamingTextRenderer(arrivals: arrivals, now: timeline.date))
        }
        .onChange(of: attributed) { before, after in
            let now = Date()
            let head = Self.shared(before, after)
            arrivals = Self.arriving(arrivals, head: head, now: now)
        }
        // The last block's own landing, which is when it has settled. Blocks that have already
        // settled are dropped here rather than drawn at a floor forever.
        .task(id: arrivals.last?.at) {
            try? await Task.sleep(for: .seconds(blockArrival))
            arrivals = Self.fading(arrivals, now: Date())
        }
    }

    /// The blocks still landing, the settled ones dropped. What a dropped block leaves behind
    /// is drawn at full strength, which is what a settled block is.
    private static func fading(_ arrivals: [Arrival], now: Date) -> [Arrival] {
        arrivals.filter { now.timeIntervalSince($0.at) < blockArrival }
    }

    /// The blocks after an update: the words that arrived join the block still open, or open a
    /// block of their own. Handing them to the open block is what makes the pieces the stream
    /// delivers one at a time land as a single readable block.
    private static func arriving(_ arrivals: [Arrival], head: Int, now: Date) -> [Arrival] {
        // Nothing of what was on screen was kept: the update rewrote the words rather than
        // carrying on with them — a mark that closed, a link that finished — so all of what is
        // drawn is new and all of it comes in.
        if head == 0 { return [Arrival(from: 0, at: now)] }
        var open = fading(arrivals, now: now)
        if let last = open.last, now.timeIntervalSince(last.at) < blockWindow { return open }
        open.append(Arrival(from: head, at: now))
        return open
    }

    /// The words cut at each block's own start, each span carrying its own mark so the layout
    /// draws a boundary there. The leading span is the settled words; it is cut too, so the
    /// whole reply is still drawn.
    private static func marking(_ text: AttributedString, arrivals: [Arrival]) -> AttributedString {
        let count = text.characters.count
        var bounds = [0]
        for arrival in arrivals where arrival.from > 0 && arrival.from < count { bounds.append(arrival.from) }
        bounds.append(count)
        let edges = Array(Set(bounds)).sorted()

        var out = AttributedString()
        for index in 0..<(edges.count - 1) {
            let lower = text.index(text.startIndex, offsetByCharacters: edges[index])
            let upper = text.index(text.startIndex, offsetByCharacters: edges[index + 1])
            var piece = AttributedString(text[lower..<upper])
            piece[StreamBlock.self] = index
            out.append(piece)
        }
        return out
    }

    /// How much of the words the update kept: the head the two texts share, counted in
    /// characters, which is where the characters the stream introduced begin. Read off the
    /// attributed text itself — turning both into strings first, as this did, spent two
    /// copies of the whole answer on every token just to compare it.
    private static func shared(_ before: AttributedString, _ after: AttributedString) -> Int {
        var shared = 0
        for (was, is_) in zip(before.characters, after.characters) {
            if was != is_ { break }
            shared += 1
        }
        return shared
    }
}

/// Draws the streamed words a piece at a time, each piece as far in as its own block has come.
/// Every comparison is made in the text's own character
/// space — the layout says which characters a glyph stands for — so a mark drawn over two of
/// them (a ligature, a joined emoji) moves nothing.
private struct StreamingTextRenderer: TextRenderer {
    let arrivals: [StreamingText.Arrival]
    let now: Date

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        // Where the drawn text begins, so the blocks — counted in characters — can be put
        // against the character a piece begins at.
        let origin = layout.first?.first?.first?.characterIndices.first
        for line in layout {
            for run in line {
                for slice in run {
                    let arrived = comingIn(at: slice, origin: origin)
                    guard arrived < 1 else {
                        context.draw(slice)
                        continue
                    }
                    // The block's own climb: it lands already partway in and fades the rest of
                    // the way, so it reads as settling rather than typing into place.
                    var piece = context
                    piece.opacity *= blockFloor + (1 - blockFloor) * arrived
                    piece.draw(slice)
                }
            }
        }
    }

    /// How far in a piece is: 1 for words no block ever opened over, and for one whose block
    /// has settled. The newest block covering the piece's first character is the one it arrived
    /// in, and that block's own climb is what the piece is drawn at.
    private func comingIn(at slice: Text.Layout.RunSlice, origin: Text.Layout.CharacterIndex?) -> Double {
        guard let origin, let character = slice.characterIndices.first else { return 1 }
        var landed: Date?
        for arrival in arrivals where character >= origin.advanced(by: arrival.from) { landed = arrival.at }
        guard let landed else { return 1 }
        return min(max(now.timeIntervalSince(landed) / blockArrival, 0), 1)
    }
}
