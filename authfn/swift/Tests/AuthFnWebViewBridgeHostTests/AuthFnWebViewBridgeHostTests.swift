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

    func testOriginPolicyWithoutOriginsTrustsNothing() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [])
        XCTAssertFalse(policy.allows(scheme: "https", host: "app.example.com", port: 0))
    }
}
