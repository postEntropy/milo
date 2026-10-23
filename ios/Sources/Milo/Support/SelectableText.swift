import SwiftUI
import UIKit

/**
 A stretch of prose drawn by the platform's own text view, so words can be picked out with
 a finger and **Quote** stands in the menu that appears over them.

 `Text` draws prose and lets it be selected, but it keeps the selection to itself: there is
 no reading what was picked, and no adding to the menu the selection raises. On a phone,
 answering one passage of an answer is the whole point of quoting — there is no pointer to
 drag across it — so this block is drawn by `UITextView`, which answers both.

 The attributes are mapped by hand: a `UITextView` does not read SwiftUI's inline
 presentation intent, so emphasis left to the platform's own markdown would quietly come
 out plain.
 */
struct SelectableText: UIViewRepresentable {
    /// The prose as `Prose` parsed it — what it would otherwise hand `Text`.
    let attributed: AttributedString
    /// The face the words wear. A run the parser marked strong or emphasised steps off it.
    let face: UIFont
    /// The tone the words wear where the parser said nothing about them.
    let tone: UIColor
    /// What to do with the words picked out.
    let onQuote: (String) -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isEditable = false
        view.isSelectable = true
        // The thread is the one scroll; this must never be a second one inside it, so the
        // view is as tall as its words and no taller.
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.onQuote = onQuote
        // The platform's own link colour is the tint, which on this prose is the accent —
        // a pointer, not a paint. The parse already chose the words' own tone for a link,
        // and the underline is what keeps it reading as one.
        view.linkTextAttributes = [
            .foregroundColor: tone,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        let drawn = SelectableText.drawn(attributed, face: face, tone: tone)
        // A streaming answer redraws the same string every frame, and drawing it again
        // would take the selection out from under a finger that is holding one.
        if view.attributedText?.isEqual(to: drawn) == true { return }
        view.attributedText = drawn
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let room = CGSize(
            width: UIView.layoutFittingExpandedSize.width,
            height: UIView.layoutFittingExpandedSize.height
        )
        // No width offered — a table scrolling sideways — so the words take the room they
        // ask for on one line, which is what the browser's own table cells do.
        let width = proposal.width ?? uiView.sizeThatFits(room).width
        guard width.isFinite, width > 0 else { return nil }
        // Laying these words out is the whole cost of this block, and one commit asks for
        // it more than once. The answer is the one already paid for while the view still
        // holds the words it was measured on, at the same width.
        let coordinator = context.coordinator
        if let measured = coordinator.measured,
           abs(measured.width - width) < 0.5,
           uiView.textStorage.isEqual(to: measured.text) {
            return CGSize(width: width, height: measured.height)
        }
        let height = uiView.sizeThatFits(CGSize(width: width, height: room.height)).height
        coordinator.measured = Measured(
            text: NSAttributedString(attributedString: uiView.textStorage),
            width: width,
            height: height
        )
        return CGSize(width: width, height: height)
    }

    /// A height measured for one width, beside the words it was measured on: the text view
    /// is what answers, and it answers for whatever it holds now.
    struct Measured {
        let text: NSAttributedString
        let width: CGFloat
        let height: CGFloat
    }

    func makeCoordinator() -> Coordinator { Coordinator(onQuote: onQuote) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var onQuote: (String) -> Void
        /// The last height measured, and the words and width it was measured for.
        var measured: Measured?

        init(onQuote: @escaping (String) -> Void) { self.onQuote = onQuote }

        /// The menu the platform raises over a picked-out stretch, with one line added to
        /// it: the reply can speak to exactly these words without copying them out and
        /// pasting them back first.
        func textView(
            _ textView: UITextView,
            editMenuForTextIn range: NSRange,
            suggestedActions: [UIMenuElement]
        ) -> UIMenu? {
            guard range.length > 0 else { return nil }
            let words = (textView.text as NSString).substring(with: range)
            let handle = onQuote
            let quote = UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) { _ in
                handle(words)
            }
            return UIMenu(children: suggestedActions + [quote])
        }
    }

    /// The string as the platform's text view reads it: every run walked, with the intent
    /// SwiftUI would have read turned into the font traits UIKit knows, and the parser's
    /// own tone and marks carried over.
    private static func drawn(_ attributed: AttributedString, face: UIFont, tone: UIColor) -> NSAttributedString {
        let drawn = NSMutableAttributedString()
        for run in attributed.runs {
            let intent = run.inlinePresentationIntent
            var traits = face.fontDescriptor.symbolicTraits
            if intent?.contains(.stronglyEmphasized) == true { traits.insert(.traitBold) }
            if intent?.contains(.emphasized) == true { traits.insert(.traitItalic) }

            var font = face
            if intent?.contains(.code) == true {
                font = UIFont.monospacedSystemFont(ofSize: face.pointSize, weight: .regular)
            } else if let described = face.fontDescriptor.withSymbolicTraits(traits) {
                font = UIFont(descriptor: described, size: face.pointSize)
            }

            var attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: run.foregroundColor.map { UIColor($0) } ?? tone,
            ]
            if run.underlineStyle != nil { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            if run.strikethroughStyle != nil { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            drawn.append(NSAttributedString(string: String(attributed[run.range].characters), attributes: attributes))
        }

        // An empty cell is drawn as no words at all, and there is no line of them to space.
        guard drawn.length > 0 else { return drawn }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = MiloTheme.leading
        drawn.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: drawn.length))
        return drawn
    }
}
