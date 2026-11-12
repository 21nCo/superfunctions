import SwiftUI

/// The theme tone a UIFn component draws its status in.
public enum UIFnTone: String, CaseIterable, Sendable {
    /// The accent tone, for neutral information and progress.
    case accent
    /// The success tone.
    case success
    /// The warning tone.
    case warning
    /// The danger tone, for errors and critical levels.
    case danger
}

extension UIFnColors {
    /// The solid, subtle and contrast colors of a tone.
    func tone(_ tone: UIFnTone) -> UIFnToneColors {
        switch tone {
        case .accent: accent
        case .success: success
        case .warning: warning
        case .danger: danger
        }
    }
}
