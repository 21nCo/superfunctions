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
        for (index, url) in trustedOrigins.enumerated() {
            if let origin = Self.parse(url.absoluteString) {
                origins.insert(origin)
            } else {
                // The entry itself is not printed: a URL can carry a password
                // or query parameters.
                print("[AuthFnWebViewBridgeHost] trusted origin #\(index) ignored, not a usable web origin (scheme://host[:port], not file:)")
            }
        }
        self.trustedOrigins = origins
    }

    /// Whether a page with this security origin may drive the bridge. WebKit
    /// reports `port` 0 both for no port and for an explicit `:0`; pass
    /// `explicitPortZero` to tell them apart.
    public func allows(scheme: String, host: String, port: Int, explicitPortZero: Bool = false) -> Bool {
        if Self.isUntrustable(scheme: scheme.lowercased(), host: host) {
            return false
        }
        let portText: String? = port != 0 ? String(port) : (explicitPortZero ? "0" : nil)
        return trustedOrigins.contains(Self.key(scheme: scheme, host: host, port: portText))
    }

    /// Whether a main-frame message may drive the bridge, from the frame's
    /// security origin as WebKit reports it and the frame's URL.
    ///
    /// WebKit reports port 0 for no port (or the default one) and for an
    /// explicit `:0`, which any scheme can carry (a page loaded from HTML with
    /// such a base URL); the frame's own URL tells them apart. A frame whose
    /// URL does not show its origin (an `about:blank` page that inherited it)
    /// leaves that open, so it is refused.
    public func allowsMessage(scheme: String, host: String, port: Int, frameURL: String) -> Bool {
        if port == 0 && !Self.sameSchemeAndHost(frameURL, scheme: scheme, host: host) {
            return false
        }
        let explicitPortZero = port == 0 && Self.hasExplicitPortZero(frameURL)
        return allows(scheme: scheme, host: host, port: port, explicitPortZero: explicitPortZero)
    }

    /// Schemes WebKit gives no host-specific origin: every `file:` page shares
    /// one origin, and `about:`, `data:`, `blob:` and similar pages have no
    /// host of their own. None of them can be trusted.
    static let hostlessSchemes: Set<String> = ["file", "about", "data", "blob", "javascript"]

    static func isUntrustable(scheme: String, host: String) -> Bool {
        if hostlessSchemes.contains(scheme) {
            return true
        }
        let isWeb = scheme == "http" || scheme == "https" || scheme == "ws" || scheme == "wss"
        return isWeb && host.isEmpty
    }

    /// Parses `scheme://host[:port]`. For http(s) and ws(s) the host is
    /// normalized as WebKit does (percent escapes decoded, IPv4 and IPv6
    /// literals in canonical form); for other schemes it is kept as given.
    static func parse(_ string: String) -> String? {
        guard let parts = splitOrigin(string) else { return nil }
        if isUntrustable(scheme: parts.scheme, host: parts.host) {
            return nil
        }
        if isSpecial(parts.scheme) && parts.host.hasPrefix("[") {
            // Only hex digits, ':' and '.' (an embedded IPv4 tail) belong in
            // an IPv6 literal; WebKit refuses anything else, such as `%00`.
            guard canonicalIPv6(parts.host.lowercased()) != nil else {
                return nil
            }
        }
        if isSpecial(parts.scheme) && !parts.host.hasPrefix("[") {
            // WebKit refuses these hosts: one that decodes to non-ASCII (an
            // internationalized domain not given in punycode), to nothing, or
            // to a forbidden character (`example.test%3A8443` would otherwise
            // read as another origin's host and port), and one that ends in a
            // number but is not a valid IPv4 address.
            guard let decoded = parts.host.removingPercentEncoding,
                  !decoded.isEmpty, decoded.allSatisfy(\.isASCII),
                  !decoded.unicodeScalars.contains(where: { forbiddenHostScalars.contains($0) || $0.value < 0x20 || $0.value == 0x7F }) else {
                return nil
            }
            if endsInNumber(decoded.lowercased()) && canonicalIPv4(decoded.lowercased()) == nil {
                return nil
            }
        }
        if let port = parts.port, !port.isEmpty {
            // A port that is not a number in range is refused rather than read
            // as no port (which would trust the default one).
            guard port.allSatisfy(isASCIIDigit), let number = Int(port), (0...65535).contains(number) else {
                return nil
            }
        }
        return key(scheme: parts.scheme, host: parts.host, port: parts.port)
    }

    /// Whether a frame's URL shows the same scheme and host as its reported
    /// origin, and so can say whether its port 0 is explicit.
    static func sameSchemeAndHost(_ string: String, scheme: String, host: String) -> Bool {
        guard let parts = splitOrigin(string) else { return false }
        let scheme = scheme.lowercased()
        return parts.scheme == scheme && canonicalHost(parts.host, scheme: scheme) == canonicalHost(host, scheme: scheme)
    }

    /// Whether a URL names an explicit port 0 (`app://portal:0`).
    static func hasExplicitPortZero(_ string: String) -> Bool {
        guard let port = splitOrigin(string)?.port else { return false }
        return Int(port) == 0
    }

    static func key(scheme: String, host: String, port: String?) -> String {
        let scheme = scheme.lowercased()
        let host = canonicalHost(host, scheme: scheme)
        let defaultPort: Int? = switch scheme {
        case "https", "wss": 443
        case "http", "ws": 80
        default: nil
        }
        guard let port, !port.isEmpty, let number = Int(port) else {
            return "\(scheme)://\(host)"
        }
        if number == defaultPort {
            return "\(scheme)://\(host)"
        }
        return "\(scheme)://\(host):\(number)"
    }

    /// Schemes whose hosts WebKit parses as domains or IP addresses.
    static func isSpecial(_ scheme: String) -> Bool {
        ["http", "https", "ws", "wss"].contains(scheme)
    }

    /// A host as WebKit reports it: lower-cased; for http(s) and ws(s) also
    /// percent-decoded, with an IPv4 address in dotted-decimal form
    /// (`127.1` and `0x7f.0.0.1` become `127.0.0.1`); and an IPv6 literal in
    /// its canonical form (`[0:0:0:0:0:0:0:1]` becomes `[::1]`).
    static func canonicalHost(_ host: String, scheme: String) -> String {
        var lowered = host.lowercased()
        if lowered.hasPrefix("[") {
            // IPv6 literals are never percent-decoded.
            return canonicalIPv6(lowered) ?? lowered
        }
        if isSpecial(scheme) {
            lowered = (lowered.removingPercentEncoding ?? lowered).lowercased()
            if let ipv4 = canonicalIPv4(lowered) {
                return ipv4
            }
        }
        return lowered
    }

    /// The canonical form of a bracketed IPv6 literal (`[0:0:0:0:0:0:0:1]`
    /// becomes `[::1]`), or nil when it is not one. Only hex digits, ':' and
    /// '.' are accepted, so nothing is cut short at a NUL or read past an
    /// escape.
    static func canonicalIPv6(_ host: String) -> String? {
        guard host.hasPrefix("["), host.hasSuffix("]"), host.count > 2 else { return nil }
        let literal = String(host.dropFirst().dropLast())
        guard literal.unicodeScalars.allSatisfy({ isHexDigitScalar($0) || $0 == ":" || $0 == "." }) else {
            return nil
        }
        var address = in6_addr()
        guard inet_pton(AF_INET6, literal, &address) == 1 else { return nil }
        var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        guard inet_ntop(AF_INET6, &address, &buffer, socklen_t(buffer.count)) != nil else { return nil }
        return "[\(String(cString: buffer))]"
    }

    static func isASCIIDigit(_ character: Character) -> Bool {
        ("0"..."9").contains(character)
    }

    private static func isHexDigitScalar(_ scalar: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(scalar) || ("a"..."f").contains(scalar) || ("A"..."F").contains(scalar)
    }

    /// Characters WebKit refuses in a domain host.
    static let forbiddenHostScalars = Set(" #%/:<>?@[\\]^|".unicodeScalars)

    /// The labels of a host, without one trailing empty label (`a.b.`).
    private static func ipv4Parts(_ host: String) -> [Substring] {
        var parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count > 1, parts.last?.isEmpty == true {
            parts.removeLast()
        }
        return parts
    }

    /// Whether WebKit parses this host as an IPv4 address: its last label is
    /// a decimal number, or `0x` followed by hex digits (possibly none).
    static func endsInNumber(_ host: String) -> Bool {
        guard let last = ipv4Parts(host).last, !last.isEmpty else { return false }
        if last.allSatisfy({ $0.isASCII && $0.isNumber }) {
            return true
        }
        return (last.hasPrefix("0x") || last.hasPrefix("0X")) && last.dropFirst(2).allSatisfy({ $0.isASCII && $0.isHexDigit })
    }

    /// The dotted-decimal form of a host WebKit reads as an IPv4 address, or
    /// nil. Parsed the way WebKit (and the WHATWG URL standard) does: one to
    /// four parts, each decimal, octal (leading 0) or hex (`0x`, where a bare
    /// `0x` is 0), the last one filling the remaining bytes.
    static func canonicalIPv4(_ host: String) -> String? {
        guard endsInNumber(host) else { return nil }
        let parts = ipv4Parts(host)
        guard (1...4).contains(parts.count) else { return nil }
        var numbers: [UInt64] = []
        for part in parts {
            guard let number = parseIPv4Number(part) else { return nil }
            numbers.append(number)
        }
        for number in numbers.dropLast() where number > 255 {
            return nil
        }
        let last = numbers[numbers.count - 1]
        guard last < (UInt64(1) << (8 * UInt64(5 - numbers.count))) else { return nil }
        var address = last
        for (index, number) in numbers.dropLast().enumerated() {
            address += number << (8 * UInt64(3 - index))
        }
        return (0..<4).map { String((address >> (8 * UInt64(3 - $0))) & 0xFF) }.joined(separator: ".")
    }

    private static func parseIPv4Number(_ part: Substring) -> UInt64? {
        guard !part.isEmpty else { return nil }
        var digits = part
        var radix = 10
        if digits.count >= 2, digits.hasPrefix("0x") || digits.hasPrefix("0X") {
            digits = digits.dropFirst(2)
            radix = 16
        } else if digits.count >= 2, digits.hasPrefix("0") {
            digits = digits.dropFirst()
            radix = 8
        }
        // Only digits of the radix: Swift's own parser would also take a
        // leading '+'.
        let valid: (Character) -> Bool = switch radix {
        case 16: { $0.isASCII && $0.isHexDigit }
        case 8: { ("0"..."7").contains($0) }
        default: { ("0"..."9").contains($0) }
        }
        guard digits.allSatisfy(valid) else { return nil }
        // Leading zeros do not count towards the size; anything still longer
        // than 11 digits is above 2^32, which no IPv4 part can be.
        let significant = digits.drop(while: { $0 == "0" })
        if significant.isEmpty {
            return 0
        }
        guard significant.count <= 11 else { return nil }
        return UInt64(significant, radix: radix)
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
        let frameURL = message.frameInfo.request.url?.absoluteString ?? ""
        guard originPolicy.allowsMessage(scheme: origin.protocol, host: origin.host, port: origin.port, frameURL: frameURL) else {
            logBridgeError("message from an untrusted or ambiguous origin ignored", BridgeOriginError(origin: "\(origin.protocol)://\(origin.host):\(origin.port)"))
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
