import DatafnWebViewBridgeHost
import SwiftUI
import WebKit

struct EmbeddedWebView: UIViewRepresentable {
    let url: URL?
    let bootstrapScript: String
    let bridgeHost: DatafnWKWebViewBridgeHost?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let userContentController = configuration.userContentController
        userContentController.addUserScript(
            WKUserScript(
                source: bootstrapScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        bridgeHost?.attach(to: userContentController)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator

        if let url, Coordinator.webOrigin(of: url) != nil {
            context.coordinator.allowedURL = url
            webView.load(URLRequest(url: url))
        } else if let htmlURL = Bundle.main.url(forResource: "topology-demo", withExtension: "html") {
            context.coordinator.allowedURL = htmlURL
            webView.loadFileURL(
                htmlURL,
                allowingReadAccessTo: htmlURL.deletingLastPathComponent()
            )
        }

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        var allowedURL: URL?

        static func webOrigin(of url: URL) -> URL? {
            guard let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  let host = url.host?.lowercased(), !host.isEmpty else {
                return nil
            }
            var origin = URLComponents()
            origin.scheme = scheme
            origin.host = host
            origin.port = url.port ?? (scheme == "https" ? 443 : 80)
            return origin.url
        }

        private func allows(_ url: URL?) -> Bool {
            guard let allowedURL, let url else { return false }
            if allowedURL.isFileURL {
                return url.isFileURL && url.standardizedFileURL.path == allowedURL.standardizedFileURL.path
            }
            guard let allowedOrigin = Self.webOrigin(of: allowedURL) else { return false }
            return Self.webOrigin(of: url) == allowedOrigin
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            decisionHandler(navigationAction.targetFrame != nil && allows(navigationAction.request.url)
                ? .allow : .cancel)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            decisionHandler(allows(navigationResponse.response.url) ? .allow : .cancel)
        }
    }
}
