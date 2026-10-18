import SwiftUI

/**
 One thing's own detail, risen from the bottom of the screen: the hunks of a changed file,
 or the run a routine produced.

 The platform's own sheet, so the detents, the grabber and the swipe that puts it away are
 the platform's rather than drawn here. One container for both details, so the two cannot
 come to be two different things — and the page behind keeps its own scroll, which is why a
 file's diff no longer stretches the project it changed in.
 */
struct DetailSheet<Content: View>: View {
    /// Everything the detail holds: its own first line naming it, then what it is made of.
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, MiloTheme.margin)
                // Room enough for the grabber the platform draws at the sheet's own top: a
                // detail that starts right under it reads as crowding the line that says this
                // is a drawer rather than a page.
                .padding(.top, MiloTheme.Space.six)
                .padding(.bottom, MiloTheme.Space.six)
                // The reading column the pages are drawn in, so a diff or a run reads at the
                // width everything else in this app reads at.
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
        }
        // Nearly the whole screen from the first showing: what rises here is read, not
        // glanced at, and a peek of the page behind is all it needs to say where it came from
        // — the pull to the top is there for a long file or a run with plenty to say.
        .presentationDetents([.fraction(0.9), .large])
        .presentationDragIndicator(.visible)
        // The page's own tone, opaque rather than the platform's own sheet surface: a diff
        // read through the page behind it is a diff read through a haze, and this is a drawer
        // something is read in.
        .presentationBackground(MiloTheme.background)
    }
}
