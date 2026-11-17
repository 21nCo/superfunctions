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
    /// While set, each verification waits here before answering.
    var verifyGate: (@Sendable () async -> Void)?

    func holdVerifications(_ gate: (@Sendable () async -> Void)?) {
        verifyGate = gate
    }

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
        if let verifyGate { await verifyGate() }
        if let verifyError { throw verifyError }
        return .object(["checkoutSession": .object(["checkoutSessionId": .string(checkoutSessionId), "status": "succeeded"])])
    }

    func restorePurchase(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        restores.append((plan, transaction))
        if let restoreError { throw restoreError }
        return .object(["subscription": .object(["status": "active"])])
    }
}

/// A gate a test opens once; everything waiting on it resumes then.
actor Gate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var arrivals = 0

    func wait() async {
        arrivals += 1
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        open = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

struct TimedOut: Error {
    let waitingFor: String
}

struct PurchaseNotCompleted: Error {
    let productId: String
    let result: String
}

actor OutcomeRecorder {
    private(set) var outcomes: [BillFnStoreKitTransactionOutcome] = []

    func record(_ outcome: BillFnStoreKitTransactionOutcome) {
        outcomes.append(outcome)
    }
}

/// Sets up StoreKit testing and the fake BillFn server for each test; launches share one checkout store.
/// StoreKit testing keeps some state in the test process between tests, so `run-tests.sh` runs the tests
/// that simulate a purchase error or Ask to Buy in their own host processes.
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
    /// `now` is the launch's time, `plans` defaults to the test plans.
    func launch(_ backend: FakeBillFnBackend, plans: [BillFnStoreKitPlan]? = nil, now: Date? = nil) -> BillFnStoreKit {
        let kit = BillFnStoreKit(backend: backend, plans: plans ?? self.plans, checkouts: checkoutStore(now: now))
        kits.append(kit)
        return kit
    }

    /// The checkout store as the next launch reads it.
    var checkoutStore: BillFnUserDefaultsCheckoutStore {
        checkoutStore(now: nil)
    }

    func checkoutStore(now: Date?) -> BillFnUserDefaultsCheckoutStore {
        BillFnUserDefaultsCheckoutStore(defaults: defaults, now: { now ?? Date() })
    }

    func keptCheckoutIds(_ productId: String) -> [String] {
        checkoutStore.checkouts(forProductId: productId).map(\.checkoutSessionId)
    }

    func waitUntil(_ what: String, _ condition: @escaping () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw TimedOut(waitingFor: what)
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
        let result = try await product.purchase(options: options)
        guard case .success(let verification) = result else {
            throw PurchaseNotCompleted(productId: productId, result: String(describing: result))
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
        XCTAssertEqual(keptCheckoutIds(proMonthly), [])
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

    /// BillFn could not verify a purchase that maps to no plan. Its checkout records the transaction before the verify
    /// call, so it does not expire: the next launch, a retention period later, still verifies the transaction against
    /// it and finishes it. Without that checkout the transaction would be skipped for good.
    func testTransactionWhoseVerifyFailedKeepsItsCheckoutPastRetention() async throws {
        let backend = FakeBillFnBackend()
        await backend.failVerification(with: URLError(.notConnectedToInternet))
        let firstLaunch = launch(backend, plans: [])

        guard case .purchased(_, let failed) = try await firstLaunch.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        XCTAssertFalse(failed.finished)
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [failed.transaction.transactionId])

        await backend.failVerification(with: nil)
        let later = Date().addingTimeInterval(BillFnUserDefaultsCheckoutStore.defaultRetention + 24 * 60 * 60)
        let nextLaunch = launch(backend, plans: [], now: later)
        let outcomes = await nextLaunch.start()

        let outcome = try XCTUnwrap(outcomes.first { $0.transaction.transactionId == failed.transaction.transactionId })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1", "chk_1"])
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertFinished(outcome)
        XCTAssertEqual(checkoutStore(now: later).keptCheckouts(), [])
    }

    /// Restoring a purchase bought before a pending attempt on the same product started restores it onto its plan;
    /// it does not take (and BillFn does not complete) the pending attempt's checkout, which stays outstanding.
    func testRestoredOlderPurchaseLeavesAPendingAttemptsCheckout() async throws {
        let backend = FakeBillFnBackend()
        let older = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let attemptStarted = Date().addingTimeInterval(60 * 60)
        let pending = BillFnStoreKitCheckout(checkoutSessionId: "chk_pending", productId: proMonthly, appAccountToken: backend.appAccountToken)
        checkoutStore(now: attemptStarted).save(pending)
        let kit = launch(backend, now: attemptStarted)

        let outcomes = try await kit.restore(syncWithAppStore: false)

        let outcome = try XCTUnwrap(outcomes.first { $0.transaction.transactionId == String(older.id) })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [String(older.id)])
        XCTAssertEqual(checkoutStore(now: attemptStarted).keptCheckouts(), [
            BillFnStoreKitKeptCheckout(checkout: pending, savedAt: attemptStarted),
        ])
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
        XCTAssertEqual(checkoutStore.checkouts(forProductId: proLifetime), [checkout])
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

    /// Additional coverage of the real `Transaction.updates`; StoreKit testing delivers them only to an active app.
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
        XCTAssertEqual(keptCheckoutIds(proMonthly), [])
        let unfinished = await unfinishedTransactionIds()
        XCTAssertEqual(unfinished, unfinishedBefore)
    }

    /// A pending purchase's checkout survives a second attempt on the same product that the user cancels, so
    /// the first purchase, approved later, is verified against its own checkout on the next launch.
    /// `proLifetime` maps to no plan, so without its kept checkout the approved purchase would be skipped.
    func testCancelledSecondAttemptKeepsThePendingAttemptsCheckout() async throws {
        let backend = FakeBillFnBackend()
        // The first attempt, left pending by an earlier launch, keeps its checkout.
        let pending = BillFnStoreKitCheckout(checkoutSessionId: "chk_pending", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(pending)
        let kit = launch(backend)

        try await session.setSimulatedError(.generic(.userCancelled), forAPI: .purchase)
        let second = try await kit.purchase(planKey: "pro-lifetime")
        try await session.setSimulatedError(nil, forAPI: .purchase)

        guard case .cancelled(let cancelled) = second else {
            return XCTFail("Expected the second attempt to be cancelled, got \(second)")
        }
        XCTAssertEqual(cancelled.checkoutSessionId, "chk_1")
        XCTAssertEqual(keptCheckoutIds(proLifetime), ["chk_pending"])

        // The first attempt is approved: its transaction, bought with the billing account's token, waits
        // unfinished for the next launch.
        let approved = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let nextLaunch = launch(backend)
        let retried = await nextLaunch.start()

        let outcome = try XCTUnwrap(retried.first { $0.transaction.transactionId == String(approved.id) })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_pending"])
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        XCTAssertEqual(keptCheckoutIds(proLifetime), [])
    }

    /// A purchase StoreKit refuses before it reaches the App Store cannot produce a transaction, so its checkout
    /// is dropped; one that fails on the network may have reached it, so its checkout stays kept for its transaction.
    func testRefusedPurchaseDropsItsCheckoutAndAFailedOneKeepsIt() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)

        try await session.setSimulatedError(.purchase(.productUnavailable), forAPI: .purchase)
        do {
            _ = try await kit.purchase(planKey: "pro")
            XCTFail("Expected the refused purchase to throw")
        } catch Product.PurchaseError.productUnavailable {}
        XCTAssertEqual(keptCheckoutIds(proMonthly), [])

        try await session.setSimulatedError(.generic(.networkError(URLError(.networkConnectionLost))), forAPI: .purchase)
        do {
            _ = try await kit.purchase(planKey: "pro")
            XCTFail("Expected the failed purchase to throw")
        } catch StoreKitError.networkError {}
        XCTAssertEqual(keptCheckoutIds(proMonthly), ["chk_2"])
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)
    }
}

/// Transaction updates and checkout bookkeeping. This class runs after `BillFnStoreKitTests` in the same host process:
/// StoreKit testing showed a forced renewal to the app only once earlier tests had purchased in that process.
final class BillFnStoreKitUpdateTests: BillFnStoreKitTestCase {
    /// A checkout another attempt saves while BillFn verifies a purchase is kept once that purchase is confirmed.
    func testConfirmedPurchaseRemovesOnlyItsOwnCheckout() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        let kit = launch(backend)

        let purchase = Task { try await kit.purchase(planKey: "pro") }
        try await waitUntil("BillFn's verify call") { await gate.arrivals == 1 }
        let newer = BillFnStoreKitCheckout(checkoutSessionId: "chk_newer", productId: proMonthly, appAccountToken: backend.appAccountToken)
        checkoutStore.save(newer)
        await gate.release()
        let result = try await purchase.value

        guard case .purchased(let checkout, let outcome) = result else {
            return XCTFail("Expected a purchase, got \(result)")
        }
        XCTAssertEqual(checkout.checkoutSessionId, "chk_1")
        XCTAssertTrue(outcome.finished)
        XCTAssertEqual(keptCheckoutIds(proMonthly), ["chk_newer"])
    }

    /// `start(updates:)` confirms each update it is given, here StoreKit testing transactions fed through a stream
    /// because StoreKit testing delivers `Transaction.updates` only to an active app: a renewal is restored onto
    /// its plan and an approved purchase is verified against its kept checkout; both are finished.
    func testListenerConfirmsEachUpdate() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        let recorder = record(kit)
        let (updates, feed) = AsyncStream.makeStream(of: VerificationResult<Transaction>.self)
        await kit.start(updates: updates)
        guard case .purchased(_, let purchase) = try await kit.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }

        try session.forceRenewalOfSubscription(productIdentifier: proMonthly)
        let renewal = try await latestTransaction(after: purchase)
        feed.yield(renewal)
        let renewalOutcomes = try await waitForOutcomes(recorder, count: 2)

        checkoutStore.save(BillFnStoreKitCheckout(checkoutSessionId: "chk_pending", productId: proLifetime, appAccountToken: backend.appAccountToken))
        let approved = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let latestApproved = await Transaction.latest(for: proLifetime)
        let approvedResult = try XCTUnwrap(latestApproved)
        XCTAssertEqual(approvedResult.unsafePayloadValue.id, approved.id)
        feed.yield(approvedResult)
        let outcomes = try await waitForOutcomes(recorder, count: 3)
        feed.finish()

        XCTAssertEqual(renewalOutcomes.last?.transaction.transactionId, String(renewal.unsafePayloadValue.id))
        XCTAssertEqual(outcomes.last?.transaction.transactionId, String(approved.id))
        XCTAssertEqual(outcomes.map(\.finished), [true, true, true])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [String(renewal.unsafePayloadValue.id)])
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1", "chk_pending"])
        XCTAssertEqual(keptCheckoutIds(proLifetime), [])
        for outcome in outcomes {
            try await assertFinished(outcome)
        }
    }

    /// BillFn confirmed a transaction matched to a checkout but the app stopped before finishing it. The next launch,
    /// a retention period later, still verifies it against that checkout and finishes it, with no plans, so without
    /// that checkout it would be skipped for good. A matched checkout whose transaction is finished and an expired
    /// outstanding one are dropped.
    func testConfirmedTransactionLeftUnfinishedIsVerifiedAndFinishedOnTheNextLaunch() async throws {
        let backend = FakeBillFnBackend()
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let outstanding = BillFnStoreKitCheckout(checkoutSessionId: "chk_outstanding", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let confirmed = BillFnStoreKitCheckout(checkoutSessionId: "chk_confirmed", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let finished = BillFnStoreKitCheckout(checkoutSessionId: "chk_finished", productId: proMonthly, appAccountToken: backend.appAccountToken)
        checkoutStore.save(outstanding)
        checkoutStore.save(confirmed)
        checkoutStore.markMatched(confirmed, transactionId: String(bought.id))
        checkoutStore.markMatched(finished, transactionId: "987654321")

        let later = Date().addingTimeInterval(BillFnUserDefaultsCheckoutStore.defaultRetention + 24 * 60 * 60)
        let nextLaunch = launch(backend, plans: [], now: later)
        let outcomes = await nextLaunch.start()

        let outcome = try XCTUnwrap(outcomes.first { $0.transaction.transactionId == String(bought.id) })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_confirmed"])
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertFinished(outcome)
        XCTAssertEqual(checkoutStore(now: later).keptCheckouts(), [])
    }
}
