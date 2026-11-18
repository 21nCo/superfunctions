import BillFnClient
import BillFnStoreKit
import Foundation
import StoreKit
import Testing

/// Answers every request of a stubbed URLSession with the queued response and records the request.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Recorded {
        let request: URLRequest
        let body: BillFnJSONValue?
    }

    nonisolated(unsafe) static var response: (status: Int, body: String) = (200, "{}")
    nonisolated(unsafe) static var recorded: [Recorded] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var data = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
        }
        let body = data.isEmpty ? nil : try? JSONDecoder().decode(BillFnJSONValue.self, from: data)
        Self.recorded.append(Recorded(request: request, body: body))
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.response.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.response.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func backend(status: Int = 200, body: String) -> BillFnHTTPStoreKitBackend {
    StubURLProtocol.response = (status, body)
    StubURLProtocol.recorded = []
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let client = BillFnClient(
        configuration: BillFnClientConfiguration(
            baseURL: URL(string: "https://billfn.example.test/billfn")!,
            session: URLSession(configuration: configuration),
            headers: { ["Authorization": "Bearer session_1"] }
        )
    )
    return BillFnHTTPStoreKitBackend(client: client)
}

private let token = "00000000-0000-4000-8000-00000000000a"
private let transaction = BillFnStoreKitTransactionReference(
    transactionId: "2000000002",
    originalTransactionId: "2000000001",
    productId: "apple.pro.month",
    appAccountToken: UUID(uuidString: token)
)

private func checkoutResponse(action: String) -> String {
    #"{"ok":true,"data":{"checkoutSession":{"checkoutSessionId":"chk_1","status":"requires_action","clientAction":\#(action)}},"meta":{"timestamp":"2026-11-17T00:00:00.000Z"}}"#
}

@Suite("BillFn StoreKit backend", .serialized)
struct BillFnStoreKitBackendTests {
    @Test("Opens an Apple checkout and returns its product and appAccountToken")
    func createsCheckout() async throws {
        let backend = backend(body: checkoutResponse(action: #"{"type":"apple-purchase","productId":"apple.pro.month","metadata":{"appAccountToken":"\#(token)"}}"#))

        let checkout = try await backend.createCheckout(BillFnStoreKitCheckoutRequest(planKey: "pro", priceId: "price_pro_apple_month"))

        #expect(checkout == BillFnStoreKitCheckout(checkoutSessionId: "chk_1", productId: "apple.pro.month", appAccountToken: UUID(uuidString: token)!))
        let sent = try #require(StubURLProtocol.recorded.first)
        #expect(sent.request.url?.absoluteString == "https://billfn.example.test/billfn/checkouts")
        #expect(sent.request.httpMethod == "POST")
        #expect(sent.request.value(forHTTPHeaderField: "Authorization") == "Bearer session_1")
        #expect(sent.body == .object(["planKey": "pro", "provider": "apple", "priceId": "price_pro_apple_month"]))
    }

    @Test("Rejects a checkout that is not a usable Apple purchase", arguments: [
        #"{"type":"redirect","url":"https://checkout.example.test"}"#,
        #"{"type":"apple-purchase","metadata":{"appAccountToken":"00000000-0000-4000-8000-00000000000a"}}"#,
        #"{"type":"apple-purchase","productId":"apple.pro.month","metadata":{}}"#,
        #"{"type":"apple-purchase","productId":"apple.pro.month","metadata":{"appAccountToken":"acct_1"}}"#,
    ])
    func rejectsUnusableCheckouts(action: String) async throws {
        let backend = backend(body: checkoutResponse(action: action))

        await #expect {
            _ = try await backend.createCheckout(BillFnStoreKitCheckoutRequest(planKey: "pro"))
        } throws: { error in
            if case BillFnStoreKitError.invalidCheckout = error { return true }
            return false
        }
    }

    @Test("Verifies a transaction against its checkout session")
    func verifiesCheckout() async throws {
        let backend = backend(body: #"{"ok":true,"data":{"subscription":{"status":"active"}}}"#)

        let billing = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)

        #expect(billing == .object(["subscription": .object(["status": "active"])]))
        let sent = try #require(StubURLProtocol.recorded.first)
        #expect(sent.request.url?.path == "/billfn/checkouts/verify")
        #expect(sent.body == .object([
            "checkoutSessionId": "chk_1",
            "payload": .object(["transactionId": "2000000002", "originalTransactionId": "2000000001"]),
        ]))
    }

    @Test("Restores a transaction onto its plan by the original transaction id")
    func restoresPurchase() async throws {
        let backend = backend(body: #"{"ok":true,"data":{"subscription":{"status":"active"}}}"#)

        _ = try await backend.restorePurchase(
            plan: BillFnStoreKitPlan(productId: "apple.pro.month", planKey: "pro", priceId: "price_pro_apple_month"),
            transaction: transaction
        )

        let sent = try #require(StubURLProtocol.recorded.first)
        #expect(sent.request.url?.path == "/billfn/purchases/restore")
        #expect(sent.body == .object([
            "planKey": "pro",
            "provider": "apple",
            "priceId": "price_pro_apple_month",
            "purchaseReference": "2000000001",
            "payload": .object(["transactionId": "2000000002", "originalTransactionId": "2000000001"]),
        ]))
    }

    @Test("Turns a BillFn error envelope into a server error with its code")
    func surfacesErrorEnvelopes() async throws {
        let backend = backend(status: 409, body: #"{"ok":false,"error":{"code":"BILLFN_CONFLICT","message":"Checkout session does not belong to the resolved billing account","status":409,"retryable":false}}"#)

        await #expect(throws: BillFnClientError.server(
            code: "BILLFN_CONFLICT",
            message: "Checkout session does not belong to the resolved billing account",
            status: 409,
            retryable: false
        )) {
            _ = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)
        }
    }

    @Test("Rejects a response that is not a BillFn envelope", arguments: [
        (200, "<html>gateway</html>"),
        (200, #"{"ok":false}"#),
        (200, #"{"ok":true}"#),
    ])
    func rejectsNonEnvelopes(status: Int, body: String) async throws {
        let backend = backend(status: status, body: body)

        await #expect(throws: BillFnClientError.invalidResponse) {
            _ = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)
        }
    }

    @Test("Keeps the HTTP status of an error response that is not a BillFn envelope", arguments: [
        (502, "<html>Bad Gateway</html>", true),
        (503, "", true),
        (504, "upstream timed out", true),
        (408, "", true),
        (429, "Too Many Requests", true),
        (404, "<html>Not Found</html>", false),
        // Malformed or success-shaped envelopes with an error status keep the status too.
        (503, #"{"ok":false}"#, true),
        (502, #"{"ok":true,"data":{}}"#, true),
        (500, #"{"ok":false,"error":"down"}"#, true),
        (400, #"{"ok":false}"#, false),
    ])
    func classifiesNonEnvelopeErrors(status: Int, body: String, retryable: Bool) async throws {
        let backend = backend(status: status, body: body)
        let expected = BillFnClientError.server(
            code: "BILLFN_HTTP_ERROR", message: "BillFn request failed with HTTP \(status)", status: status, retryable: retryable
        )

        await #expect(throws: expected) {
            _ = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)
        }
        #expect(BillFnStoreKitFailure(error: expected).retryable == retryable)
    }

    @Test("Maps errors to the failure a transaction outcome reports")
    func mapsFailures() {
        #expect(BillFnStoreKitFailure(error: BillFnClientError.server(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", status: 502, retryable: true))
            == BillFnStoreKitFailure(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", retryable: true))
        #expect(BillFnStoreKitFailure(error: URLError(.notConnectedToInternet)).code == "BILLFN_NETWORK_ERROR")
        #expect(BillFnStoreKitFailure(error: URLError(.notConnectedToInternet)).retryable)
        let storeKitNetwork = BillFnStoreKitFailure(error: StoreKitError.networkError(URLError(.notConnectedToInternet)))
        #expect(storeKitNetwork.code == "BILLFN_NETWORK_ERROR")
        #expect(storeKitNetwork.retryable)
        let storeKitSystem = BillFnStoreKitFailure(error: StoreKitError.systemError(URLError(.cannotLoadFromNetwork)))
        #expect(storeKitSystem.code == "BILLFN_STOREKIT_FAILED")
        #expect(storeKitSystem.retryable)
        #expect(BillFnStoreKitFailure(error: StoreKitError.notAvailableInStorefront) == BillFnStoreKitFailure(
            code: "BILLFN_STOREKIT_FAILED", message: StoreKitError.notAvailableInStorefront.localizedDescription, retryable: false
        ))
        #expect(BillFnStoreKitFailure(error: BillFnClientError.invalidResponse).code == "BILLFN_INVALID_RESPONSE")
        #expect(BillFnStoreKitFailure(error: BillFnStoreKitError.productNotFound("apple.pro.month")).code == "BILLFN_STOREKIT_ERROR")
    }

    @Test("Keeps each checkout by its session until that session is removed")
    func storesCheckouts() throws {
        let defaults = try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults)
        let account = UUID(uuidString: token)!
        let first = BillFnStoreKitCheckout(checkoutSessionId: "chk_1", productId: "apple.pro.month", appAccountToken: account)
        let second = BillFnStoreKitCheckout(checkoutSessionId: "chk_2", productId: "apple.pro.month", appAccountToken: account)
        let yearly = BillFnStoreKitCheckout(checkoutSessionId: "chk_3", productId: "apple.pro.year", appAccountToken: account)

        store.save(first)
        store.save(second)
        store.save(yearly)

        // A second attempt on the same product does not replace the first one's checkout.
        #expect(BillFnUserDefaultsCheckoutStore(defaults: defaults).checkouts(forProductId: "apple.pro.month") == [first, second])
        #expect(store.checkouts(forProductId: "apple.pro.year") == [yearly])
        // Removing (cancelling or confirming) the second attempt keeps the first.
        store.removeCheckout(checkoutSessionId: "chk_2")
        #expect(store.checkouts(forProductId: "apple.pro.month") == [first])
        store.removeCheckout(checkoutSessionId: "chk_1")
        #expect(store.checkouts(forProductId: "apple.pro.month").isEmpty)
        #expect(store.checkouts(forProductId: "apple.pro.year") == [yearly])
    }

    @Test("Keeps an outstanding checkout for its retention however many attempts are saved and cancelled meanwhile")
    func keepsOutstandingCheckoutsForTheirRetention() throws {
        let defaults = try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults, retention: 7 * day, now: { clock.now })
        let account = UUID(uuidString: token)!
        let pending = BillFnStoreKitCheckout(checkoutSessionId: "chk_pending", productId: "apple.pro.month", appAccountToken: account)
        store.save(pending)

        // Many later attempts, most cancelled and some left behind, do not push the pending one out.
        for index in 0..<200 {
            clock.advance(by: 60)
            store.save(BillFnStoreKitCheckout(checkoutSessionId: "chk_\(index)", productId: "apple.pro.month", appAccountToken: account))
            if index % 4 != 0 { store.removeCheckout(checkoutSessionId: "chk_\(index)") }
        }
        clock.advance(by: 6 * day)
        #expect(store.checkouts(forProductId: "apple.pro.month").first == pending)
        #expect(store.checkouts(forProductId: "apple.pro.month").count == 51)

        // 30 seconds past its retention the pending attempt can no longer complete, so pruning drops it; the
        // attempts saved a minute or more after it stay.
        clock.advance(by: day - 200 * 60 + 30)
        let later = BillFnUserDefaultsCheckoutStore(defaults: defaults, retention: 7 * day, now: { clock.now })
        later.removeExpiredOutstandingCheckouts(excluding: [])
        let kept = later.checkouts(forProductId: "apple.pro.month").map(\.checkoutSessionId)
        #expect(!kept.contains("chk_pending"))
        #expect(kept.first == "chk_0")
        clock.advance(by: day)
        store.removeExpiredOutstandingCheckouts(excluding: [])
        #expect(store.checkouts(forProductId: "apple.pro.month").isEmpty)
    }

    @Test("Reads an expired outstanding checkout until it is pruned, and pruning keeps matched and excluded ones")
    func prunesExpiredOutstandingCheckoutsOnlyWhenAsked() throws {
        let defaults = try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults, retention: 7 * day, now: { clock.now })
        let account = UUID(uuidString: token)!
        let expired = BillFnStoreKitCheckout(checkoutSessionId: "chk_expired", productId: "apple.pro.month", appAccountToken: account)
        let claimed = BillFnStoreKitCheckout(checkoutSessionId: "chk_claimed", productId: "apple.pro.month", appAccountToken: account)
        let matched = BillFnStoreKitCheckout(checkoutSessionId: "chk_matched", productId: "apple.pro.year", appAccountToken: account)
        let young = BillFnStoreKitCheckout(checkoutSessionId: "chk_young", productId: "apple.pro.year", appAccountToken: account)
        store.save(expired)
        store.save(claimed)
        store.save(matched)
        store.markMatched(matched, transactionId: "2000000001")
        clock.advance(by: 7 * day - 60)
        store.save(young)
        clock.advance(by: 2 * day)

        // Past its retention, an outstanding checkout is still read (and so still claimable by a transaction that
        // completed while the app was not running) by this and any other store, until a prune removes it.
        let reread = BillFnUserDefaultsCheckoutStore(defaults: defaults, retention: 7 * day, now: { clock.now })
        #expect(reread.keptCheckouts().map(\.checkout) == [expired, claimed, matched, young])
        #expect(store.checkouts(forProductId: "apple.pro.month") == [expired, claimed])

        store.removeExpiredOutstandingCheckouts(excluding: ["chk_claimed"])

        let kept = reread.keptCheckouts()
        #expect(kept.map(\.checkout) == [claimed, matched, young])
        #expect(kept.map(\.transactionId) == [nil, "2000000001", nil])
    }

    @Test("Records the newest confirmed transactions across stores")
    func recordsConfirmedTransactions() throws {
        let defaults = try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults)
        store.recordConfirmed(transactionId: "2000000001")
        store.recordConfirmed(transactionId: "2000000002")
        store.recordConfirmed(transactionId: "2000000001")

        let reread = BillFnUserDefaultsCheckoutStore(defaults: defaults)
        #expect(reread.isConfirmed(transactionId: "2000000001"))
        #expect(reread.isConfirmed(transactionId: "2000000002"))
        #expect(!reread.isConfirmed(transactionId: "2000000003"))
        // A separate key: confirmed transactions are not kept checkouts.
        #expect(reread.keptCheckouts().isEmpty)

        for index in 1..<BillFnUserDefaultsCheckoutStore.confirmedTransactionLimit {
            store.recordConfirmed(transactionId: "3\(index)")
        }
        // The re-recorded 2000000001 is newer than 2000000002, so only 2000000002 is forgotten.
        #expect(!reread.isConfirmed(transactionId: "2000000002"))
        #expect(reread.isConfirmed(transactionId: "2000000001"))
        #expect(reread.isConfirmed(transactionId: "31"))
    }

    @Test("Two stores on the same defaults changing them at once lose no checkout or confirmed transaction")
    func storesOnSharedDefaultsLoseNothing() throws {
        let suiteName = "billfn.storekit.backend-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        // As two `BillFnStoreKit`s with default stores share UserDefaults.standard and the key.
        let stores = [BillFnUserDefaultsCheckoutStore(defaults: defaults), BillFnUserDefaultsCheckoutStore(defaults: defaults)]
        let account = UUID(uuidString: token)!
        let count = 120

        DispatchQueue.concurrentPerform(iterations: count) { index in
            let store = stores[index % 2]
            let checkout = BillFnStoreKitCheckout(checkoutSessionId: "chk_\(index)", productId: "apple.pro.month", appAccountToken: account)
            store.save(checkout)
            store.markMatched(checkout, transactionId: "2\(index)")
            store.recordConfirmed(transactionId: "2\(index)")
        }

        let reread = BillFnUserDefaultsCheckoutStore(defaults: defaults)
        let kept = reread.keptCheckouts()
        #expect(Set(kept.map(\.checkout.checkoutSessionId)) == Set((0..<count).map { "chk_\($0)" }))
        #expect(kept.allSatisfy { $0.transactionId == "2\($0.checkout.checkoutSessionId.dropFirst(4))" })
        #expect((0..<count).allSatisfy { reread.isConfirmed(transactionId: "2\($0)") })
    }

    @Test("Keeps a checkout matched to a transaction past its retention until it is removed")
    func keepsMatchedCheckouts() throws {
        let defaults = try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults, retention: 7 * day, now: { clock.now })
        let account = UUID(uuidString: token)!
        let matched = BillFnStoreKitCheckout(checkoutSessionId: "chk_1", productId: "apple.pro.month", appAccountToken: account)
        let outstanding = BillFnStoreKitCheckout(checkoutSessionId: "chk_2", productId: "apple.pro.month", appAccountToken: account)
        // A checkout another store dropped is kept again once a transaction is matched to it.
        let unkept = BillFnStoreKitCheckout(checkoutSessionId: "chk_3", productId: "apple.pro.year", appAccountToken: account)
        store.save(matched)
        store.save(outstanding)
        // Recorded before BillFn verifies the transaction, so a verify call that fails leaves the checkout kept.
        store.markMatched(matched, transactionId: "2000000001")
        store.markMatched(unkept, transactionId: "2000000002")

        clock.advance(by: 30 * day)
        let later = BillFnUserDefaultsCheckoutStore(defaults: defaults, retention: 7 * day, now: { clock.now })
        later.removeExpiredOutstandingCheckouts(excluding: [])
        let kept = later.keptCheckouts()
        #expect(kept.map(\.checkout) == [matched, unkept])
        #expect(kept.map(\.transactionId) == ["2000000001", "2000000002"])
        #expect(kept.first?.savedAt == Date(timeIntervalSince1970: 1_800_000_000))
        store.removeCheckout(checkoutSessionId: "chk_1")
        #expect(store.keptCheckouts().map(\.checkout) == [unkept])
    }
}

private let day: TimeInterval = 24 * 60 * 60

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)

    var now: Date { lock.withLock { current } }

    func advance(by interval: TimeInterval) {
        lock.withLock { current += interval }
    }
}

