#if os(macOS)
import AppKit

/// Apple's contrast engine, the one the macOS accessibility audit judges text
/// with, run offline: `AXAuditContrastDetectionManager` in the private
/// AccessibilityAudit framework. It samples five rows of the image and
/// compares its two most frequent exact colors.
///
/// The waiver tests run it on the screenshots the audit failed on CI to show
/// that it reproduces each listed ratio, on the CI Mac's own copy of the
/// framework.
enum WorkbenchContrastEngine {
    struct Result {
        let ratio: Double
        /// The engine's own account, such as "Ratio:4.35 PrimaryColor:#DEE7EF …".
        let summary: String
    }

    /// The engine's verdict on a PNG of text in the system font of
    /// `fontSize` points, or nil when this Mac has no engine to run.
    static func contrast(png: Data, fontSize: Double, scale: Double = 1) -> Result? {
        guard dlopen("/System/Library/PrivateFrameworks/AccessibilityAudit.framework/AccessibilityAudit", RTLD_NOW) != nil,
              let inputClass = NSClassFromString("AXAuditContrastInput") as? NSObject.Type,
              let manager = NSClassFromString("AXAuditContrastDetectionManager") as? NSObject.Type,
              let image = NSBitmapImageRep(data: png) else { return nil }
        let input = inputClass.init()
        input.setValue(png, forKey: "imageData")
        input.setValue(fontSize, forKey: "fontSize")
        input.setValue(scale, forKey: "displayScaleFactor")
        input.setValue(false, forKey: "enhanced")
        input.setValue(NSValue(rect: NSRect(x: 0, y: 0, width: Double(image.pixelsWide) / scale, height: Double(image.pixelsHigh) / scale)), forKey: "imageFrame")
        let shared = NSSelectorFromString("sharedManager"), judge = NSSelectorFromString("contrastResultForInput:")
        guard manager.responds(to: shared),
              let engine = manager.perform(shared)?.takeUnretainedValue() as? NSObject, engine.responds(to: judge),
              let result = engine.perform(judge, with: input)?.takeUnretainedValue() as? NSObject,
              let ratio = result.value(forKey: "ratio") as? Double else { return nil }
        return Result(ratio: ratio, summary: result.description)
    }
}
#endif
