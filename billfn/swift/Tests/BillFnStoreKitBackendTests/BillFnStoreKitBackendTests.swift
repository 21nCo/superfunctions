import BillFnClient
@testable import BillFnStoreKit
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

    @Test("Rejects a checkout with an empty checkoutSessionId, which no transaction could be verified against")
    func rejectsAnEmptyCheckoutSessionId() async throws {
        let body = #"{"ok":true,"data":{"checkoutSession":{"checkoutSessionId":"","status":"requires_action","clientAction":{"type":"apple-purchase","productId":"apple.pro.month","metadata":{"appAccountToken":"00000000-0000-4000-8000-00000000000a"}}}}}"#

        await #expect(throws: BillFnStoreKitError.invalidCheckout("missing checkoutSessionId")) {
            _ = try await backend(body: body).createCheckout(BillFnStoreKitCheckoutRequest(planKey: "pro"))
        }
    }

    @Test("Verifies a transaction against its checkout session")
    func verifiesCheckout() async throws {
        let backend = backend(body: #"{"ok":true,"data":{"checkoutSession":{"checkoutSessionId":"chk_1"},"subscription":{"status":"active","currentPeriodEnd":null},"entitlements":{}}}"#)

        let billing = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)

        #expect(billing["checkoutSession"]?["checkoutSessionId"] == "chk_1")
        #expect(billing["subscription"] == .object(["status": "active", "currentPeriodEnd": .null]))
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

    @Test("An ok:false envelope without a BillFn error code and message keeps the HTTP error", arguments: [
        #"{"ok":false,"error":{}}"#,
        #"{"ok":false,"error":{"code":"","message":""}}"#,
        #"{"ok":false,"error":{"code":"BILLFN_CONFLICT"}}"#,
        #"{"ok":false,"error":{"code":7,"message":"Conflict"}}"#,
    ])
    func malformedErrorEnvelopeKeepsTheHTTPError(body: String) async throws {
        await #expect(throws: BillFnClientError.server(
            code: "BILLFN_HTTP_ERROR", message: "BillFn request failed with HTTP 403", status: 403, retryable: false
        )) {
            _ = try await backend(status: 403, body: body).verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)
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

    @Test("Keeps each checkout by its session; a cancelled attempt removes only its own outstanding checkout")
    func storesCheckouts() throws {
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults())
        let first = checkout("chk_1")
        let second = checkout("chk_2")
        let yearly = BillFnStoreKitCheckout(checkoutSessionId: "chk_3", productId: "apple.pro.year", appAccountToken: account)

        store.save(first)
        store.save(second)
        store.save(yearly)

        // A second attempt on the same product does not replace the first one's checkout.
        #expect(store.checkouts(forProductId: "apple.pro.month") == [first, second])
        #expect(store.checkouts(forProductId: "apple.pro.year") == [yearly])
        store.removeOutstandingCheckout(checkoutSessionId: "chk_2")
        #expect(store.checkouts(forProductId: "apple.pro.month") == [first])
        // A transaction bound to the checkout meanwhile keeps it: the attempt's cancel is no evidence about it.
        #expect(store.claim(facts("2000000001"), purchasedWith: nil) == first)
        store.removeOutstandingCheckout(checkoutSessionId: "chk_1")
        #expect(store.keptCheckouts().map(\.transactionId) == ["2000000001", nil])
        store.removeCheckout(checkoutSessionId: "chk_1", boundTo: "2000000001")
        #expect(store.checkouts(forProductId: "apple.pro.month").isEmpty)
        #expect(store.checkouts(forProductId: "apple.pro.year") == [yearly])
    }

    @Test("Never removes an outstanding checkout because time passed, and removes a bound one only once its transaction is finished")
    func removesCheckoutsOnlyOnEvidence() throws {
        let defaults = try freshDefaults()
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults, now: { clock.now })
        store.save(checkout("chk_outstanding"))
        clock.advance(by: 60)
        for (id, state) in [("1", BillFnStoreKitConfirmationState.pending), ("2", .confirmed), ("3", .finished)] {
            store.save(checkout("chk_\(id)"))
            #expect(store.claim(facts(id, purchased: clock.now), purchasedWith: checkout("chk_\(id)")) == checkout("chk_\(id)"))
            store.record(facts(id, purchased: clock.now), state: state, resolution: .checkout("chk_\(id)"))
        }

        // Two reconciliations a grace period apart, a year on, with no transaction listed: only the finished one goes.
        clock.advance(by: 365 * day)
        store.removeUnneededCheckouts()
        clock.advance(by: 2 * day)
        BillFnUserDefaultsCheckoutStore(defaults: defaults, now: { clock.now }).removeUnneededCheckouts()
        #expect(store.keptCheckouts().map(\.checkout.checkoutSessionId) == ["chk_outstanding", "chk_1", "chk_2"])
        #expect(store.keptCheckouts().map(\.transactionId) == [nil, "1", "2"])
        // A purchase that completed while the app was stopped still claims the outstanding checkout.
        #expect(store.claim(facts("4", purchased: clock.now), purchasedWith: nil) == checkout("chk_outstanding"))
    }

    @Test("Binds one checkout to at most one transaction across stores sharing the defaults")
    func claimsAtomicallyAcrossStores() throws {
        let defaults = try freshDefaults()
        let clock = TestClock()
        let stores = [
            BillFnUserDefaultsCheckoutStore(defaults: defaults, now: { clock.now }),
            BillFnUserDefaultsCheckoutStore(defaults: defaults, now: { clock.now }),
        ]
        stores[0].save(checkout("chk_shared"))
        let count = 64
        let winners = Winners()
        DispatchQueue.concurrentPerform(iterations: count) { index in
            if stores[index % 2].claim(facts("3\(index)", purchased: clock.now.addingTimeInterval(60)), purchasedWith: nil) != nil {
                winners.add("3\(index)")
            }
        }
        #expect(winners.ids.count == 1)
        let winner = try #require(winners.ids.first)
        #expect(stores[1].keptCheckouts().map(\.transactionId) == [winner])
        // The winner is offered it again; another transaction is not, not even as its purchase's own checkout.
        #expect(stores[1].claim(facts(winner, purchased: clock.now.addingTimeInterval(60)), purchasedWith: nil) == checkout("chk_shared"))
        #expect(stores[0].claim(facts("4000", purchased: clock.now.addingTimeInterval(60)), purchasedWith: checkout("chk_shared")) == nil)
        // Another transaction finishing removes only its own checkout: the winner's binding survives.
        stores[0].record(facts("4000", purchased: clock.now), state: .finished, resolution: .checkout("chk_shared"))
        stores[0].removeCheckout(checkoutSessionId: "chk_shared", boundTo: "4000")
        stores[1].removeUnneededCheckouts()
        #expect(stores[0].keptCheckouts().map(\.transactionId) == [winner])
    }

    /// Another pass bound the transaction to an older checkout and is verifying against it when the purchase's own
    /// checkout is bound too. Each binding keeps its own confirmation: the older checkout never becomes outstanding,
    /// confirming and finishing against it removes only it, and the purchase's checkout, not confirmed, still waits.
    @Test("A purchase's own checkout is bound to its transaction beside another binding, each confirmed on its own")
    func purchaseCheckoutBindsBesideAnotherBinding() throws {
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults(), now: { clock.now })
        store.save(checkout("chk_a"))
        clock.advance(by: 60)
        store.save(checkout("chk_b"))
        let transaction = facts("5", purchased: clock.now)
        #expect(store.claim(transaction, purchasedWith: nil) == checkout("chk_a"))
        #expect(store.claim(transaction, purchasedWith: checkout("chk_b")) == checkout("chk_b"))
        #expect(store.keptCheckouts().map(\.transactionId) == ["5", "5"])

        store.record(transaction, state: .finished, resolution: .checkout("chk_a"))
        store.removeCheckout(checkoutSessionId: "chk_a", boundTo: "5")
        store.removeUnneededCheckouts()
        #expect(store.keptCheckouts() == [BillFnStoreKitKeptCheckout(checkout: checkout("chk_b"), savedAt: clock.now, transactionId: "5")])
        // A retry of the transaction without its purchase verifies against the binding BillFn has not confirmed.
        #expect(store.claim(transaction, purchasedWith: nil) == checkout("chk_b"))
    }

    @Test("A confirmed, renewed or older transaction claims no outstanding checkout")
    func claimsOnlyEligibleOutstandingCheckouts() throws {
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults(), now: { clock.now })
        let purchased = clock.now
        clock.advance(by: 60 * 60)
        store.save(checkout("chk_later"))
        #expect(store.claim(facts("6", purchased: purchased), purchasedWith: nil) == nil)
        #expect(store.claim(facts("7", purchased: clock.now, isPurchase: false), purchasedWith: nil) == nil)
        #expect(store.claim(facts("8", purchased: clock.now, isPurchase: nil), purchasedWith: nil) == nil)
        store.record(facts("9", purchased: clock.now), state: .confirmed, resolution: nil)
        #expect(store.claim(facts("9", purchased: clock.now), purchasedWith: nil) == nil)
        #expect(store.keptCheckouts().map(\.transactionId) == [nil])
    }

    @Test("Keeps a confirmed record while a kept checkout could be claimed by its transaction, however many follow")
    func keepsRecordsWhileTheyMatter() throws {
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults(), now: { clock.now })
        let confirmed = facts("10", purchased: clock.now)
        store.record(confirmed, state: .finished, resolution: nil)
        clock.advance(by: 5 * 60)
        store.save(checkout("chk_newer"))
        clock.advance(by: day)
        for index in 0...BillFnUserDefaultsCheckoutStore.confirmedTransactionLimit {
            store.record(facts("6\(index)", purchased: clock.now.addingTimeInterval(-day), product: "apple.pro.year"), state: .finished, resolution: nil)
        }
        // A replay of the confirmed transaction still claims nothing.
        #expect(store.isFinished(transactionId: "10"))
        #expect(store.claim(confirmed, purchasedWith: nil) == nil)
        #expect(store.keptCheckouts().map(\.transactionId) == [nil])
        // Once nothing could claim the checkout, the oldest records beyond the limit go; pending ones never do.
        store.record(facts("11", purchased: clock.now.addingTimeInterval(-day), product: "apple.pro.year"), state: .pending, resolution: nil)
        store.removeOutstandingCheckout(checkoutSessionId: "chk_newer")
        store.record(facts("12", purchased: clock.now.addingTimeInterval(-day), product: "apple.pro.year"), state: .finished, resolution: nil)
        #expect(store.record(transactionId: "10") == nil)
        #expect(store.record(transactionId: "60") == nil)
        #expect(store.record(transactionId: "11")?.state == .pending)
        #expect(store.isFinished(transactionId: "12"))
    }

    @Test("A recorded state never moves back, and stores on the same defaults lose no change")
    func recordsAcrossStores() throws {
        let defaults = try freshDefaults()
        let stores = [BillFnUserDefaultsCheckoutStore(defaults: defaults), BillFnUserDefaultsCheckoutStore(defaults: defaults)]
        stores[0].record(facts("20", purchased: Date()), state: .confirmed, resolution: nil)
        stores[1].record(facts("20", purchased: Date()), state: .pending, resolution: nil)
        #expect(stores[0].isConfirmed(transactionId: "20"))
        #expect(!stores[0].isFinished(transactionId: "20"))

        let count = 120
        DispatchQueue.concurrentPerform(iterations: count) { index in
            let store = stores[index % 2]
            store.save(checkout("chk_\(index)"))
            _ = store.claim(facts("2\(index)", purchased: Date()), purchasedWith: checkout("chk_\(index)"))
            store.record(facts("2\(index)", purchased: Date()), state: .confirmed, resolution: nil)
        }

        let reread = BillFnUserDefaultsCheckoutStore(defaults: defaults)
        let kept = reread.keptCheckouts()
        #expect(Set(kept.map(\.checkout.checkoutSessionId)) == Set((0..<count).map { "chk_\($0)" }))
        #expect(kept.allSatisfy { $0.transactionId == "2\($0.checkout.checkoutSessionId.dropFirst(4))" })
        #expect((0..<count).allSatisfy { reread.isConfirmed(transactionId: "2\($0)") })
    }

    @Test("A success envelope without the billing state each route returns is an invalid response", arguments: [
        ("checkouts/verify", #"{"ok":true,"data":null}"#),
        ("checkouts/verify", #"{"ok":true,"data":{"subscription":{"status":"active"}}}"#),
        ("checkouts/verify", #"{"ok":true,"data":{"checkoutSession":{"checkoutSessionId":"chk_other"},"subscription":{"status":"active"}}}"#),
        ("checkouts/verify", #"{"ok":true,"data":{"checkoutSession":{"checkoutSessionId":"chk_1"},"subscription":null}}"#),
        ("purchases/restore", #"{"ok":true,"data":null}"#),
        ("purchases/restore", #"{"ok":true,"data":{"entitlements":{}}}"#),
    ])
    func rejectsInvalidBillingResponses(path: String, body: String) async throws {
        let backend = backend(body: body)
        let plan = BillFnStoreKitPlan(productId: "apple.pro.month", planKey: "pro")

        await #expect(throws: BillFnClientError.invalidResponse) {
            if path == "checkouts/verify" {
                _ = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)
            } else {
                _ = try await backend.restorePurchase(plan: plan, transaction: transaction)
            }
        }
        #expect(BillFnStoreKitFailure(error: BillFnClientError.invalidResponse).code == "BILLFN_INVALID_RESPONSE")
    }

    @Test("Binds a purchase checkout only to a transaction of its product and appAccountToken")
    func claimValidatesIdentity() throws {
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults())
        store.save(checkout("chk_month"))
        let otherAccount = BillFnStoreKitCheckout(checkoutSessionId: "chk_month", productId: "apple.pro.month", appAccountToken: UUID(uuidString: "00000000-0000-4000-8000-00000000000b")!)
        let tokenless = BillFnStoreKitTransactionFacts(transactionId: "32", productId: "apple.pro.month", appAccountToken: nil, purchaseDate: Date(), isPurchase: true)

        #expect(store.claim(facts("30", product: "apple.pro.year"), purchasedWith: checkout("chk_month")) == nil)
        #expect(store.claim(facts("31"), purchasedWith: otherAccount) == nil)
        #expect(store.claim(tokenless, purchasedWith: checkout("chk_month")) == nil)
        #expect(store.claim(facts("33", product: "apple.pro.year"), purchasedWith: checkout("chk_new")) == nil)
        #expect(store.keptCheckouts() == [BillFnStoreKitKeptCheckout(checkout: checkout("chk_month"), savedAt: try #require(store.keptCheckouts().first).savedAt)])
        #expect(store.claim(facts("34"), purchasedWith: checkout("chk_month")) == checkout("chk_month"))
        #expect(store.keptCheckouts().map(\.transactionId) == ["34"])
    }

    @Test("Records each observation on its own: a refund BillFn has not confirmed stays pending beside the finished purchase")
    func recordsEachObservation() throws {
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults(), now: { clock.now })
        let bought = facts("40", purchased: clock.now)
        let refunded = BillFnStoreKitTransactionFacts(
            transactionId: "40", productId: "apple.pro.month", appAccountToken: account, purchaseDate: clock.now, isPurchase: true, revoked: true
        )
        store.record(bought, state: .finished, resolution: .restore(rejectedCheckout: nil))
        store.record(refunded, state: .pending, resolution: nil)

        #expect(store.records(transactionId: "40").map(\.state) == [.finished, .pending])
        #expect(store.records(transactionId: "40").first { $0.facts.revoked }?.state == .pending)
        // The id-wide guard still holds: a confirmed transaction claims no outstanding checkout, revoked or not.
        #expect(store.isFinished(transactionId: "40"))
        store.save(checkout("chk_later"))
        #expect(store.claim(refunded, purchasedWith: nil) == nil)
        store.record(refunded, state: .finished, resolution: .restore(rejectedCheckout: nil))
        #expect(store.records(transactionId: "40").map(\.state) == [.finished, .finished])
    }

    @Test("A restore after BillFn rejected the checkout for good resolves the binding without confirming the checkout")
    func recordsARestoreResolutionApart() throws {
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults(), now: { clock.now })
        store.save(checkout("chk_rejected"))
        let transaction = facts("50", purchased: clock.now)
        #expect(store.claim(transaction, purchasedWith: nil) == checkout("chk_rejected"))
        store.record(transaction, state: .pending, resolution: nil)
        store.record(transaction, state: .confirmed, resolution: .restore(rejectedCheckout: "chk_rejected"))

        let kept = try #require(store.keptCheckouts().first)
        #expect(!kept.confirmed && kept.restored && kept.settled)
        #expect(store.record(transactionId: "50")?.resolution == .restore(rejectedCheckout: "chk_rejected"))
        store.removeUnneededCheckouts()
        #expect(store.keptCheckouts().count == 1, "kept until the transaction is recorded finished")
        store.record(transaction, state: .finished, resolution: .restore(rejectedCheckout: "chk_rejected"))
        store.removeUnneededCheckouts()
        #expect(store.keptCheckouts().isEmpty)
    }

    @Test("Never evicts a confirmed record whose finish() has not returned, however many finished ones follow")
    func keepsUnfinishedRecords() throws {
        let clock = TestClock()
        let store = BillFnUserDefaultsCheckoutStore(defaults: try freshDefaults(), now: { clock.now })
        let renewal = facts("70", purchased: clock.now, isPurchase: false)
        store.record(renewal, state: .pending, resolution: nil)
        clock.advance(by: day)
        for index in 0..<BillFnUserDefaultsCheckoutStore.confirmedTransactionLimit {
            store.record(facts("8\(index)", purchased: clock.now), state: .finished, resolution: nil)
        }
        // BillFn confirmed the renewal; the app stops before finish() returns.
        store.record(renewal, state: .confirmed, resolution: .restore(rejectedCheckout: nil))
        store.record(facts("90", purchased: clock.now), state: .finished, resolution: nil)
        #expect(store.record(transactionId: "70")?.state == .confirmed)
        // Once finished, it is the oldest record nothing needs and goes first.
        store.record(renewal, state: .finished, resolution: nil)
        store.record(facts("91", purchased: clock.now), state: .finished, resolution: nil)
        #expect(store.record(transactionId: "70") == nil)
    }

    @Test("Bundles the privacy manifest declaring the app's own UserDefaults use")
    func bundlesThePrivacyManifest() throws {
        let url = try #require(BillFnStoreKitResources.privacyManifest)
        let manifest = try #require(try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        let types = try #require(manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let defaults = try #require(types.first { $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults" })
        #expect(defaults["NSPrivacyAccessedAPITypeReasons"] as? [String] == ["CA92.1"])
        #expect(manifest["NSPrivacyTracking"] as? Bool == false)
    }
}

private let account = UUID(uuidString: token)!

private final class Winners: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed: [String] = []
    var ids: [String] { lock.withLock { claimed } }
    func add(_ id: String) { lock.withLock { claimed.append(id) } }
}

private func freshDefaults() throws -> UserDefaults {
    try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
}

private func checkout(_ id: String) -> BillFnStoreKitCheckout {
    BillFnStoreKitCheckout(checkoutSessionId: id, productId: "apple.pro.month", appAccountToken: account)
}

/// A purchase of apple.pro.month on the test account, `purchased` at the given time (now by default).
private func facts(
    _ id: String, purchased: Date = Date(), isPurchase: Bool? = true, product: String = "apple.pro.month"
) -> BillFnStoreKitTransactionFacts {
    BillFnStoreKitTransactionFacts(transactionId: id, productId: product, appAccountToken: account, purchaseDate: purchased, isPurchase: isPurchase)
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

