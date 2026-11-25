import DatafnWebViewBridgeHost
import Darwin
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

        static func webOrigin(of url: URL) -> (scheme: String, host: String, port: Int)? {
            guard let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  let host = url.host?.lowercased(), !host.isEmpty else {
                return nil
            }
            return (scheme, normalizedHost(host), url.port ?? (scheme == "https" ? 443 : 80))
        }

        private static func normalizedHost(_ host: String) -> String {
            let literal = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
            let bufferSize = socklen_t(INET6_ADDRSTRLEN)
            var buffer = [CChar](repeating: 0, count: Int(bufferSize))
            var ipv6 = in6_addr()
            let formatted: Bool
            if inet_pton(AF_INET6, literal, &ipv6) == 1 {
                formatted = inet_ntop(AF_INET6, &ipv6, &buffer, bufferSize) != nil
            } else {
                let candidate = host.hasSuffix(".") ? String(host.dropLast()) : host
                let addressCharacters = CharacterSet(charactersIn: "0123456789abcdefx.")
                guard candidate.unicodeScalars.allSatisfy(addressCharacters.contains) else { return host }
                var ipv4 = in_addr()
                guard inet_aton(candidate, &ipv4) == 1 else { return host }
                formatted = inet_ntop(AF_INET, &ipv4, &buffer, bufferSize) != nil
            }
            guard formatted else { return host }
            return String(decoding: buffer.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self)
        }

        private func allows(_ url: URL?) -> Bool {
            guard let allowedURL, let url else { return false }
            if allowedURL.isFileURL {
                return url.isFileURL && url.host == allowedURL.host
                    && url.standardizedFileURL.path == allowedURL.standardizedFileURL.path
            }
            guard let allowedOrigin = Self.webOrigin(of: allowedURL),
                  let candidateOrigin = Self.webOrigin(of: url) else { return false }
            return candidateOrigin == allowedOrigin
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
