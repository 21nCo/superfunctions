import XCTest
import AuthFnClient
@testable import AuthFnWebViewBridgeHost

final class AuthFnWebViewBridgeHostTests: XCTestCase {
    func testOAuthCallbackParsingIsAvailableFromBridgeHostType() throws {
        let callback = try AuthFnOAuthCoordinator().parseCallbackURL(
            URL(string: "nucleum://auth/callback?error=access_denied")!
        )

        XCTAssertEqual(callback.error, "access_denied")
    }

    func testOriginPolicyAcceptsOnlyTheExactTrustedOrigins() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "https://app.example.com/some/page")!,
            URL(string: "http://localhost:5173")!,
        ])

        XCTAssertTrue(policy.allows(scheme: "https", host: "app.example.com", port: 0))
        XCTAssertTrue(policy.allows(scheme: "https", host: "APP.example.com", port: 443))
        XCTAssertTrue(policy.allows(scheme: "http", host: "localhost", port: 5173))

        XCTAssertFalse(policy.allows(scheme: "https", host: "evil.example", port: 0))
        XCTAssertFalse(policy.allows(scheme: "https", host: "sub.app.example.com", port: 0))
        XCTAssertFalse(policy.allows(scheme: "http", host: "app.example.com", port: 0))
        XCTAssertFalse(policy.allows(scheme: "https", host: "app.example.com", port: 8443))
        XCTAssertFalse(policy.allows(scheme: "http", host: "localhost", port: 0))
    }

    func testOriginPolicyMatchesHostsAsWebKitReportsThem() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "http://[::1]:5173")!,
            URL(string: "app://tenant%2Dassets")!,
            URL(string: "app:///index.html")!,
            URL(string: "custom://portal")!,
        ])

        // IPv6 literals keep their brackets, as WebKit reports them.
        XCTAssertTrue(policy.allows(scheme: "http", host: "[::1]", port: 5173))
        // A percent-escaped custom-scheme host is not decoded into another host.
        XCTAssertTrue(policy.allows(scheme: "app", host: "tenant%2dassets", port: 0))
        XCTAssertFalse(policy.allows(scheme: "app", host: "tenant-assets", port: 0))
        // An empty host is kept for custom schemes.
        XCTAssertTrue(policy.allows(scheme: "app", host: "", port: 0))
        // An explicit port 0 is not the same origin as no port.
        XCTAssertTrue(policy.allows(scheme: "custom", host: "portal", port: 0))
        XCTAssertFalse(policy.allows(scheme: "custom", host: "portal", port: 0, explicitPortZero: true))
        XCTAssertTrue(AuthFnBridgeOriginPolicy.hasExplicitPortZero("custom://portal:0/page"))
        XCTAssertFalse(AuthFnBridgeOriginPolicy.hasExplicitPortZero("custom://portal/page"))
    }

    func testOriginPolicyRefusesFilePagesBadPortsAndCanonicalizesIPv6() {
        let fileOnly = AuthFnBridgeOriginPolicy(trustedOrigins: [URL(fileURLWithPath: "/tmp/index.html")])
        XCTAssertTrue(fileOnly.trustedOrigins.isEmpty)
        XCTAssertFalse(fileOnly.allows(scheme: "file", host: "", port: 0))

        let badPort = AuthFnBridgeOriginPolicy(trustedOrigins: [URL(string: "https://example.test:999999999999999999999")!])
        XCTAssertTrue(badPort.trustedOrigins.isEmpty)
        XCTAssertFalse(badPort.allows(scheme: "https", host: "example.test", port: 0))

        let expanded = AuthFnBridgeOriginPolicy(trustedOrigins: [URL(string: "http://[0:0:0:0:0:0:0:1]:5173")!])
        XCTAssertTrue(expanded.allows(scheme: "http", host: "[::1]", port: 5173))

        XCTAssertTrue(AuthFnBridgeOriginPolicy.sameSchemeAndHost("app://portal:0/x", scheme: "app", host: "portal"))
        XCTAssertFalse(AuthFnBridgeOriginPolicy.sameSchemeAndHost("about:blank", scheme: "app", host: "portal"))
    }

    func testOriginPolicyNormalizesWebHostsLikeWebKit() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "https://%65xample.test")!,
            URL(string: "http://127.1:8080")!,
            URL(string: "http://0x7f.0.0.2")!,
        ])
        // WebKit reports these hosts decoded and in dotted-decimal form.
        XCTAssertTrue(policy.allows(scheme: "https", host: "example.test", port: 0))
        XCTAssertTrue(policy.allows(scheme: "http", host: "127.0.0.1", port: 8080))
        XCTAssertTrue(policy.allows(scheme: "http", host: "127.0.0.2", port: 0))

        // A non-ASCII host (not given in punycode) and an out-of-range port,
        // even next to credentials, are refused.
        let refused = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "https://user:test-password@example.test:65536/?q=1")!,
            URL(string: "https://%C3%A9xample.test")!,
        ])
        XCTAssertTrue(refused.trustedOrigins.isEmpty)
    }

    func testOriginPolicyParsesWebHostsAsWebKitDoes() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "http://127.0.0.0x")!,
            URL(string: "http://0300.0250.1")!,
            URL(string: "wss://portal.example:443")!,
            URL(string: "ws://portal.example:80")!,
        ])
        // A bare `0x` part is 0; octal parts; the last part fills the rest.
        XCTAssertTrue(policy.allows(scheme: "http", host: "127.0.0.0", port: 0))
        XCTAssertTrue(policy.allows(scheme: "http", host: "192.168.0.1", port: 0))
        // Default ports of ws and wss compare like no port.
        XCTAssertTrue(policy.allows(scheme: "wss", host: "portal.example", port: 0))
        XCTAssertTrue(policy.allows(scheme: "ws", host: "portal.example", port: 0))

        // A host that decodes to a forbidden character, or ends in a number
        // without being an IPv4 address, is refused, not read as another host.
        let refused = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "https://example.test%3A8443")!,
            URL(string: "https://example.test%2Fpath")!,
            URL(string: "http://example.123")!,
            URL(string: "http://256.1.1.1")!,
        ])
        XCTAssertTrue(refused.trustedOrigins.isEmpty)
        XCTAssertFalse(refused.allows(scheme: "https", host: "example.test", port: 8443))
    }

    func testOriginPolicyRefusesSpellingsWebKitRejects() {
        // Entries Foundation can hold (built from bytes) but WebKit refuses:
        // they must not turn into the origin they resemble.
        XCTAssertNil(AuthFnBridgeOriginPolicy.parse("http://[::1%00]"))
        XCTAssertNil(AuthFnBridgeOriginPolicy.parse("http://[::1\u{0}]"))
        XCTAssertNil(AuthFnBridgeOriginPolicy.parse("http://127.+0.0.1"))
        XCTAssertNil(AuthFnBridgeOriginPolicy.parse("https://example.test:+8443"))
        XCTAssertNil(AuthFnBridgeOriginPolicy.parse("http://0x+7f.0.0.1"))
        XCTAssertNil(AuthFnBridgeOriginPolicy.parse("http://08.0.0.1"))
        // Leading zeros do not make a valid part too long.
        let padded = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "http://127." + String(repeating: "0", count: 34) + ".0.1")!,
        ])
        XCTAssertTrue(padded.allows(scheme: "http", host: "127.0.0.1", port: 0))
        XCTAssertEqual(AuthFnBridgeOriginPolicy.parse("http://[::1]:8080"), "http://[::1]:8080")
    }

    func testOriginPolicyRefusesAnInheritedOriginWhosePortTheFrameCannotShow() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [
            URL(string: "https://portal.example")!,
            URL(string: "app://portal")!,
        ])
        XCTAssertTrue(policy.allowsMessage(scheme: "https", host: "portal.example", port: 0, frameURL: "https://portal.example/home"))
        XCTAssertTrue(policy.allowsMessage(scheme: "app", host: "portal", port: 0, frameURL: "app://portal/index.html"))
        // An about:blank page that inherited `https://portal.example:0` (or a
        // custom-scheme origin) reports port 0 without a URL that shows it.
        XCTAssertFalse(policy.allowsMessage(scheme: "https", host: "portal.example", port: 0, frameURL: "about:blank"))
        XCTAssertFalse(policy.allowsMessage(scheme: "app", host: "portal", port: 0, frameURL: "about:blank"))
        XCTAssertFalse(policy.allowsMessage(scheme: "https", host: "portal.example", port: 0, frameURL: "https://portal.example:0/home"))
        XCTAssertFalse(policy.allowsMessage(scheme: "https", host: "portal.example", port: 0, frameURL: ""))
    }

    func testOriginPolicyWithoutOriginsTrustsNothing() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [])
        XCTAssertFalse(policy.allows(scheme: "https", host: "app.example.com", port: 0))
    }
}
