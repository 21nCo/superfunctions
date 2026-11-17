import BillFnClient
import BillFnStoreKit
import Foundation
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

private let token = "2e54f6b7-3e0d-5b18-98d2-2a2f84a70f7f"
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
        #"{"type":"apple-purchase","metadata":{"appAccountToken":"2e54f6b7-3e0d-5b18-98d2-2a2f84a70f7f"}}"#,
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
        (502, #"{"ok":true,"data":{}}"#),
        (200, #"{"ok":false}"#),
    ])
    func rejectsNonEnvelopes(status: Int, body: String) async throws {
        let backend = backend(status: status, body: body)

        await #expect(throws: BillFnClientError.invalidResponse) {
            _ = try await backend.verifyCheckout(checkoutSessionId: "chk_1", transaction: transaction)
        }
    }

    @Test("Maps errors to the failure a transaction outcome reports")
    func mapsFailures() {
        #expect(BillFnStoreKitFailure(error: BillFnClientError.server(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", status: 502, retryable: true))
            == BillFnStoreKitFailure(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", retryable: true))
        #expect(BillFnStoreKitFailure(error: URLError(.notConnectedToInternet)).code == "BILLFN_NETWORK_ERROR")
        #expect(BillFnStoreKitFailure(error: URLError(.notConnectedToInternet)).retryable)
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

    @Test("Drops the oldest checkout beyond its capacity")
    func boundsCheckouts() throws {
        let defaults = try #require(UserDefaults(suiteName: "billfn.storekit.backend-tests.\(UUID().uuidString)"))
        let store = BillFnUserDefaultsCheckoutStore(defaults: defaults)
        let capacity = BillFnUserDefaultsCheckoutStore.capacity
        for index in 0...capacity {
            store.save(BillFnStoreKitCheckout(checkoutSessionId: "chk_\(index)", productId: "apple.pro.month", appAccountToken: UUID(uuidString: token)!))
        }

        let kept = store.checkouts(forProductId: "apple.pro.month").map(\.checkoutSessionId)
        #expect(kept.count == capacity)
        #expect(kept.first == "chk_1")
        #expect(kept.last == "chk_\(capacity)")
    }
}
