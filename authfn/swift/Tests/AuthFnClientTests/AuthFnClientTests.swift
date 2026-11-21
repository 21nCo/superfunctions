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

    func testOAuthCallbackParsingReadsFragmentValues() {
        let coordinator = AuthFnOAuthCoordinator()
        let url = URL(string: "nucleum://oauthsignin#token=st_1&signup=true&regionId=insouth")!

        XCTAssertEqual(coordinator.callbackValue(url, name: "token"), "st_1")
        XCTAssertEqual(coordinator.callbackValue(url, name: "signup"), "true")
        XCTAssertEqual(coordinator.callbackValue(url, name: "regionId"), "insouth")
    }

    func testAppleAuthorizeContextExtractsStateAndNonceWithoutTrustingRedirectUri() {
        let coordinator = AuthFnOAuthCoordinator()
        let url = URL(string: "https://appleid.apple.com/auth/authorize?state=st_1&nonce=nonce_1&redirect_uri=https%3A%2F%2Faccount-insouth-dev.nucleum.app%2Fauth%2Fsocial%2Fcallback%2Fapple")!

        let context = coordinator.appleAuthorizeContext(from: url)

        XCTAssertEqual(context?.stateId, "st_1")
        XCTAssertEqual(context?.nonce, "nonce_1")
        XCTAssertNil(context?.accountBaseURL)
    }

    func testRegionCacheNormalizesAndExpiresEntries() async {
        let cache = AuthFnRegionCache()
        await cache.set(identifier: " Ada@Example.COM ", regionId: "eu-west-1", authority: "https://eu.example.com", ttl: 60)

        let entry = await cache.get(identifier: "ada@example.com")
        XCTAssertEqual(entry?.regionId, "eu-west-1")

        await cache.set(identifier: "expired@example.com", regionId: "us-east-1", authority: "https://us.example.com", ttl: -1)
        let expired = await cache.get(identifier: "expired@example.com")
        XCTAssertNil(expired)
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

    func testVerifyEmailRequiresTheHolderUnlessClaimingOnPurpose() {
        // A stored session is always sent with the holder guard, so an
        // expired one is refused rather than taken as a mailbox claim.
        let holder = AuthFnClient.emailVerificationPlan(storedToken: "test-session-token", claimAccount: false)
        XCTAssertEqual(holder?.bearerToken, "test-session-token")
        XCTAssertEqual(holder?.requireAccountHolder, true)
        // No session and no explicit claim: nothing is sent.
        XCTAssertNil(AuthFnClient.emailVerificationPlan(storedToken: nil, claimAccount: false))
        // An explicit claim sends neither a session nor the guard.
        let claim = AuthFnClient.emailVerificationPlan(storedToken: "test-session-token", claimAccount: true)
        XCTAssertNil(claim?.bearerToken)
        XCTAssertEqual(claim?.requireAccountHolder, false)
    }

    func testVerifyEmailSendsTheStoredSessionAsBearer() async throws {
        let store = AuthFnInMemoryCredentialStore()
        try await store.saveCredential(AuthFnSessionCredential(
            session: AuthFnSession(id: "sess_1", actorId: "user_1", regionId: "us-east-1", primaryEmail: "ada@example.com", methods: ["password"]),
            token: "test-session-token"
        ))
        let client = AuthFnClient(
            configuration: AuthFnConfiguration(defaultRegionId: "us-east-1", baseURL: URL(string: "https://account.example.com/auth")!, urlSession: StubURLProtocol.session()),
            credentialStore: store
        )

        let verified = try await client.verifyEmail(email: "ada@example.com", code: "123456")
        XCTAssertTrue(verified)
        let verify = StubURLProtocol.log.all().first { $0.url?.path.hasSuffix("/otp/verify") == true }
        XCTAssertEqual(verify?.value(forHTTPHeaderField: "authorization"), "Bearer test-session-token")

        // Through verifyOtp the stored credential comes back unchanged.
        StubURLProtocol.log.clear()
        let credential = try await client.verifyOtp(email: "ada@example.com", code: "123456", purpose: "verify-email")
        XCTAssertEqual(credential.token, "test-session-token")
        XCTAssertEqual(
            StubURLProtocol.log.all().first { $0.url?.path.hasSuffix("/otp/verify") == true }?.value(forHTTPHeaderField: "authorization"),
            "Bearer test-session-token"
        )

        // Without a stored session for this email, verifyOtp sends nothing.
        StubURLProtocol.log.clear()
        let signedOut = AuthFnClient(
            configuration: AuthFnConfiguration(defaultRegionId: "us-east-1", baseURL: URL(string: "https://account.example.com/auth")!, urlSession: StubURLProtocol.session()),
            credentialStore: AuthFnInMemoryCredentialStore()
        )
        do {
            _ = try await signedOut.verifyOtp(email: "ada@example.com", code: "123456", purpose: "verify-email")
            XCTFail("expected unauthenticated")
        } catch AuthFnError.unauthenticated {
        }
        do {
            _ = try await client.verifyOtp(email: "bea@example.com", code: "123456", purpose: "verify-email")
            XCTFail("expected unauthenticated for another account's email")
        } catch AuthFnError.unauthenticated {
        }
        XCTAssertTrue(StubURLProtocol.log.all().filter { $0.url?.path.hasSuffix("/otp/verify") == true }.isEmpty)

        StubURLProtocol.log.clear()
        _ = try await client.verifyOtp(email: "ada@example.com", code: "123456", purpose: "sign-in")
        let signIn = StubURLProtocol.log.all().first { $0.url?.path.hasSuffix("/otp/verify") == true }
        XCTAssertNil(signIn?.value(forHTTPHeaderField: "authorization"))
    }
}

/// Requests seen by StubURLProtocol, safe to read from the test.
final class StubRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    func append(_ request: URLRequest) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
    }

    func all() -> [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        requests.removeAll()
    }
}

/// Answers every request with a success envelope and records what was sent.
final class StubURLProtocol: URLProtocol {
    static let log = StubRequestLog()

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        StubURLProtocol.log.append(request)
        let body: String
        if request.url?.path.hasSuffix("/otp/verify") == true && request.value(forHTTPHeaderField: "authorization") != nil {
            // In these tests only verify-email sends a bearer token; this is
            // what the server answers for a verify-email code.
            body = #"{"ok":true,"data":{"verified":true}}"#
        } else if request.url?.path.hasSuffix("/regions/lookup") == true {
            body = #"{"ok":true,"data":{"identifier":"ada@example.com","regionId":"us-east-1","authority":"https://account.example.com","continueLocally":true}}"#
        } else {
            body = #"{"ok":true,"data":{"session":{"id":"sess_2","actorId":"user_1","regionId":"us-east-1","primaryEmail":"ada@example.com","methods":["email-otp"]},"token":"test-new-session-token"}}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
