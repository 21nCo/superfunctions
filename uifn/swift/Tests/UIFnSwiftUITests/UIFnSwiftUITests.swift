import Testing
import UIFnSwiftUI

struct UIFnSwiftUITests {
    @Test
    func productNameMatchesLibraryProduct() {
        #expect(UIFnSwiftUI.productName == "UIFnSwiftUI")
    }
}
