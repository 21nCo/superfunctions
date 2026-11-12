import SwiftUI

public protocol UIFnRenderable: View {}

public enum UIFnBox {
    public protocol UIFnRenderable {}
    public struct Panel {}
    public struct Item: View {
        public var body: some View { EmptyView() }
    }
}

// The file-scope UIFnRenderable, which refines View, not UIFnBox's.
extension UIFnBox.Panel: UIFnRenderable {
    public var body: some View { EmptyView() }
}

public extension UIFnBox {
    struct Bar: View {
        public var body: some View { EmptyView() }
    }
}

public struct UIFnRing: Shape {
    public func path(in _: CGRect) -> Path { Path() }
}

public struct UIFnFlow: Layout {
    public func sizeThatFits(proposal _: ProposedViewSize, subviews _: Subviews, cache _: inout ()) -> CGSize { .zero }
    public func placeSubviews(in _: CGRect, proposal _: ProposedViewSize, subviews _: Subviews, cache _: inout ()) {
        // A fixture: there is nothing to place.
    }
}

public actor UIFnWorker {}

public struct UIFnList<Data: RandomAccessCollection<Int>>: View {
    public var body: some View { EmptyView() }
}

public struct UIFnDim: ViewModifier {
    public func body(content: Content) -> some View { content.opacity(0.5) }
}

public enum UIFnVariant { case plain }

public enum UIFnPlaceholder: View {
    case plain
    public var body: some View { EmptyView() }
}

extension View {
    public nonisolated(unsafe) static var uifnDefault: Int { 0 }
    public func uifnDim() -> some View { modifier(UIFnDim()) }
    public func uifnDim(_: Double) -> some View { modifier(UIFnDim()) }
    func uifnInternal() -> some View { self }
}

extension Text {
    public func uifnBold() -> Text { bold() }
}

public func uifnMakeView() -> some View { EmptyView() }

public typealias UIFnAlias = SwiftUI.Button<Text>

struct UIFnInternalView: View {
    var body: some View { EmptyView() }
}

public struct UIFnPager: View {
    struct Hidden: View {
        var body: some View { EmptyView() }
    }
    public var body: some View { EmptyView() }
}

let uifnRatio = [8].reduce(1, /) / 5

/* public struct UIFnCommented: View { public var body: some View { EmptyView() } } */

#if os(iOS)
public struct UIFnHosted: UIViewRepresentable {
    public func makeUIView(context _: Context) -> UIView { UIView() }
    public func updateUIView(_: UIView, context _: Context) {
        // A fixture: there is nothing to update.
    }
}

public struct UIFnPhoneOnly: View {
    public var body: some View { EmptyView() }
}
#else
public struct UIFnHosted: NSViewRepresentable {
    public func makeNSView(context _: Context) -> NSView { NSView() }
    public func updateNSView(_: NSView, context _: Context) {
        // A fixture: there is nothing to update.
    }
}
#endif

// Public API the default symbol graph leaves out.
public struct _UIFnRow: View {
    public var body: some View { EmptyView() }
}

@_spi(Preview) public struct UIFnSpiCard: View {
    public var body: some View { EmptyView() }
}

@_documentation(visibility: internal) public struct UIFnDocCard: View {
    public var body: some View { EmptyView() }
}

// Only a graph down to private access has this one.
@_documentation(visibility: private) public struct UIFnHiddenCard: View {
    public var body: some View { EmptyView() }
}

// Not public: never declarations, though the graph has them.
private struct UIFnPrivateView: View {
    var body: some View { EmptyView() }
}

fileprivate struct UIFnFilePrivateView: View {
    var body: some View { EmptyView() }
}

// Public, but nested in an internal type.
struct UIFnInternal {
    public struct Inner: View {
        public var body: some View { EmptyView() }
    }
}

// Members of extensions of UIFnSwiftUI protocols, one refining View.
public extension UIFnRenderable {
    func uifnGlow() -> some View { self }
}

public protocol UIFnSizing {
    func size() -> Int
}

extension UIFnSizing {
    public func uifnDoubled() -> Int { size() * 2 }
    // A default implementation of the requirement, unclassified.
    public func size() -> Int { 1 }
}

// Default implementations of requirements of a protocol refining View: the
// graph links them to the requirement only. A public one is a component; an
// internal one is not a declaration.
public protocol UIFnGlowing: View {
    func uifnHalo() -> Int
    func uifnShade() -> Int
}

extension UIFnGlowing {
    public func uifnHalo() -> Int { 1 }
    func uifnShade() -> Int { 0 }
}

// Declarations in debug-only, release-only and device-only builds.
#if DEBUG
public struct UIFnDebugOnly: View {
    public var body: some View { EmptyView() }
}
#else
public struct UIFnReleaseOnly: View {
    public var body: some View { EmptyView() }
}
#endif

#if os(iOS) && !targetEnvironment(simulator)
public struct UIFnDeviceOnly: View {
    public var body: some View { EmptyView() }
}
#endif
