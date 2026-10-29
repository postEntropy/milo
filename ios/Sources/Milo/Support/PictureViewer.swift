import SwiftUI
import UIKit

/**
 A picture drawn in place, and the whole of it when pressed: full screen, pinch and double
 tap to zoom, drag around it once it is zoomed, and a drag down to give it back.

 One view for every picture the app draws — the files delivered into a conversation, one in
 a reply, one in the panel — so a picture behaves the same wherever it stands rather than
 the chat having a viewer and the panel not. The bytes arrive through the same URL the
 image loader already holds, so the platform's cache answers the full screen instead of the
 daemon being asked for the same file twice.
 */
struct Picture: View {
    let url: URL
    /// The words that stand for the picture where it cannot be drawn, and what the
    /// accessible reading of it says.
    var alt: String = ""
    /// The widest it draws in place. The thread leaves it at the width of a message; the
    /// panel hands it the column.
    var maxWidth: CGFloat? = 280
    /// The picture's own travel into the full screen: it grows out of where it stands
    /// rather than another screen sliding over it.
    @Namespace private var zoom
    @State private var open = false

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                Button { open = true } label: {
                    image
                        .resizable()
                        .scaledToFit()
                }
                .buttonStyle(PressableStyle())
                .matchedTransitionSource(id: "picture", in: zoom)
                .accessibilityLabel(alt.isEmpty ? "Picture" : alt)
                .accessibilityHint("Opens the picture to zoom")
            case .empty:
                RoundedRectangle(cornerRadius: MiloTheme.Radius.md)
                    .fill(MiloTheme.surface)
                    .frame(height: 160)
                    .overlay { ProgressView().controlSize(.small) }
            case .failure:
                // A picture that will not load says so, rather than leaving an empty box
                // standing in its place.
                Text("That picture could not be shown.")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
            @unknown default:
                EmptyView()
            }
        }
        .frame(maxWidth: maxWidth, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
        .fullScreenCover(isPresented: $open) {
            PictureViewer(url: url, alt: alt)
                .navigationTransition(.zoom(sourceID: "picture", in: zoom))
                .presentationBackground(.clear)
        }
    }
}

/**
 The picture on its own, over everything: the conversation stays behind it, dimmed, rather
 than being replaced by another page — so the drag that puts the picture away gives back
 what it was being looked at in.

 The bytes are read here rather than handed over, because the loader on the page holds a
 drawn `Image` and not the file. The request is the one the thumbnail already made, and the
 platform's cache is what answers it.
 */
struct PictureViewer: View {
    let url: URL
    var alt: String = ""
    @Environment(\.dismiss) private var dismiss
    @State private var read: Read = .waiting
    /// How far the picture has been pulled down, as the share of the travel that puts it
    /// away: the page behind comes back as it is pulled, and goes again if it is let go.
    @State private var pulled: CGFloat = 0

    private enum Read {
        case waiting
        case picture(UIImage)
        case failed
    }

    var body: some View {
        ZStack {
            // The page behind comes back exactly as far as the picture is pulled, so letting
            // go of a picture that was not carried far enough simply puts the dark back.
            Color.black
                .opacity(1 - pulled)
                .ignoresSafeArea()
            content
        }
        .overlay(alignment: .topTrailing) {
            MiloIconButton(systemName: "xmark", size: 15, span: 38, glass: true) { dismiss() }
                .padding(MiloTheme.Space.three)
                .opacity(1 - pulled)
                .accessibilityLabel("Close the picture")
        }
        // The viewer is its own world: a picture is looked at, and what is drawn over it is
        // white whichever appearance the page behind wears.
        .preferredColorScheme(.dark)
        .task(id: url) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch read {
        case .waiting:
            ProgressView()
                .controlSize(.large)
                .tint(.white)
        case .failed:
            Text("That picture could not be opened.")
                .font(MiloTheme.Text.base)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
                .padding(MiloTheme.margin)
        case .picture(let picture):
            ZoomingPicture(
                image: picture,
                onPull: pulled(by:),
                onSettle: { withAnimation(.easeOut(duration: 0.32)) { pulled = 0 } },
                onLeave: { withAnimation(.easeOut(duration: 0.3)) { pulled = 1 } },
                onTap: { dismiss() },
                onGone: gone
            )
            .ignoresSafeArea()
            .accessibilityLabel(alt.isEmpty ? "Picture" : alt)
        }
    }

    /// The picture follows the hand exactly: what is animated is only the way back, and the
    /// way out, which has its own clock.
    private func pulled(by share: CGFloat) {
        pulled = share
    }

    /// The picture has been carried off the screen by the drag, so the cover goes without an
    /// animation of its own: the zoom back to the thread would draw nothing but the wait.
    private func gone() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { dismiss() }
    }

    private func load() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let status = (response as? HTTPURLResponse)?.statusCode,
                  (200..<300).contains(status),
                  let picture = UIImage(data: data)
            else {
                read = .failed
                return
            }
            read = .picture(picture)
        } catch {
            // A picture still loading is not a failure when the viewer is the thing going
            // away: the task is cancelled as the cover closes.
            guard !Task.isCancelled else { return }
            read = .failed
        }
    }
}

/// The picture under the fingers. `UIScrollView` is the platform's own zooming, so the
/// pinch, the pan around it once zoomed and the bounce at the edges are its own. The one
/// gesture it has no notion of — the drag down that puts the picture away — is a second
/// pan that stands aside while the picture is zoomed, because there a finger on it is
/// moving around the picture rather than leaving it.
private struct ZoomingPicture: UIViewRepresentable {
    let image: UIImage
    /// The share of the way down the picture has been carried, while the hand is on it.
    let onPull: (CGFloat) -> Void
    /// Let go short of the way out: the picture springs back.
    let onSettle: () -> Void
    /// Let go past it: the picture is on its way off the screen.
    let onLeave: () -> Void
    let onTap: () -> Void
    /// The picture has finished leaving, and the cover can go.
    let onGone: () -> Void

    func makeUIView(context: Context) -> PictureZoom {
        let view = PictureZoom()
        view.show(image)
        view.onPull = onPull
        view.onSettle = onSettle
        view.onLeave = onLeave
        view.onTap = onTap
        view.onGone = onGone
        return view
    }

    func updateUIView(_ view: PictureZoom, context: Context) {
        view.show(image)
        view.onPull = onPull
        view.onSettle = onSettle
        view.onLeave = onLeave
        view.onTap = onTap
        view.onGone = onGone
    }
}

private final class PictureZoom: UIView, UIScrollViewDelegate {
    private let scroll = UIScrollView()
    private let photo = UIImageView()
    private let pull = UIPanGestureRecognizer()
    /// Decides whether a drag on the picture is the way out. A delegate of its own rather
    /// than this view, because the touch lands on the scroll view and the decision is about
    /// the picture's own state, not about who was touched.
    private let gate = PullGate()
    /// How far the picture travels down before letting go puts it away.
    private let threshold: CGFloat = 150
    /// The size the photo takes before any zoom, kept apart from its frame: zooming writes
    /// the frame through the transform, so reading it back would look like a new fit.
    private var fitted: CGSize = .zero

    var onPull: ((CGFloat) -> Void)?
    var onSettle: (() -> Void)?
    var onLeave: (() -> Void)?
    var onTap: (() -> Void)?
    var onGone: (() -> Void)?
    var zoomScale: CGFloat { scroll.zoomScale }

    init() {
        super.init(frame: .zero)
        backgroundColor = .clear

        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.bouncesZoom = true
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.panGestureRecognizer.isEnabled = false
        addSubview(scroll)

        photo.contentMode = .scaleAspectFit
        photo.isUserInteractionEnabled = false
        scroll.addSubview(photo)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoomed(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)

        // A tap anywhere puts the picture away, and waits for the second tap that would
        // have zoomed instead.
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.require(toFail: doubleTap)
        addGestureRecognizer(tap)

        pull.addTarget(self, action: #selector(pulled(_:)))
        pull.maximumNumberOfTouches = 1
        gate.zoom = self
        pull.delegate = gate
        addGestureRecognizer(pull)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func show(_ image: UIImage) {
        guard photo.image !== image else { return }
        photo.image = image
        fitted = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scroll.frame = bounds
        guard let image = photo.image, bounds.width > 0, bounds.height > 0 else { return }

        let fit = image.size.fitted(in: bounds.size)
        if fit != fitted {
            fitted = fit
            scroll.zoomScale = 1
            photo.transform = .identity
            photo.frame = CGRect(origin: .zero, size: fit)
            scroll.contentSize = fit
        }
        centre()
    }

    /// Where the picture sits when it is smaller than the screen, and what keeps it in the
    /// middle while it is being zoomed in either direction.
    private func centre() {
        guard fitted.width > 0, fitted.height > 0 else { return }
        let wide = fitted.width * scroll.zoomScale
        let tall = fitted.height * scroll.zoomScale
        scroll.contentInset = UIEdgeInsets(
            top: max(0, (bounds.height - tall) / 2),
            left: max(0, (bounds.width - wide) / 2),
            bottom: max(0, (bounds.height - tall) / 2),
            right: max(0, (bounds.width - wide) / 2)
        )
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        // A finger on a zoomed picture is moving around it, not leaving it.
        scrollView.panGestureRecognizer.isEnabled = scrollView.zoomScale > 1.001
        centre()
    }

    @objc private func zoomed(_ gesture: UITapGestureRecognizer) {
        guard scroll.zoomScale <= 1.001 else {
            scroll.setZoomScale(1, animated: true)
            return
        }
        let at = gesture.location(in: photo)
        let target: CGFloat = 2.5
        let size = CGSize(width: bounds.width / target, height: bounds.height / target)
        scroll.zoom(
            to: CGRect(x: at.x - size.width / 2, y: at.y - size.height / 2,
                       width: size.width, height: size.height),
            animated: true
        )
    }

    @objc private func tapped() {
        onTap?()
    }

    @objc private func pulled(_ gesture: UIPanGestureRecognizer) {
        let travel = gesture.translation(in: self)
        switch gesture.state {
        case .changed:
            let down = max(0, travel.y)
            let share = min(1, down / threshold)
            scroll.transform = CGAffineTransform(translationX: 0, y: down)
                .scaledBy(x: 1 - 0.25 * share, y: 1 - 0.25 * share)
            onPull?(share)
        case .ended:
            let speed = gesture.velocity(in: self).y
            if travel.y > threshold || speed > 900 {
                leave()
            } else {
                settle()
            }
        case .cancelled, .failed:
            settle()
        default:
            break
        }
    }

    private func settle() {
        UIView.animate(
            withDuration: 0.32,
            delay: 0,
            usingSpringWithDamping: 0.86,
            initialSpringVelocity: 0,
            options: [.beginFromCurrentState]
        ) {
            self.scroll.transform = .identity
        }
        onSettle?()
    }

    /// The picture finishes what the hand started: it carries on down and off the screen,
    /// and only then does the cover go. Handing a half-dragged picture to the zoom back into
    /// the thread is what made the way out read as two motions.
    ///
    /// It leaves by a whole screen, so it is gone from sight before the cover is lifted —
    /// a picture still showing when the cover goes would vanish in a frame. The easing
    /// starts at the speed the hand let it go and only slows, which is the way something
    /// let go of the finger moves.
    private func leave() {
        isUserInteractionEnabled = false
        pull.isEnabled = false
        onLeave?()
        UIView.animate(
            withDuration: 0.3,
            delay: 0,
            options: [.curveEaseOut, .beginFromCurrentState]
        ) {
            self.scroll.transform = CGAffineTransform(
                translationX: 0,
                y: self.bounds.height
            ).scaledBy(x: 0.8, y: 0.8)
        } completion: { _ in
            self.onGone?()
        }
    }
}

/// A drag puts the picture away only while the picture is whole: a zoomed picture is being
/// looked around, so there a finger on it is not leaving it.
private final class PullGate: NSObject, UIGestureRecognizerDelegate {
    weak var zoom: PictureZoom?

    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let zoom else { return false }
        return zoom.zoomScale <= 1.001
    }
}

private extension CGSize {
    /// The size this takes inside a box, keeping its own shape.
    func fitted(in box: CGSize) -> CGSize {
        guard width > 0, height > 0, box.width > 0, box.height > 0 else { return .zero }
        let scale = min(box.width / width, box.height / height)
        return CGSize(width: width * scale, height: height * scale)
    }
}
