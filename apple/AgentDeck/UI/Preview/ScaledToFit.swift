// ScaledToFit.swift — keep a fixed-size device preview inside the frame it is given.
//
// Every preview is drawn at its hardware's own geometry: a Stream Deck key is
// 72×72, a D200H deck is a wide grid, an e-ink panel is 800×480. The screen
// that hosts them is whatever width the window or the phone happens to be, and
// those two numbers have no reason to agree.
//
// The old approach was a per-device constant — 1.65× for a Stream Deck key,
// 1.28× for a Plus — which only ever scaled UP. Nothing scaled down, and
// `scaleEffect` is a render-time transform that leaves layout untouched, so a
// device wider than its card painted straight through the edge and got clipped.
// The card had no idea it was too small.
//
// Measuring the content and dividing is what actually fits it. The measurement
// is taken on the unscaled content and the scale is applied outside it, so
// there is no feedback loop between the two. Both the publisher and the reader
// of the size preference live inside this view, which matters on macOS: a
// preference does not reliably propagate out of a ScrollView, and these
// previews sit inside one.
//
// `maxUpscale` is what keeps a 72×72 key from sitting lost in the middle of a
// wide card — it may grow up to that factor, but it is never a reason to
// overflow, because the fitting ratio still wins when space runs out.

import SwiftUI

struct ScaledToFit<Content: View>: View {
    /// Largest enlargement allowed for a preview smaller than its frame.
    /// 1 means "never enlarge, only shrink when needed".
    var maxUpscale: CGFloat = 1
    @ViewBuilder var content: Content

    @State private var natural: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            content
                .background(
                    GeometryReader { inner in
                        Color.clear.preference(key: NaturalSizeKey.self, value: inner.size)
                    }
                )
                .scaleEffect(Self.scale(natural: natural, available: geo.size, maxUpscale: maxUpscale))
                .frame(width: geo.size.width, height: geo.size.height)
        }
        .onPreferenceChange(NaturalSizeKey.self) { natural = $0 }
    }

    /// The factor that fits `natural` inside `available`.
    ///
    /// Shrinking is mandatory (that is the clipping bug); growing is optional
    /// and capped. A not-yet-measured size returns 1 so the first frame renders
    /// at natural size rather than collapsing to nothing.
    static func scale(natural: CGSize, available: CGSize, maxUpscale: CGFloat) -> CGFloat {
        guard natural.width > 0, natural.height > 0,
              available.width > 0, available.height > 0 else { return 1 }
        let fit = min(available.width / natural.width, available.height / natural.height)
        return min(max(fit, 0.05), max(maxUpscale, 1))
    }
}

private struct NaturalSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        // Several children publish; the meaningful one is the measured content.
        if next.width > 0 || next.height > 0 { value = next }
    }
}
