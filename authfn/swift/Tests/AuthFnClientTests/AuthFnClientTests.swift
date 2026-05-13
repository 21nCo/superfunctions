import XCTest
@testable import AuthFnClient

final class AuthFnClientTests: XCTestCase {
    func testOAuthCallbackParsingUsesURLComponents() throws {
        let coordinator = AuthFnOAuthCoordinator()
        let callback = try coordinator.parseCallbackURL(
            URL(string: "nucleum://auth/callback?code=abc%20123&state=st_1")!
        )

        XCTAssertEqual(callback.code, "abc 123")
        XCTAssertEqual(callback.state, "st_1")
    }

    func testRegionCacheNormalizesAndExpiresEntries() async {
        let cache = AuthFnRegionCache()
        await cache.set(identifier: " Ada@Example.COM ", regionId: "eu-west-1", authority: "https://eu.example.com", ttl: 60)

        let entry = await cache.get(identifier: "ada@example.com")
        XCTAssertEqual(entry?.regionId, "eu-west-1")
    }

    func testInMemoryCredentialStoreRoundTrip() async throws {
        let store = AuthFnInMemoryCredentialStore()
        let credential = AuthFnSessionCredential(
            session: AuthFnSession(
                id: "sess_1",
                actorId: "user_1",
                regionId: "us-east-1",
                primaryEmail: "ada@example.com",
                methods: ["password"]
            ),
            token: "st_123"
        )

        try await store.saveCredential(credential)
        let loaded = try await store.loadCredential()
        XCTAssertEqual(loaded, credential)

        try await store.clearCredential()
        let cleared = try await store.loadCredential()
        XCTAssertNil(cleared)
    }
}
