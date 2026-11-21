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

    func testOriginPolicyWithoutOriginsTrustsNothing() {
        let policy = AuthFnBridgeOriginPolicy(trustedOrigins: [])
        XCTAssertFalse(policy.allows(scheme: "https", host: "app.example.com", port: 0))
    }
}
