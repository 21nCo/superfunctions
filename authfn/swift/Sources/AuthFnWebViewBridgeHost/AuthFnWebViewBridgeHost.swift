import AuthFnClient
import Foundation
import WebKit

/// The web origins whose pages may drive the bridge.
///
/// An origin is a scheme, host and port, as in `https://app.example.com`,
/// `https://localhost:8443`, `http://[::1]:5173` or `app://portal` (a page
/// served by a `WKURLSchemeHandler`). A message is accepted only from a page
/// whose security origin is exactly one of them: subdomains, other ports and
/// other schemes do not match. Hosts are compared as WebKit reports them, so
/// give internationalized domains in their ASCII (punycode) form, and serve
/// bundled pages from a scheme handler with a host rather than `file:` URLs.
public struct AuthFnBridgeOriginPolicy: Sendable, Equatable {
    public let trustedOrigins: Set<String>

    public init(trustedOrigins: [URL]) {
        var origins = Set<String>()
        for url in trustedOrigins {
            if let origin = Self.parse(url.absoluteString) {
                origins.insert(origin)
            } else {
                print("[AuthFnWebViewBridgeHost] trusted origin ignored, it has no scheme://host: \(url.absoluteString)")
            }
        }
        self.trustedOrigins = origins
    }

    /// Whether a page with this security origin may drive the bridge. WebKit
    /// reports `port` 0 both for no port and for an explicit `:0`; pass
    /// `explicitPortZero` to tell them apart.
    public func allows(scheme: String, host: String, port: Int, explicitPortZero: Bool = false) -> Bool {
        let portText: String? = port != 0 ? String(port) : (explicitPortZero ? "0" : nil)
        return trustedOrigins.contains(Self.key(scheme: scheme, host: host, port: portText))
    }

    /// Parses `scheme://host[:port]` without decoding the host, the way WebKit
    /// keeps it: brackets of IPv6 literals and percent escapes stay as given.
    static func parse(_ string: String) -> String? {
        guard let parts = splitOrigin(string) else { return nil }
        let isWeb = parts.scheme == "http" || parts.scheme == "https"
        if isWeb && parts.host.isEmpty {
            return nil
        }
        return key(scheme: parts.scheme, host: parts.host, port: parts.port)
    }

    /// Whether a URL names an explicit port 0 (`app://portal:0`).
    static func hasExplicitPortZero(_ string: String) -> Bool {
        guard let port = splitOrigin(string)?.port else { return false }
        return Int(port) == 0
    }

    static func key(scheme: String, host: String, port: String?) -> String {
        let scheme = scheme.lowercased()
        let host = host.lowercased()
        let defaultPort = scheme == "https" ? 443 : (scheme == "http" ? 80 : nil)
        guard let port, !port.isEmpty, let number = Int(port) else {
            return "\(scheme)://\(host)"
        }
        if number == defaultPort {
            return "\(scheme)://\(host)"
        }
        return "\(scheme)://\(host):\(number)"
    }

    private static func splitOrigin(_ string: String) -> (scheme: String, host: String, port: String?)? {
        guard let separator = string.range(of: "://") else { return nil }
        let scheme = String(string[..<separator.lowerBound]).lowercased()
        guard !scheme.isEmpty else { return nil }
        var authority = string[separator.upperBound...]
        if let end = authority.firstIndex(where: { "/?#".contains($0) }) {
            authority = authority[..<end]
        }
        if let at = authority.lastIndex(of: "@") {
            authority = authority[authority.index(after: at)...]
        }
        if authority.hasPrefix("[") {
            guard let close = authority.firstIndex(of: "]") else { return nil }
            let host = String(authority[...close])
            let rest = authority[authority.index(after: close)...]
            if rest.isEmpty { return (scheme, host, nil) }
            guard rest.hasPrefix(":") else { return nil }
            return (scheme, host, String(rest.dropFirst()))
        }
        if let colon = authority.lastIndex(of: ":") {
            return (scheme, String(authority[..<colon]), String(authority[authority.index(after: colon)...]))
        }
        return (scheme, String(authority), nil)
    }
}

@MainActor
public final class AuthFnWebViewBridgeHost: NSObject, WKScriptMessageHandler {
    public enum MessageName: String {
        case nativeHandoffRequested = "authfn.nativeHandoffRequested"
        case webHandoffRequested = "authfn.webHandoffRequested"
        case signOut = "authfn.signOut"
    }

    private weak var webView: WKWebView?
    private weak var userContentController: WKUserContentController?
    private let client: AuthFnClient
    private let handoffCoordinator: AuthFnHandoffCoordinator
    private let originPolicy: AuthFnBridgeOriginPolicy

    /// - Parameter trustedOrigins: the origins of the app's own web pages.
    ///   Messages from any other page loaded in the web view (a link the user
    ///   followed, a redirect, an embedded page) are ignored, so it cannot make
    ///   the app exchange a handoff code, start a web handoff or sign out.
    public init(webView: WKWebView, client: AuthFnClient, trustedOrigins: [URL]) {
        self.webView = webView
        self.client = client
        self.handoffCoordinator = AuthFnHandoffCoordinator(client: client)
        self.originPolicy = AuthFnBridgeOriginPolicy(trustedOrigins: trustedOrigins)
        super.init()
    }

    /// Removed: the bridge needs the origins of the app's own pages.
    @available(*, unavailable, message: "Pass trustedOrigins: the origins of the app's own web pages.")
    public convenience init(webView: WKWebView, client: AuthFnClient) {
        self.init(webView: webView, client: client, trustedOrigins: [])
    }

    public func install(on userContentController: WKUserContentController) {
        uninstall()
        self.userContentController = userContentController
        userContentController.add(self, name: MessageName.nativeHandoffRequested.rawValue)
        userContentController.add(self, name: MessageName.webHandoffRequested.rawValue)
        userContentController.add(self, name: MessageName.signOut.rawValue)
    }

    public func uninstall() {
        userContentController?.removeScriptMessageHandler(forName: MessageName.nativeHandoffRequested.rawValue)
        userContentController?.removeScriptMessageHandler(forName: MessageName.webHandoffRequested.rawValue)
        userContentController?.removeScriptMessageHandler(forName: MessageName.signOut.rawValue)
        userContentController = nil
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let name = MessageName(rawValue: message.name) else {
            return
        }
        guard message.frameInfo.isMainFrame else {
            return
        }
        let origin = message.frameInfo.securityOrigin
        // WebKit reports port 0 for no port and for an explicit `:0`; the
        // frame's own URL tells them apart.
        let explicitPortZero = origin.port == 0
            && AuthFnBridgeOriginPolicy.hasExplicitPortZero(message.frameInfo.request.url?.absoluteString ?? "")
        guard originPolicy.allows(scheme: origin.protocol, host: origin.host, port: origin.port, explicitPortZero: explicitPortZero) else {
            logBridgeError("message from an untrusted origin ignored", BridgeOriginError(origin: "\(origin.protocol)://\(origin.host):\(origin.port)"))
            return
        }

        Task { @MainActor in
            switch name {
            case .nativeHandoffRequested:
                if let handoff = extractHandoff(from: message.body) {
                    do {
                        _ = try await handoffCoordinator.exchangeWebCreatedNativeCode(handoff.code, regionId: handoff.regionId)
                        notifyWebAuthStateChanged()
                    } catch {
                        logBridgeError("native handoff exchange failed", error)
                    }
                }
            case .webHandoffRequested:
                do {
                    let url = try await handoffCoordinator.nativeToWebConsumeURL()
                    webView?.load(URLRequest(url: url))
                } catch {
                    logBridgeError("web handoff start failed", error)
                }
            case .signOut:
                do {
                    try await client.signOut()
                    await clearCookies()
                    notifyWebAuthStateChanged()
                } catch {
                    logBridgeError("sign out failed", error)
                }
            }
        }
    }

    public func installWebCookie(with consumeURL: URL) {
        webView?.load(URLRequest(url: consumeURL))
    }

    public func parseOAuthCallbackURL(_ url: URL) throws -> AuthFnOAuthCallback {
        try AuthFnOAuthCoordinator().parseCallbackURL(url)
    }

    private func extractHandoff(from body: Any) -> (code: String, regionId: String?)? {
        if let code = body as? String {
            return (code, nil)
        }
        if let object = body as? [String: Any], let code = object["code"] as? String {
            return (code, object["regionId"] as? String)
        }
        return nil
    }

    private func notifyWebAuthStateChanged() {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('authfn:native-auth-state-changed'))") { _, error in
            if let error {
                self.logBridgeError("web auth state notification failed", error)
            }
        }
    }

    private func clearCookies() async {
        let store = webView?.configuration.websiteDataStore.httpCookieStore ?? WKWebsiteDataStore.default().httpCookieStore
        let cookies = await store.allCookies()
        let currentHost = webView?.url?.host
        for cookie in cookies {
            guard isAuthFnCookie(cookie, currentHost: currentHost) else {
                continue
            }
            await store.deleteCookie(cookie)
        }
    }

    private func isAuthFnCookie(_ cookie: HTTPCookie, currentHost: String?) -> Bool {
        let prefix = client.cookiePrefix
        let authCookieNames: Set<String> = [
            "\(prefix).session",
            "\(prefix).csrf",
            "__Secure-\(prefix).session",
            "__Secure-\(prefix).csrf",
        ]
        guard authCookieNames.contains(cookie.name) else {
            return false
        }
        guard let currentHost else {
            return false
        }

        let cookieDomain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
        let host = currentHost.lowercased()
        return host == cookieDomain || host.hasSuffix(".\(cookieDomain)")
    }

    private func logBridgeError(_ message: String, _ error: Error) {
        print("[AuthFnWebViewBridgeHost] \(message): \(error)")
    }
}

private struct BridgeOriginError: Error, CustomStringConvertible {
    let origin: String
    var description: String { "untrusted origin \(origin)" }
}

private extension WKHTTPCookieStore {
    func allCookies() async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
    }
}
