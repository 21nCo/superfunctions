import AuthFnClient
import Foundation
import WebKit

@MainActor
public final class AuthFnWebViewBridgeHost: NSObject, WKScriptMessageHandler {
    public enum MessageName: String {
        case nativeHandoffRequested = "authfn.nativeHandoffRequested"
        case webHandoffRequested = "authfn.webHandoffRequested"
        case signOut = "authfn.signOut"
    }

    private weak var webView: WKWebView?
    private let client: AuthFnClient
    private let handoffCoordinator: AuthFnHandoffCoordinator

    public init(webView: WKWebView, client: AuthFnClient) {
        self.webView = webView
        self.client = client
        self.handoffCoordinator = AuthFnHandoffCoordinator(client: client)
        super.init()
    }

    public func install(on userContentController: WKUserContentController) {
        userContentController.add(self, name: MessageName.nativeHandoffRequested.rawValue)
        userContentController.add(self, name: MessageName.webHandoffRequested.rawValue)
        userContentController.add(self, name: MessageName.signOut.rawValue)
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let name = MessageName(rawValue: message.name) else {
            return
        }

        Task { @MainActor in
            switch name {
            case .nativeHandoffRequested:
                if let code = extractCode(from: message.body) {
                    _ = try? await handoffCoordinator.exchangeWebCreatedNativeCode(code)
                    notifyWebAuthStateChanged()
                }
            case .webHandoffRequested:
                if let url = try? await handoffCoordinator.nativeToWebConsumeURL() {
                    webView?.load(URLRequest(url: url))
                }
            case .signOut:
                try? await client.signOut()
                await clearCookies()
                notifyWebAuthStateChanged()
            }
        }
    }

    public func installWebCookie(with consumeURL: URL) {
        webView?.load(URLRequest(url: consumeURL))
    }

    public func parseOAuthCallbackURL(_ url: URL) throws -> AuthFnOAuthCallback {
        try AuthFnOAuthCoordinator().parseCallbackURL(url)
    }

    private func extractCode(from body: Any) -> String? {
        if let code = body as? String {
            return code
        }
        if let object = body as? [String: Any], let code = object["code"] as? String {
            return code
        }
        return nil
    }

    private func notifyWebAuthStateChanged() {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('authfn:native-auth-state-changed'))")
    }

    private func clearCookies() async {
        let store = webView?.configuration.websiteDataStore.httpCookieStore ?? WKWebsiteDataStore.default().httpCookieStore
        let cookies = await store.allCookies()
        for cookie in cookies {
            await store.deleteCookie(cookie)
        }
    }
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
