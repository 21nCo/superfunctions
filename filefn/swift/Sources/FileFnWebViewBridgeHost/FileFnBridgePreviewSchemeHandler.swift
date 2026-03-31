import Foundation
import WebKit

public final class FileFnBridgePreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    private let assetRegistry: FileFnNativeAssetRegistry

    public init(assetRegistry: FileFnNativeAssetRegistry) {
        self.assetRegistry = assetRegistry
        super.init()
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let requestURL = urlSchemeTask.request.url
        Task {
            do {
                guard let requestURL,
                      let assetHandle = await assetRegistry.assetHandle(for: requestURL) else {
                    throw FileFnBridgeError(
                        code: "NATIVE_ASSET_NOT_FOUND",
                        message: "Preview URL did not match a registered asset"
                    )
                }

                let descriptor = try await assetRegistry.descriptor(for: assetHandle)
                let fileURL = try await assetRegistry.fileURL(for: assetHandle)
                let data = try Data(contentsOf: fileURL)

                let response = URLResponse(
                    url: requestURL,
                    mimeType: descriptor.mimeType,
                    expectedContentLength: data.count,
                    textEncodingName: nil
                )
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(data)
                urlSchemeTask.didFinish()
            } catch {
                urlSchemeTask.didFailWithError(error)
            }
        }
        _ = webView
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        _ = webView
        _ = urlSchemeTask
    }
}
