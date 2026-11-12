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
    public func path(in rect: CGRect) -> Path { Path() }
}

public struct UIFnFlow: Layout {
    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { .zero }
    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {}
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
    public func uifnDim(_ amount: Double) -> some View { modifier(UIFnDim()) }
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
    public func makeUIView(context: Context) -> UIView { UIView() }
    public func updateUIView(_ view: UIView, context: Context) {}
}

public struct UIFnPhoneOnly: View {
    public var body: some View { EmptyView() }
}
#else
public struct UIFnHosted: NSViewRepresentable {
    public func makeNSView(context: Context) -> NSView { NSView() }
    public func updateNSView(_ view: NSView, context: Context) {}
}
#endif
