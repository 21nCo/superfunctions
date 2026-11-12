import SwiftUI

// A style only a graph down to private access has.
@_documentation(visibility: private) public struct UIFnHiddenStyle: ButtonStyle {
    public func makeBody(configuration: Configuration) -> some View { configuration.label }
}
