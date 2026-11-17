import BillFnClient
import BillFnStoreKit
import Foundation
import StoreKit
import StoreKitTest
import XCTest
#if canImport(AppKit)
import AppKit
#endif

let proMonthly = "billfn.test.pro.month"
let proLifetime = "billfn.test.pro.lifetime"
let unmapped = "billfn.test.unmapped"

/// Stands in for the BillFn server: records each call and answers like `@billfn/core`'s routes.
actor FakeBillFnBackend: BillFnStoreKitBackend {
    let appAccountToken = UUID()
    private(set) var checkoutIds: [String] = []
    private(set) var verifications: [(checkoutSessionId: String, transaction: BillFnStoreKitTransactionReference)] = []
    private(set) var restores: [(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference)] = []
    var verifyError: (any Error)?
    var restoreError: (any Error)?

    func failVerification(with error: (any Error)?) {
        verifyError = error
    }

    func failRestore(with error: (any Error)?) {
        restoreError = error
    }

    func createCheckout(_ request: BillFnStoreKitCheckoutRequest) async throws -> BillFnStoreKitCheckout {
        let id = "chk_\(checkoutIds.count + 1)"
        checkoutIds.append(id)
        let productId = request.planKey == "pro-lifetime" ? proLifetime : proMonthly
        return BillFnStoreKitCheckout(checkoutSessionId: id, productId: productId, appAccountToken: appAccountToken)
    }

    func verifyCheckout(checkoutSessionId: String, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        verifications.append((checkoutSessionId, transaction))
        if let verifyError { throw verifyError }
        return .object(["checkoutSession": .object(["checkoutSessionId": .string(checkoutSessionId), "status": "succeeded"])])
    }

    func restorePurchase(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        restores.append((plan, transaction))
        if let restoreError { throw restoreError }
        return .object(["subscription": .object(["status": "active"])])
    }
}

struct TimedOut: Error {
    let waitingFor: String
}

actor OutcomeRecorder {
    private(set) var outcomes: [BillFnStoreKitTransactionOutcome] = []

    func record(_ outcome: BillFnStoreKitTransactionOutcome) {
        outcomes.append(outcome)
    }
}

/// Sets up StoreKit testing and the fake BillFn server for each test; launches share one checkout store.
/// StoreKit testing keeps transaction state in the test process between tests, so `run-tests.sh` runs
/// each test in its own host process.
class BillFnStoreKitTestCase: XCTestCase {
    var session: SKTestSession!
    var defaults: UserDefaults!
    private var kits: [BillFnStoreKit] = []
    let plans = [BillFnStoreKitPlan(productId: proMonthly, planKey: "pro", priceId: "price_pro_apple_month")]

    override func setUpWithError() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "BillFn", withExtension: "storekit"))
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        defaults = UserDefaults(suiteName: "billfn.storekit.tests.\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for kit in kits {
            await kit.stop()
        }
        kits = []
        // A simulated error outlives its session; left set, it breaks the next test's purchase.
        try await session.setSimulatedError(nil, forAPI: .purchase)
        session.clearTransactions()
    }

    /// A `BillFnStoreKit` as one app launch makes it; launches share the checkout store, as they share UserDefaults.
    func launch(_ backend: FakeBillFnBackend) -> BillFnStoreKit {
        let kit = BillFnStoreKit(backend: backend, plans: plans, checkouts: BillFnUserDefaultsCheckoutStore(defaults: defaults))
        kits.append(kit)
        return kit
    }

    func unfinishedTransactionIds() async -> [UInt64] {
        var ids: [UInt64] = []
        for await result in Transaction.unfinished {
            ids.append(result.unsafePayloadValue.id)
        }
        return ids
    }

    func assertFinished(_ outcome: BillFnStoreKitTransactionOutcome, file: StaticString = #filePath, line: UInt = #line) async throws {
        let id = try XCTUnwrap(UInt64(outcome.transaction.transactionId))
        let unfinished = await unfinishedTransactionIds()
        XCTAssertFalse(unfinished.contains(id), "Transaction \(id) is still unfinished", file: file, line: line)
    }

    /// The subscription's newest transaction once StoreKit testing has recorded one after `purchase`.
    func latestTransaction(after purchase: BillFnStoreKitTransactionOutcome) async throws -> VerificationResult<Transaction> {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let latest = await Transaction.latest(for: proMonthly),
               String(latest.unsafePayloadValue.id) != purchase.transaction.transactionId {
                return latest
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw TimedOut(waitingFor: "a transaction after \(purchase.transaction.transactionId)")
    }

    func record(_ kit: BillFnStoreKit) -> OutcomeRecorder {
        let recorder = OutcomeRecorder()
        Task {
            for await outcome in kit.outcomes {
                await recorder.record(outcome)
            }
        }
        return recorder
    }

    func waitForOutcomes(_ recorder: OutcomeRecorder, count: Int) async throws -> [BillFnStoreKitTransactionOutcome] {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            let outcomes = await recorder.outcomes
            if outcomes.count >= count { return outcomes }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("Timed out waiting for \(count) transaction outcomes")
        return await recorder.outcomes
    }

    /// A purchase this app's BillFn checkout did not start, such as one made before the app adopted BillFn.
    func buyOutsideBillFn(_ productId: String, appAccountToken: UUID?) async throws -> Transaction {
        let products = try await Product.products(for: [productId])
        let product = try XCTUnwrap(products.first)
        let options: Set<Product.PurchaseOption> = appAccountToken.map { [.appAccountToken($0)] } ?? []
        guard case .success(let verification) = try await product.purchase(options: options) else {
            throw XCTSkip("StoreKit testing did not complete the purchase of \(productId)")
        }
        return verification.unsafePayloadValue
    }
}

final class BillFnStoreKitTests: BillFnStoreKitTestCase {
    func testPurchaseUsesTheBillingAccountTokenAndFinishesAfterBillFnVerifies() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)

        let result = try await kit.purchase(planKey: "pro")

        guard case .purchased(let checkout, let outcome) = result else {
            return XCTFail("Expected a purchase, got \(result)")
        }
        XCTAssertEqual(checkout.checkoutSessionId, "chk_1")
        XCTAssertTrue(outcome.finished)
        XCTAssertEqual(outcome.transaction.appAccountToken, backend.appAccountToken)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1"])
        XCTAssertEqual(verifications.first?.transaction.productId, proMonthly)
        XCTAssertEqual(verifications.first?.transaction.appAccountToken, backend.appAccountToken)
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertFinished(outcome)
        XCTAssertNil(BillFnUserDefaultsCheckoutStore(defaults: defaults).checkout(forProductId: proMonthly))
    }

    func testTransactionBillFnRejectsStaysUnfinishedAndIsVerifiedOnTheNextLaunch() async throws {
        let backend = FakeBillFnBackend()
        await backend.failVerification(with: BillFnClientError.server(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", status: 502, retryable: true))
        let firstLaunch = launch(backend)

        let result = try await firstLaunch.purchase(planKey: "pro")

        guard case .purchased(_, let outcome) = result else {
            return XCTFail("Expected a purchase, got \(result)")
        }
        XCTAssertFalse(outcome.finished)
        XCTAssertEqual(outcome.status, .failed(BillFnStoreKitFailure(code: "BILLFN_PROVIDER_ERROR", message: "Apple unavailable", retryable: true)))
        let transactionId = try XCTUnwrap(UInt64(outcome.transaction.transactionId))
        let unfinishedAfterFailure = await unfinishedTransactionIds()
        XCTAssertTrue(unfinishedAfterFailure.contains(transactionId))

        await backend.failVerification(with: nil)
        let nextLaunch = launch(backend)
        let retried = await nextLaunch.start()

        XCTAssertEqual(retried.map(\.transaction.transactionId), [outcome.transaction.transactionId])
        XCTAssertEqual(retried.map(\.finished), [true])
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1", "chk_1"])
        try await assertFinished(outcome)
    }

    /// StoreKit testing on macOS does not deliver an approved Ask to Buy request, so this test stops at the
    /// pending state. The approved transaction arrives through `Transaction.updates` (covered by the renewal tests)
    /// and is verified against the kept checkout, as the next-launch test shows.
    func testPendingPurchaseIsNotVerifiedAndKeepsItsCheckout() async throws {
        session.askToBuyEnabled = true
        let unfinishedBefore = await unfinishedTransactionIds()
        let backend = FakeBillFnBackend()
        let kit = launch(backend)

        let result = try await kit.purchase(planKey: "pro-lifetime")

        guard case .pending(let checkout) = result else {
            return XCTFail("Expected a pending purchase, got \(result)")
        }
        XCTAssertTrue(session.allTransactions().contains { $0.pendingAskToBuyConfirmation })
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        XCTAssertEqual(BillFnUserDefaultsCheckoutStore(defaults: defaults).checkout(forProductId: proLifetime), checkout)
        let unfinished = await unfinishedTransactionIds()
        XCTAssertEqual(unfinished, unfinishedBefore)
    }

    func testRestoreConfirmsEachEntitlementWithBillFnAndLeavesUnmappedProductsUnfinished() async throws {
        let backend = FakeBillFnBackend()
        // Bought before this install: there is no checkout on this device, so BillFn restores it by its plan.
        let subscription = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let other = try await buyOutsideBillFn(unmapped, appAccountToken: nil)
        let kit = launch(backend)

        let outcomes = try await kit.restore(syncWithAppStore: false)

        let byProduct = Dictionary(uniqueKeysWithValues: outcomes.map { ($0.transaction.productId, $0) })
        XCTAssertEqual(byProduct[proMonthly]?.finished, true)
        XCTAssertEqual(byProduct[unmapped]?.finished, false)
        if case .skipped = byProduct[unmapped]?.status {} else { XCTFail("Expected the unmapped product to be skipped") }
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.plan.planKey), ["pro"])
        XCTAssertEqual(restores.first?.plan.priceId, "price_pro_apple_month")
        XCTAssertEqual(restores.first?.transaction.originalTransactionId, String(subscription.originalID))
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)
        let unfinished = await unfinishedTransactionIds()
        XCTAssertTrue(unfinished.contains(other.id))
    }

    func testRenewalIsRestoredOntoItsPlanAndFinished() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        guard case .purchased(_, let purchase) = try await kit.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }

        try session.forceRenewalOfSubscription(productIdentifier: proMonthly)
        let renewal = try await latestTransaction(after: purchase)
        let outcome = await kit.process(renewal)

        XCTAssertTrue(outcome.finished)
        XCTAssertEqual(outcome.transaction.originalTransactionId, purchase.transaction.originalTransactionId)
        // The checkout was verified once, by the purchase; the renewal is restored onto the plan.
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.count, 1)
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [outcome.transaction.transactionId])
        XCTAssertEqual(restores.map(\.plan.planKey), ["pro"])
        try await assertFinished(outcome)
    }

    func testRenewalBillFnRejectsStaysUnfinished() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        guard case .purchased(_, let purchase) = try await kit.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        await backend.failRestore(with: BillFnClientError.server(code: "BILLFN_CONFLICT", message: "Another account", status: 409, retryable: false))

        try session.forceRenewalOfSubscription(productIdentifier: proMonthly)
        let renewal = try await latestTransaction(after: purchase)
        let outcome = await kit.process(renewal)

        XCTAssertFalse(outcome.finished)
        XCTAssertEqual(outcome.status, .failed(BillFnStoreKitFailure(code: "BILLFN_CONFLICT", message: "Another account", retryable: false)))
        let unfinished = await unfinishedTransactionIds()
        XCTAssertTrue(unfinished.contains(renewal.unsafePayloadValue.id))
    }

    func testListenerConfirmsTransactionUpdates() async throws {
        let active = await MainActor.run { NSApplication.shared.isActive }
        // In local runs where the host app could not become active, StoreKit testing delivered no updates at all.
        try XCTSkipUnless(active, "The host app is not active, so StoreKit testing does not deliver Transaction.updates")
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        let recorder = record(kit)
        await kit.start()
        _ = try await kit.purchase(planKey: "pro")

        try session.forceRenewalOfSubscription(productIdentifier: proMonthly)
        let outcomes = try await waitForOutcomes(recorder, count: 2)

        XCTAssertEqual(outcomes.map(\.finished), [true, true])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), outcomes.dropFirst().map(\.transaction.transactionId))
    }

    func testCancelledPurchaseIsNeitherVerifiedNorKept() async throws {
        try await session.setSimulatedError(.generic(.userCancelled), forAPI: .purchase)
        let unfinishedBefore = await unfinishedTransactionIds()
        let backend = FakeBillFnBackend()
        let kit = launch(backend)

        let result = try await kit.purchase(planKey: "pro")

        guard case .cancelled(let checkout) = result else {
            return XCTFail("Expected a cancelled purchase, got \(result)")
        }
        XCTAssertEqual(checkout.checkoutSessionId, "chk_1")
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)
        XCTAssertNil(BillFnUserDefaultsCheckoutStore(defaults: defaults).checkout(forProductId: proMonthly))
        let unfinished = await unfinishedTransactionIds()
        XCTAssertEqual(unfinished, unfinishedBefore)
    }
}
