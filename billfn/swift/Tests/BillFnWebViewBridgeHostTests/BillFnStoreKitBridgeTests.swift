import BillFnClient
import BillFnStoreKit
import BillFnWebViewBridgeHost
import Foundation
import StoreKit
import Testing

private let token = UUID(uuidString: "00000000-0000-4000-8000-00000000000A")!
private let checkout = BillFnStoreKitCheckout(checkoutSessionId: "chk_1", productId: "apple.pro.month", appAccountToken: token)
private let reference = BillFnStoreKitTransactionReference(
    transactionId: "2000000002",
    originalTransactionId: "2000000001",
    productId: "apple.pro.month",
    appAccountToken: token
)

/// Stands in for `BillFnStoreKit`: records the calls the bridge makes and answers with fixed results.
private actor FakeStoreKit: BillFnStoreKitBridgeHandling {
    private(set) var purchases: [[String?]] = []
    private(set) var restores: [Bool] = []
    var purchaseResult: BillFnStoreKitPurchaseResult = .pending(checkout)
    var outcomes: [BillFnStoreKitTransactionOutcome] = []
    var error: (any Error)?

    init(purchaseResult: BillFnStoreKitPurchaseResult = .pending(checkout), outcomes: [BillFnStoreKitTransactionOutcome] = [], error: (any Error)? = nil) {
        self.purchaseResult = purchaseResult
        self.outcomes = outcomes
        self.error = error
    }

    func purchase(planKey: String, priceId: String?, interval: String?) async throws -> BillFnStoreKitPurchaseResult {
        purchases.append([planKey, priceId, interval])
        if let error { throw error }
        return purchaseResult
    }

    func restore(syncWithAppStore: Bool) async throws -> [BillFnStoreKitTransactionOutcome] {
        restores.append(syncWithAppStore)
        if let error { throw error }
        return outcomes
    }

    func processUnfinishedTransactions() async -> [BillFnStoreKitTransactionOutcome] {
        outcomes
    }
}

private func dispatcher(_ storeKit: FakeStoreKit?) -> BillFnBridgeDispatcher {
    BillFnBridgeDispatcher(configuration: BillFnBridgeConfiguration(baseURL: "https://billfn.example.test/billfn"), storeKit: storeKit)
}

private let encodedTransaction: BillFnBridgeValue = .object([
    "transactionId": "2000000002",
    "originalTransactionId": "2000000001",
    "productId": "apple.pro.month",
    "appAccountToken": "00000000-0000-4000-8000-00000000000a",
    "revoked": .bool(false),
])

@Suite("BillFn StoreKit bridge methods")
struct BillFnStoreKitBridgeTests {
    @Test("Handshake lists the StoreKit methods only when StoreKit is configured")
    func handshakeCapabilities() async {
        let request = BillFnBridgeRequestEnvelope(id: "req_1", method: "handshake")

        let with = await dispatcher(FakeStoreKit()).respond(to: request)
        let without = await dispatcher(nil).respond(to: request)

        #expect(with.result?["capabilities"] == .array([
            "subscription.manage", "health.check", "storekit.checkout", "storekit.restore", "storekit.transactions",
        ]))
        #expect(without.result?["capabilities"] == .array(["subscription.manage", "health.check"]))
    }

    @Test("storekit.checkout buys the plan and returns the confirmed outcome")
    func checkoutPurchases() async {
        let outcome = BillFnStoreKitTransactionOutcome(transaction: reference, status: .confirmed(.object(["subscription": .object(["status": "active"])])))
        let storeKit = FakeStoreKit(purchaseResult: .purchased(checkout, outcome))

        let response = await dispatcher(storeKit).respond(to: BillFnBridgeRequestEnvelope(id: "req_2", method: "storekit.checkout", payload: [
            "planKey": "pro", "priceId": "price_pro_apple_month", "interval": "month",
        ]))

        #expect(await storeKit.purchases == [["pro", "price_pro_apple_month", "month"]])
        #expect(response.ok)
        #expect(response.result == [
            "status": "purchased",
            "checkoutSessionId": "chk_1",
            "productId": "apple.pro.month",
            "outcome": .object([
                "transaction": encodedTransaction,
                "status": "confirmed",
                "finished": .bool(true),
                "billing": .object(["subscription": .object(["status": "active"])]),
            ]),
        ])
    }

    @Test("storekit.checkout reports pending and cancelled purchases")
    func checkoutPendingAndCancelled() async {
        for (result, status) in [(BillFnStoreKitPurchaseResult.pending(checkout), "pending"), (.cancelled(checkout), "cancelled")] {
            let response = await dispatcher(FakeStoreKit(purchaseResult: result)).respond(
                to: BillFnBridgeRequestEnvelope(id: "req_3", method: "storekit.checkout", payload: ["planKey": "pro"])
            )
            #expect(response.result == ["status": .string(status), "checkoutSessionId": "chk_1", "productId": "apple.pro.month"])
        }
    }

    @Test("storekit.checkout rejects a payload without a planKey string", arguments: [
        nil,
        ["planKey": BillFnBridgeValue.string("")],
        ["planKey": .integer(1)],
        ["planKey": "pro", "priceId": .integer(1)],
        ["planKey": "pro", "interval": .bool(true)],
    ] as [[String: BillFnBridgeValue]?])
    func checkoutRejectsInvalidPayloads(payload: [String: BillFnBridgeValue]?) async {
        let storeKit = FakeStoreKit()

        let response = await dispatcher(storeKit).respond(to: BillFnBridgeRequestEnvelope(id: "req_4", method: "storekit.checkout", payload: payload))

        #expect(response.error?.code == "BRIDGE_INVALID_REQUEST")
        #expect(await storeKit.purchases.isEmpty)
    }

    @Test("storekit.restore syncs with the App Store unless told not to and returns each outcome")
    func restoreOutcomes() async {
        let failed = BillFnStoreKitTransactionOutcome(
            transaction: reference,
            status: .failed(BillFnStoreKitFailure(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", retryable: true))
        )
        let storeKit = FakeStoreKit(outcomes: [failed])
        let bridge = dispatcher(storeKit)

        let response = await bridge.respond(to: BillFnBridgeRequestEnvelope(id: "req_5", method: "storekit.restore"))
        _ = await bridge.respond(to: BillFnBridgeRequestEnvelope(id: "req_6", method: "storekit.restore", payload: ["syncWithAppStore": .bool(false)]))
        let invalid = await bridge.respond(to: BillFnBridgeRequestEnvelope(id: "req_7", method: "storekit.restore", payload: ["syncWithAppStore": "no"]))

        #expect(await storeKit.restores == [true, false])
        #expect(response.result == ["transactions": .array([.object([
            "transaction": encodedTransaction,
            "status": "failed",
            "finished": .bool(false),
            "error": .object(["code": "BILLFN_PROVIDER_ERROR", "message": "Apple unavailable", "retryable": .bool(true)]),
        ])])])
        #expect(invalid.error?.code == "BRIDGE_INVALID_REQUEST")
    }

    @Test("storekit.transactions returns the unfinished transactions' outcomes")
    func transactionOutcomes() async {
        let skipped = BillFnStoreKitTransactionOutcome(transaction: reference, status: .skipped("No BillFn plan"))

        let response = await dispatcher(FakeStoreKit(outcomes: [skipped])).respond(
            to: BillFnBridgeRequestEnvelope(id: "req_8", method: "storekit.transactions")
        )

        #expect(response.result == ["transactions": .array([.object([
            "transaction": encodedTransaction,
            "status": "skipped",
            "finished": .bool(false),
            "reason": "No BillFn plan",
        ])])])
    }

    @Test("A BillFn error keeps its code and whether it is retryable")
    func errorsKeepTheirCode() async {
        let storeKit = FakeStoreKit(error: BillFnClientError.server(code: "BILLFN_CONFLICT", message: "Another account", status: 409, retryable: false))

        let response = await dispatcher(storeKit).respond(to: BillFnBridgeRequestEnvelope(id: "req_9", method: "storekit.checkout", payload: ["planKey": "pro"]))

        #expect(!response.ok)
        #expect(response.error == BillFnBridgeError(code: "BILLFN_CONFLICT", message: "Another account", details: ["retryable": .bool(false)]))
    }

    @Test("A StoreKit network error reaches the web view as a retryable network error")
    func storeKitNetworkErrorsAreRetryable() async {
        let storeKit = FakeStoreKit(error: StoreKitError.networkError(URLError(.notConnectedToInternet)))

        let response = await dispatcher(storeKit).respond(to: BillFnBridgeRequestEnvelope(id: "req_9", method: "storekit.restore"))

        #expect(!response.ok)
        #expect(response.error?.code == "BILLFN_NETWORK_ERROR")
        #expect(response.error?.details == ["retryable": .bool(true)])
    }

    @Test("StoreKit methods need a configured StoreKit and the async entry point")
    func storeKitMethodsNeedConfiguration() async {
        let request = BillFnBridgeRequestEnvelope(id: "req_10", method: "storekit.transactions")

        #expect(await dispatcher(nil).respond(to: request).error?.code == "BILLFN_CAPABILITY_UNAVAILABLE")
        #expect(dispatcher(FakeStoreKit()).handle(request).error?.code == "BRIDGE_METHOD_UNSUPPORTED")
        let mismatch = BillFnBridgeRequestEnvelope(protocolVersion: "billfn-bridge/v0", id: "req_11", method: "storekit.checkout", payload: ["planKey": "pro"])
        #expect(await dispatcher(FakeStoreKit()).respond(to: mismatch).error?.code == "BRIDGE_PROTOCOL_MISMATCH")
    }

    @Test("Transaction outcomes become transaction.updated events")
    func transactionEvents() {
        let outcome = BillFnStoreKitTransactionOutcome(transaction: reference, status: .skipped("No BillFn plan"))

        let event = dispatcher(nil).transactionEvent(outcome)

        #expect(event.event == "transaction.updated")
        #expect(BILLFN_BRIDGE_EVENT_NAMES.contains(event.event))
        #expect(event.payload["outcome"] == outcome.bridgeValue)
    }
}
