import BillFnClient
@testable import BillFnStoreKit
import Foundation
import StoreKit
import StoreKitTest
import XCTest

let proMonthly = "billfn.test.pro.month"
let proLifetime = "billfn.test.pro.lifetime"
let unmapped = "billfn.test.unmapped"
/// Longer than any App Store wait for an Ask to Buy request or an interrupted purchase.
let longAfter: TimeInterval = 60 * 24 * 60 * 60
let day: TimeInterval = 24 * 60 * 60

/// Stands in for the BillFn server: records each call and answers like `@billfn/core`'s routes.
actor FakeBillFnBackend: BillFnStoreKitBackend {
    let appAccountToken = UUID()
    private(set) var checkoutIds: [String] = []
    private(set) var verifications: [(checkoutSessionId: String, transaction: BillFnStoreKitTransactionReference)] = []
    private(set) var restores: [(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference)] = []
    var verifyError: (any Error)?
    /// Verifications against these checkouts fail with a network error.
    var unreachableCheckouts: Set<String> = []
    /// While set, each checkout BillFn opens has this session id.
    var checkoutSessionIdOverride: String?
    var restoreError: (any Error)?
    /// While set, each verification waits here before answering.
    var verifyGate: (@Sendable () async -> Void)?
    /// While set, each restore waits here before answering.
    var restoreGate: (@Sendable () async -> Void)?

    func holdVerifications(_ gate: (@Sendable () async -> Void)?) {
        verifyGate = gate
    }

    func holdRestores(_ gate: (@Sendable () async -> Void)?) {
        restoreGate = gate
    }

    func failVerifications(against checkoutSessionIds: Set<String>) {
        unreachableCheckouts = checkoutSessionIds
    }

    func openCheckouts(withSessionId id: String?) {
        checkoutSessionIdOverride = id
    }

    func failVerification(with error: (any Error)?) {
        verifyError = error
    }

    func failRestore(with error: (any Error)?) {
        restoreError = error
    }

    func createCheckout(_ request: BillFnStoreKitCheckoutRequest) async throws -> BillFnStoreKitCheckout {
        let id = checkoutSessionIdOverride ?? "chk_\(checkoutIds.count + 1)"
        checkoutIds.append(id)
        let productId = request.planKey == "pro-lifetime" ? proLifetime : proMonthly
        return BillFnStoreKitCheckout(checkoutSessionId: id, productId: productId, appAccountToken: appAccountToken)
    }

    func verifyCheckout(checkoutSessionId: String, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        verifications.append((checkoutSessionId, transaction))
        if let verifyGate { await verifyGate() }
        if let verifyError { throw verifyError }
        if unreachableCheckouts.contains(checkoutSessionId) { throw URLError(.notConnectedToInternet) }
        return .object(["checkoutSession": .object(["checkoutSessionId": .string(checkoutSessionId), "status": "succeeded"])])
    }

    func restorePurchase(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        restores.append((plan, transaction))
        if let restoreGate { await restoreGate() }
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
/// StoreKit testing keeps some state between tests, so `run-tests.sh` runs the tests that simulate a purchase error
/// or Ask to Buy in their own host processes, and makes no purchase after a simulated error in the same process.
class BillFnStoreKitTestCase: XCTestCase {
    var session: SKTestSession!
    var defaults: UserDefaults!
    private var kits: [BillFnStoreKit] = []
    let plans = [BillFnStoreKitPlan(productId: proMonthly, planKey: "pro", priceId: "price_pro_apple_month")]

    override func setUp() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "BillFn", withExtension: "storekit"))
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        defaults = UserDefaults(suiteName: "billfn.storekit.tests.\(UUID().uuidString)")
        // A clear that reached the app's cache or the StoreKit testing session late (this one, or the previous test's
        // or host process's) would drop this test's purchases, or leave a transaction this test would take as its own,
        // such as an Ask to Buy request, which Transaction.all never lists.
        try await waitForStoreKit("the cleared transactions to leave Transaction.all and the session") { all, _ in
            all.isEmpty && self.session.allTransactions().isEmpty
        }
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

    func allTransactionIds() async -> [UInt64] {
        var ids: [UInt64] = []
        for await result in Transaction.all {
            ids.append(result.unsafePayloadValue.id)
        }
        return ids
    }

    /// Polls `attempt` until it returns a value from the app's StoreKit transaction cache (what `Transaction.all`,
    /// `.unfinished` and `.latest` read). StoreKit testing fills that cache from `storekitagent` apart from what
    /// `purchase()` returns: on macOS 26 (CI) a just-bought transaction is missing from all three when read right away,
    /// and on macOS 27 one can be missing from `Transaction.unfinished` until the app syncs. So after 2 seconds this
    /// syncs with the App Store once, which refreshes the cache, and keeps polling. Every store-state assertion goes
    /// through here, so a transaction the cache does not list is never evidence; on a timeout the error shows what the
    /// cache and the StoreKit testing session hold.
    func pollStoreKit<Value>(_ what: String, timeout: TimeInterval = 20, _ attempt: () async -> Value?) async throws -> Value {
        let started = Date()
        var synced = false
        while Date().timeIntervalSince(started) < timeout {
            if let value = await attempt() { return value }
            if !synced, Date().timeIntervalSince(started) > 2 {
                synced = true
                try await AppStore.sync()
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let all = await allTransactionIds().sorted()
        let unfinished = await unfinishedTransactionIds().sorted()
        throw TimedOut(waitingFor: "\(what): Transaction.all \(all), Transaction.unfinished \(unfinished), SKTestSession \(describeSession())")
    }

    /// Every transaction the StoreKit testing session holds, with the state that decides renewals and Ask to Buy.
    func describeSession() -> String {
        let held = session.allTransactions().sorted { $0.identifier < $1.identifier }.map { held in
            "\(held.identifier) \(held.productIdentifier) (original \(held.originalTransactionIdentifier), state \(held.state.rawValue), "
                + "purchased \(held.purchaseDate), expires \(held.expirationDate.map { "\($0)" } ?? "never"), "
                + "autoRenewing \(held.autoRenewingEnabled), askToBuy \(held.pendingAskToBuyConfirmation), issue \(held.hasPurchaseIssue))"
        }
        return "[\(held.joined(separator: "; "))]"
    }

    /// Waits until the transactions the cache lists satisfy `condition`.
    func waitForStoreKit(
        _ what: String,
        timeout: TimeInterval = 20,
        _ condition: @escaping (_ all: Set<UInt64>, _ unfinished: Set<UInt64>) -> Bool
    ) async throws {
        try await pollStoreKit(what, timeout: timeout) { () async -> Void? in
            let all = Set(await allTransactionIds())
            let unfinished = Set(await unfinishedTransactionIds())
            return condition(all, unfinished) ? () : nil
        }
    }

    /// The transaction `read` returns once `accept` takes it, such as `Transaction.latest(for:)` after a renewal.
    func waitForTransaction(
        _ what: String,
        read: () async -> VerificationResult<Transaction>?,
        where accept: (Transaction) -> Bool
    ) async throws -> VerificationResult<Transaction> {
        try await pollStoreKit(what) {
            guard let result = await read(), accept(result.unsafePayloadValue) else { return nil }
            return result
        }
    }

    /// Waits until StoreKit lists transaction `id`, and lists it as unfinished when `unfinished` is true.
    func waitUntilStoreKitLists(_ id: UInt64, unfinished: Bool, timeout: TimeInterval = 20) async throws {
        try await waitForStoreKit("transaction \(id) in Transaction.all\(unfinished ? " and .unfinished" : "")", timeout: timeout) { all, unfinishedIds in
            all.contains(id) && (!unfinished || unfinishedIds.contains(id))
        }
    }

    func waitUntilStoreKitLists(_ outcome: BillFnStoreKitTransactionOutcome) async throws {
        try await waitUntilStoreKitLists(try XCTUnwrap(UInt64(outcome.transaction.transactionId)), unfinished: !outcome.finished)
    }

    /// What is missing to show that BillFnStoreKit finished the transaction, nil when nothing is. StoreKit gives no
    /// evidence that a transaction was finished: absence from `Transaction.unfinished` is none, since on macOS 26
    /// StoreKit testing leaves out transactions that are still unfinished. The evidence is the finished outcome, the
    /// checkout store's record that `finish()` returned, and StoreKit listing the transaction.
    func missingFinishEvidence(_ outcome: BillFnStoreKitTransactionOutcome) async -> String? {
        guard outcome.finished else { return "its outcome is \(outcome.status)" }
        guard checkoutStore.isFinished(transactionId: outcome.transaction.transactionId) else {
            return "it is not recorded finished"
        }
        guard let id = UInt64(outcome.transaction.transactionId) else { return "it has no StoreKit id" }
        do {
            try await waitUntilStoreKitLists(id, unfinished: false)
        } catch {
            return "\(error)"
        }
        return nil
    }

    func assertFinished(_ outcome: BillFnStoreKitTransactionOutcome, file: StaticString = #filePath, line: UInt = #line) async throws {
        if let missing = await missingFinishEvidence(outcome) {
            XCTFail("Transaction \(outcome.transaction.transactionId) is not shown finished: \(missing)", file: file, line: line)
        }
    }

    func assertUnfinished(_ id: UInt64, file: StaticString = #filePath, line: UInt = #line) async throws {
        do {
            try await waitUntilStoreKitLists(id, unfinished: true)
        } catch let error as TimedOut {
            XCTFail("Transaction \(id) is not unfinished: \(error.waitingFor)", file: file, line: line)
        }
    }

    /// The subscription's renewal after `purchase`: the StoreKit testing session records it (else the error shows
    /// what the session holds), then the app's cache reports it as the newest transaction.
    func latestTransaction(after purchase: BillFnStoreKitTransactionOutcome) async throws -> VerificationResult<Transaction> {
        do {
            try await waitUntil("the session to record a \(proMonthly) renewal after \(purchase.transaction.transactionId)") {
                self.session.allTransactions().contains {
                    $0.productIdentifier == proMonthly && String($0.identifier) != purchase.transaction.transactionId
                }
            }
        } catch let error as TimedOut {
            throw TimedOut(waitingFor: "\(error.waitingFor); the session holds \(describeSession())")
        }
        return try await waitForTransaction("a \(proMonthly) transaction after \(purchase.transaction.transactionId)", read: {
            await Transaction.latest(for: proMonthly)
        }, where: { String($0.id) != purchase.transaction.transactionId })
    }

    /// Transaction `id` as `Transaction.all` lists it once `accept` takes it.
    func listedTransaction(_ id: UInt64, where accept: (Transaction) -> Bool = { _ in true }) async throws -> VerificationResult<Transaction> {
        try await waitForTransaction("transaction \(id) in Transaction.all", read: {
            for await result in Transaction.all where result.unsafePayloadValue.id == id {
                return result
            }
            return nil
        }, where: accept)
    }

    /// An enumeration that leaves every transaction out, as StoreKit can leave out an unfinished one.
    func noTransactions() -> AsyncStream<VerificationResult<Transaction>> {
        AsyncStream { $0.finish() }
    }

    /// An enumeration of exactly these transactions, in this order.
    func transactions(_ results: [VerificationResult<Transaction>]) -> AsyncStream<VerificationResult<Transaction>> {
        AsyncStream { continuation in
            results.forEach { continuation.yield($0) }
            continuation.finish()
        }
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

    /// These transactions as `Transaction.all` reports them, for the tests that pass `restore(entitlements:)` a set
    /// order of entitlements. The production `restore()` reads `Transaction.currentEntitlements` (see
    /// `testProductionRestoreConfirmsTheCurrentEntitlements`).
    func entitlements(_ transactions: [Transaction]) async -> AsyncStream<VerificationResult<Transaction>> {
        let ids = Set(transactions.map(\.id))
        var results: [VerificationResult<Transaction>] = []
        for await result in Transaction.all where ids.contains(result.unsafePayloadValue.id) {
            results.append(result)
        }
        XCTAssertEqual(Set(results.map(\.unsafePayloadValue.id)), ids, "Transaction.all is missing a transaction")
        return AsyncStream { continuation in
            results.forEach { continuation.yield($0) }
            continuation.finish()
        }
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
        try await waitUntilStoreKitLists(verification.unsafePayloadValue.id, unfinished: true)
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

    /// BillFn's checkout has an empty session id, so no transaction could be verified against it: nothing is bought.
    func testCheckoutWithoutASessionIdBuysNothing() async throws {
        let backend = FakeBillFnBackend()
        await backend.openCheckouts(withSessionId: "")
        let kit = launch(backend)

        do {
            let result = try await kit.purchase(planKey: "pro")
            XCTFail("Expected invalidCheckout, got \(result)")
        } catch let error as BillFnStoreKitError {
            XCTAssertEqual(error, .invalidCheckout("missing checkoutSessionId"))
        }
        XCTAssertTrue(session.allTransactions().isEmpty, "StoreKit bought \(describeSession())")
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)

        await backend.openCheckouts(withSessionId: nil)
        guard case .purchased(let checkout, let outcome) = try await kit.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        XCTAssertEqual(checkout.checkoutSessionId, "chk_2")
        try await assertFinished(outcome)
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
        try await waitUntilStoreKitLists(outcome)
        let unfinishedAfterFailure = await unfinishedTransactionIds()
        XCTAssertTrue(unfinishedAfterFailure.contains(transactionId))

        await backend.failVerification(with: nil)
        let nextLaunch = launch(backend)
        let retried = await nextLaunch.start()

        XCTAssertEqual(retried.map(\.transaction.transactionId), [outcome.transaction.transactionId])
        XCTAssertEqual(retried.map(\.finished), [true])
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1", "chk_1"])
        try await assertFinished(try XCTUnwrap(retried.first))
    }

    /// BillFn could not verify a purchase that maps to no plan. Its checkout records the transaction before the verify
    /// call, so it stays: the next launch, long afterwards, still verifies the transaction against
    /// it and finishes it. Without that checkout the transaction would be skipped for good.
    func testTransactionWhoseVerifyFailedKeepsItsCheckoutPastRetention() async throws {
        let backend = FakeBillFnBackend()
        await backend.failVerification(with: URLError(.notConnectedToInternet))
        let firstLaunch = launch(backend, plans: [])

        guard case .purchased(_, let failed) = try await firstLaunch.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        XCTAssertFalse(failed.finished)
        try await waitUntilStoreKitLists(failed)
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [failed.transaction.transactionId])

        await backend.failVerification(with: nil)
        let later = Date().addingTimeInterval(longAfter)
        // A launch whose StoreKit cache leaves the unfinished transaction out of every enumeration does not take it as
        // finished: BillFn has not confirmed it, so its checkout stays bound.
        let omitted = await launch(backend, plans: [], now: later).processUnfinishedTransactions(noTransactions(), history: noTransactions())
        XCTAssertTrue(omitted.isEmpty)
        XCTAssertEqual(checkoutStore(now: later).keptCheckouts().map(\.transactionId), [failed.transaction.transactionId])
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

        let outcomes = try await kit.restore(syncWithAppStore: false, entitlements: await entitlements([older]))

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
        // The session, not the app's cache, shows that StoreKit made no transaction: it holds only the request.
        XCTAssertEqual(session.allTransactions().map(\.pendingAskToBuyConfirmation), [true])
    }

    func testRestoreConfirmsEachEntitlementWithBillFnAndLeavesUnmappedProductsUnfinished() async throws {
        let backend = FakeBillFnBackend()
        // Bought before this install: there is no checkout on this device, so BillFn restores it by its plan.
        let subscription = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let other = try await buyOutsideBillFn(unmapped, appAccountToken: nil)
        let kit = launch(backend)

        let outcomes = try await kit.restore(entitlements: await entitlements([subscription, other]))

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
        try await assertUnfinished(other.id)
    }

    /// The production `restore()`: it syncs with the App Store and confirms each transaction
    /// `Transaction.currentEntitlements` reports, here the subscription (restored onto its plan and finished) and the
    /// unmapped product (skipped, left unfinished). StoreKit testing reports current entitlements on macOS 26 (CI);
    /// on macOS 27 its `storekitagent` reports none, so there this test fails.
    func testProductionRestoreConfirmsTheCurrentEntitlements() async throws {
        let backend = FakeBillFnBackend()
        let subscription = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let other = try await buyOutsideBillFn(unmapped, appAccountToken: nil)
        let kit = launch(backend)

        let outcomes = try await kit.restore()

        XCTAssertEqual(
            outcomes.map(\.transaction.transactionId).sorted(), [String(subscription.id), String(other.id)].sorted(),
            "restore() confirms each current entitlement"
        )
        let restored = try XCTUnwrap(outcomes.first { $0.transaction.productId == proMonthly })
        XCTAssertTrue(restored.finished)
        let skipped = try XCTUnwrap(outcomes.first { $0.transaction.productId == unmapped })
        if case .skipped = skipped.status {} else { XCTFail("Expected the unmapped product to be skipped, got \(skipped.status)") }
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [String(subscription.id)])
        XCTAssertEqual(restores.map(\.plan.planKey), ["pro"])
        let verifications = await backend.verifications
        XCTAssertTrue(verifications.isEmpty)
        try await assertFinished(restored)
        try await assertUnfinished(other.id)
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
        try await assertUnfinished(renewal.unsafePayloadValue.id)

        // No checkout waits for the renewal, but it is recorded pending: a launch whose `Transaction.unfinished` leaves
        // it out and whose history lists it retries it, and finishes it once BillFn confirms it.
        await backend.failRestore(with: nil)
        let retried = await launch(backend).processUnfinishedTransactions(noTransactions(), history: transactions([renewal]))
        XCTAssertEqual(retried.map(\.transaction.transactionId), [outcome.transaction.transactionId])
        try await assertFinished(try XCTUnwrap(retried.first))
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [outcome.transaction.transactionId, outcome.transaction.transactionId])
    }

    /// A renewal carries the billing account's token, like a leftover checkout from an attempt that never produced a
    /// transaction (here saved before the renewal). It does not claim that checkout: it is restored onto its plan and
    /// finished, and the leftover checkout stays outstanding and unmatched.
    func testRenewalLeavesALeftoverCheckoutOutstanding() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        guard case .purchased(_, let purchase) = try await kit.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        let leftover = BillFnStoreKitCheckout(checkoutSessionId: "chk_leftover", productId: proMonthly, appAccountToken: backend.appAccountToken)
        let savedAt = Date()
        checkoutStore(now: savedAt).save(leftover)

        try session.forceRenewalOfSubscription(productIdentifier: proMonthly)
        let renewal = try await latestTransaction(after: purchase)
        let outcome = await kit.process(renewal)

        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1"])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [outcome.transaction.transactionId])
        try await assertFinished(outcome)
        XCTAssertEqual(checkoutStore.keptCheckouts(), [BillFnStoreKitKeptCheckout(checkout: leftover, savedAt: savedAt)])
    }

    /// A purchase BillFn confirmed and the app finished is offered again on later launches (a redelivered update,
    /// `restore()`) after another attempt on the product left a checkout outstanding, within the clock tolerance of
    /// the purchase. It claims nothing: it is restored onto its plan, and the leftover stays outstanding and unmatched.
    func testConfirmedPurchaseOfferedAgainLeavesALeftoverCheckoutOutstanding() async throws {
        let backend = FakeBillFnBackend()
        guard case .purchased(_, let purchase) = try await launch(backend).purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        XCTAssertTrue(purchase.finished)
        try await waitUntilStoreKitLists(purchase)
        let leftover = BillFnStoreKitCheckout(checkoutSessionId: "chk_leftover", productId: proMonthly, appAccountToken: backend.appAccountToken)
        let savedAt = Date()
        checkoutStore(now: savedAt).save(leftover)
        let offeredAgain = try await waitForTransaction("\(proMonthly)'s latest transaction", read: {
            await Transaction.latest(for: proMonthly)
        }, where: { String($0.id) == purchase.transaction.transactionId })

        let redelivered = await launch(backend).process(offeredAgain)
        let restored = try await launch(backend).restore(
            syncWithAppStore: false,
            entitlements: await entitlements([offeredAgain.unsafePayloadValue])
        )

        XCTAssertTrue(redelivered.finished)
        XCTAssertEqual(restored.map(\.transaction.transactionId), [purchase.transaction.transactionId])
        XCTAssertEqual(restored.map(\.finished), [true])
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1"])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [purchase.transaction.transactionId, purchase.transaction.transactionId])
        XCTAssertEqual(checkoutStore.keptCheckouts(), [BillFnStoreKitKeptCheckout(checkout: leftover, savedAt: savedAt)])
    }

    /// BillFn rejects verifying a transaction against its checkout for good. With no plan for the product that is the
    /// outcome: the transaction stays unfinished and its checkout stays bound to it. A later launch whose plans map
    /// the product verifies once more, is rejected again and restores the transaction onto the plan instead, so it is
    /// finished rather than retried against the checkout forever.
    func testTransactionBillFnRejectsForGoodIsRestoredOntoItsPlan() async throws {
        let backend = FakeBillFnBackend()
        let conflict = BillFnClientError.server(code: "BILLFN_CONFLICT", message: "Not the latest transaction", status: 409, retryable: false)
        await backend.failVerification(with: conflict)
        let firstLaunch = launch(backend, plans: [])

        guard case .purchased(_, let rejected) = try await firstLaunch.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        XCTAssertEqual(rejected.status, .failed(BillFnStoreKitFailure(code: "BILLFN_CONFLICT", message: "Not the latest transaction", retryable: false)))
        try await assertUnfinished(try XCTUnwrap(UInt64(rejected.transaction.transactionId)))
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [rejected.transaction.transactionId])
        let restoresBefore = await backend.restores
        XCTAssertTrue(restoresBefore.isEmpty)

        let nextLaunch = launch(backend)
        let outcomes = await nextLaunch.start()

        let outcome = try XCTUnwrap(outcomes.first { $0.transaction.transactionId == rejected.transaction.transactionId })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1", "chk_1"])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.transactionId), [rejected.transaction.transactionId])
        XCTAssertEqual(restores.map(\.plan.planKey), ["pro"])
        try await assertFinished(outcome)
        // Restoring resolved the binding; BillFn never confirmed the transaction against the checkout it rejected.
        XCTAssertEqual(checkoutStore.record(transactionId: outcome.transaction.transactionId)?.resolution, .restore(rejectedCheckout: "chk_1"))
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
    }

    /// A retryable `BILLFN_CONFLICT` (BillFn is still importing the purchase) is no rejection of the checkout: the
    /// transaction is not restored onto its plan, and stays unfinished and bound to its checkout.
    func testRetryableConflictDoesNotFallBackToRestore() async throws {
        let backend = FakeBillFnBackend()
        let conflict = BillFnClientError.server(code: "BILLFN_CONFLICT", message: "Import pending", status: 409, retryable: true)
        await backend.failVerification(with: conflict)
        let lifetimePlans = plans + [BillFnStoreKitPlan(productId: proLifetime, planKey: "pro-lifetime")]

        guard case .purchased(_, let failed) = try await launch(backend, plans: lifetimePlans).purchase(planKey: "pro-lifetime") else {
            return XCTFail("Expected a purchase")
        }

        XCTAssertEqual(failed.status, .failed(BillFnStoreKitFailure(error: conflict)))
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertUnfinished(try XCTUnwrap(UInt64(failed.transaction.transactionId)))
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [failed.transaction.transactionId])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.settled), [false])
    }

    /// BillFn's route answers an unexpected failure with HTTP 500 BILLFN_INTERNAL_ERROR (retryable false). That says
    /// nothing about the checkout, so the transaction is not restored onto its plan instead: it stays unfinished and
    /// bound to its checkout, and the next launch verifies it against that checkout again.
    func testInternalErrorDoesNotFallBackToRestore() async throws {
        let backend = FakeBillFnBackend()
        let internalError = BillFnClientError.server(code: "BILLFN_INTERNAL_ERROR", message: "Unexpected billfn error", status: 500, retryable: false)
        await backend.failVerification(with: internalError)

        guard case .purchased(_, let failed) = try await launch(backend).purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }

        XCTAssertEqual(failed.status, .failed(BillFnStoreKitFailure(error: internalError)))
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertUnfinished(try XCTUnwrap(UInt64(failed.transaction.transactionId)))
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [failed.transaction.transactionId])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.settled), [false])

        await backend.failVerification(with: nil)
        let retried = await launch(backend).processUnfinishedTransactions(noTransactions(), history: Transaction.all)
        let outcome = try XCTUnwrap(retried.first { $0.transaction == failed.transaction })
        try await assertFinished(outcome)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1", "chk_1"])
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
    }

    /// The real `Transaction.updates`: the forced renewal reaches the listener, which restores it onto its plan.
    /// StoreKit testing delivers it only when LaunchServices can find the host app (see `run-tests.sh`). On macOS 26 it
    /// also offers the purchase again through `Transaction.updates` once the purchase reaches the app's transaction
    /// cache; the listener restores that onto its plan too, and finishes it again.
    func testListenerConfirmsTransactionUpdates() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        let recorder = record(kit)
        await kit.start()
        guard case .purchased(_, let purchase) = try await kit.purchase(planKey: "pro") else {
            return XCTFail("Expected a purchase")
        }
        try await waitUntilStoreKitLists(purchase)

        try session.forceRenewalOfSubscription(productIdentifier: proMonthly)
        try await waitUntil("the renewal's outcome") {
            await recorder.outcomes.contains { $0.transaction.transactionId != purchase.transaction.transactionId }
        }

        let outcomes = await recorder.outcomes
        XCTAssertEqual(outcomes.first?.transaction.transactionId, purchase.transaction.transactionId)
        XCTAssertEqual(Set(outcomes.map(\.transaction.originalTransactionId)), [purchase.transaction.originalTransactionId])
        XCTAssertEqual(Set(outcomes.map(\.transaction.transactionId)).count, 2, "Expected the purchase and one renewal")
        XCTAssertTrue(outcomes.allSatisfy(\.finished))
        let renewalId = try XCTUnwrap(outcomes.last { $0.transaction.transactionId != purchase.transaction.transactionId }).transaction.transactionId
        let restores = await backend.restores
        XCTAssertTrue(restores.contains { $0.transaction.transactionId == renewalId && $0.plan.planKey == "pro" })
        XCTAssertEqual(Set(restores.map(\.transaction.transactionId)).subtracting([purchase.transaction.transactionId]), [renewalId])
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_1"])
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
        // The session, not the app's cache, shows that StoreKit made no transaction. On macOS 26 StoreKit testing
        // records the simulated cancellation as a failed payment, which is no transaction; a record in any other state
        // (purchasing, purchased, restored or deferred) would be one the cancellation left behind.
        let made = session.allTransactions().filter { $0.state != .failed }
        XCTAssertTrue(made.isEmpty, "StoreKit kept a transaction for the cancelled purchase: the session holds \(describeSession())")
        // Synced with the App Store, the app's cache agrees: Transaction.all lists nothing for the product.
        try await AppStore.sync()
        var listed: [UInt64] = []
        for await transaction in Transaction.all where transaction.unsafePayloadValue.productID == proMonthly {
            listed.append(transaction.unsafePayloadValue.id)
        }
        XCTAssertEqual(listed, [], "Transaction.all lists a transaction for the cancelled purchase; the session holds \(describeSession())")
    }

    /// A pending purchase's checkout survives a second attempt on the same product that the user cancels, so
    /// the first purchase, approved later, is verified against its own checkout on the next launch.
    /// `proLifetime` maps to no plan, so without its kept checkout the approved purchase would be skipped.
    /// The first attempt stays an Ask to Buy request until after the cancellation: StoreKit testing answers a purchase
    /// of a non-consumable the user already owns with the transaction they own, ignoring the simulated cancellation.
    func testCancelledSecondAttemptKeepsThePendingAttemptsCheckout() async throws {
        let backend = FakeBillFnBackend()
        let kit = launch(backend)
        session.askToBuyEnabled = true
        guard case .pending(let pending) = try await kit.purchase(planKey: "pro-lifetime") else {
            return XCTFail("Expected the first attempt to wait for approval")
        }
        let request = try XCTUnwrap(session.allTransactions().first { $0.pendingAskToBuyConfirmation })
        session.askToBuyEnabled = false

        try await session.setSimulatedError(.generic(.userCancelled), forAPI: .purchase)
        let second = try await kit.purchase(planKey: "pro-lifetime")

        guard case .cancelled(let cancelled) = second else {
            return XCTFail("Expected the second attempt to be cancelled, got \(second)")
        }
        XCTAssertEqual(cancelled.checkoutSessionId, "chk_2")
        XCTAssertEqual(keptCheckoutIds(proLifetime), [pending.checkoutSessionId])

        // The first attempt is approved while the app is not running; its transaction waits unfinished.
        try await session.setSimulatedError(nil, forAPI: .purchase)
        try session.approveAskToBuyTransaction(identifier: request.identifier)
        let approved = UInt64(request.identifier)
        try await waitUntilStoreKitLists(approved, unfinished: true)
        let nextLaunch = launch(backend)
        let retried = await nextLaunch.start()

        let outcome = try XCTUnwrap(retried.first { $0.transaction.transactionId == String(approved) })
        XCTAssertTrue(outcome.finished)
        XCTAssertEqual(outcome.transaction.appAccountToken, backend.appAccountToken)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), [pending.checkoutSessionId])
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        XCTAssertEqual(keptCheckoutIds(proLifetime), [])
        try await assertFinished(outcome)
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

/// Transaction updates and checkout bookkeeping.
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

    /// The store-state assertions rest only on evidence: an id StoreKit does not list is never taken as listed, and a
    /// listed transaction left unfinished on purpose, even with an outcome claiming it finished and BillFn's
    /// confirmation of it recorded, has no finish evidence; whether `Transaction.unfinished` lists it is not consulted.
    /// Once a launch confirms and finishes it, it has.
    func testStoreStateAssertionsRestOnlyOnEvidence() async throws {
        let backend = FakeBillFnBackend()
        let attempt = BillFnStoreKitCheckout(checkoutSessionId: "chk_attempt", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(attempt)
        let leftUnfinished = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)

        do {
            try await waitUntilStoreKitLists(leftUnfinished.id + 1, unfinished: false, timeout: 3)
            XCTFail("A transaction StoreKit does not list was taken as listed")
        } catch is TimedOut {}
        let reference = BillFnStoreKitTransactionReference(
            transactionId: String(leftUnfinished.id), originalTransactionId: String(leftUnfinished.originalID),
            productId: proLifetime, appAccountToken: backend.appAccountToken
        )
        let claimed = BillFnStoreKitTransactionOutcome(transaction: reference, status: .confirmed(.null))
        // As a launch leaves it that BillFn confirmed and that stopped before finish() returned.
        XCTAssertEqual(checkoutStore.claim(BillFnStoreKit.facts(leftUnfinished), purchasedWith: attempt), attempt)
        checkoutStore.record(BillFnStoreKit.facts(leftUnfinished), state: .confirmed, resolution: .checkout(attempt.checkoutSessionId))
        let missing = await missingFinishEvidence(claimed)
        XCTAssertEqual(missing, "it is not recorded finished", "A transaction left unfinished was taken as finished")

        let confirmed = await launch(backend, plans: []).process(try await listedTransaction(leftUnfinished.id))
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_attempt"])
        try await assertFinished(confirmed)
    }

    /// A transaction refunded while BillFn confirms its earlier observation is not answered with that pass's stale
    /// outcome: once the pass ends, BillFn confirms the revoked transaction in its own pass, and each pass publishes
    /// its outcome once, the stale one first. The same observation offered meanwhile joins the running pass and
    /// publishes nothing. Repeated with the original caller at background priority and the changed one at high
    /// priority, the revoked outcome is still published last.
    func testRevocationDuringConfirmationIsConfirmedInItsOwnPass() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdRestores { await gate.wait() }
        let bought = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let observed = try await listedTransaction(bought.id) { $0.revocationDate == nil }
        let kit = launch(backend)
        let recorder = record(kit)

        let first = Task { await kit.process(observed) }
        try await waitUntil("BillFn's restore call") { await gate.arrivals == 1 }
        try session.refundTransaction(identifier: UInt(bought.id))
        let revoked = try await listedTransaction(bought.id) { $0.revocationDate != nil }
        let same = Task { await kit.process(observed) }
        let changed = Task { await kit.process(revoked) }
        try await waitUntil("both callers to wait for the running pass") { await kit.callersWaitingForARunningPass == 2 }
        let arrivalsWhileHeld = await gate.arrivals
        XCTAssertEqual(arrivalsWhileHeld, 1, "Only one pass runs for the transaction at a time")
        await gate.release()

        let firstOutcome = await first.value
        let sameOutcome = await same.value
        let changedOutcome = await changed.value
        XCTAssertEqual(sameOutcome, firstOutcome)
        XCTAssertFalse(firstOutcome.transaction.revoked)
        XCTAssertTrue(changedOutcome.transaction.revoked)
        XCTAssertTrue(changedOutcome.finished)
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.revoked), [false, true])
        // A later pass publishes after anything the three calls published, so a third outcome here would be the
        // joined call's.
        let later = await kit.process(revoked)
        let outcomes = try await waitForOutcomes(recorder, count: 3)
        XCTAssertEqual(outcomes, [firstOutcome, changedOutcome, later])

        for run in 1...25 {
            let runBackend = FakeBillFnBackend()
            let runGate = Gate()
            await runBackend.holdRestores { await runGate.wait() }
            let runKit = launch(runBackend)
            let runRecorder = record(runKit)
            let original = Task(priority: .background) { await runKit.process(observed) }
            try await waitUntil("run \(run)'s restore call") { await runGate.arrivals == 1 }
            let refunded = Task(priority: .high) { await runKit.process(revoked) }
            try await waitUntil("run \(run)'s changed caller to wait") { await runKit.callersWaitingForARunningPass == 1 }
            await runGate.release()
            _ = await original.value
            _ = await refunded.value
            let published = try await waitForOutcomes(runRecorder, count: 2)
            XCTAssertEqual(published.map(\.transaction.revoked), [false, true], "Run \(run) published out of order")
        }
    }

    /// Two `BillFnStoreKit`s sharing one checkout store race two purchases of one product (the first refunded, then
    /// bought again) for the one outstanding checkout both may claim. Exactly one binds it; its verification fails, so
    /// it stays bound to that transaction. The other has no checkout and is restored onto its plan; finishing it removes
    /// no checkout, so the failed transaction keeps its binding for the next launch.
    func testTwoInstancesRacingForOneCheckoutBindItOnce() async throws {
        let backend = FakeBillFnBackend()
        await backend.failVerification(with: URLError(.notConnectedToInternet))
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        await backend.holdRestores { await gate.wait() }
        let shared = BillFnStoreKitCheckout(checkoutSessionId: "chk_shared", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(shared)
        let first = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        try session.refundTransaction(identifier: UInt(first.id))
        _ = try await listedTransaction(first.id) { $0.revocationDate != nil }
        let second = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let lifetimePlans = [BillFnStoreKitPlan(productId: proLifetime, planKey: "pro-lifetime")]
        let firstObserved = try await listedTransaction(first.id)
        let secondObserved = try await listedTransaction(second.id)

        let kits = [launch(backend, plans: lifetimePlans), launch(backend, plans: lifetimePlans)]
        let one = Task { await kits[0].process(firstObserved) }
        let two = Task { await kits[1].process(secondObserved) }
        try await waitUntil("both passes to reach BillFn") { await gate.arrivals == 2 }
        await gate.release()
        let outcomes = [await one.value, await two.value]

        let verifications = await backend.verifications
        let restores = await backend.restores
        XCTAssertEqual(verifications.count, 1, "Exactly one transaction is verified against the shared checkout")
        XCTAssertEqual(restores.count, 1)
        let winner = try XCTUnwrap(verifications.first?.transaction.transactionId)
        XCTAssertEqual(verifications.first?.checkoutSessionId, "chk_shared")
        XCTAssertEqual(outcomes.filter(\.finished).map(\.transaction.transactionId), restores.map(\.transaction.transactionId))
        XCTAssertFalse(try XCTUnwrap(outcomes.first { $0.transaction.transactionId == winner }).finished)
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.checkout), [shared])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [winner])
    }

    /// A launch BillFn could not confirm a transaction in, from `Transaction.unfinished`, whose history lists it refunded
    /// since: the changed observation reaches BillFn in its own pass, after the first, and is published last; the
    /// unchanged one in the history is not confirmed again. A later launch confirms the refunded one and finishes it.
    func testFailedObservationThenRefundedInTheHistoryIsConfirmedInItsOwnPass() async throws {
        let backend = FakeBillFnBackend()
        await backend.failRestore(with: URLError(.notConnectedToInternet))
        let bought = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let observed = try await listedTransaction(bought.id) { $0.revocationDate == nil }
        try session.refundTransaction(identifier: UInt(bought.id))
        let revoked = try await listedTransaction(bought.id) { $0.revocationDate != nil }
        let kit = launch(backend)
        let recorder = record(kit)

        let outcomes = await kit.processUnfinishedTransactions(transactions([observed]), history: transactions([observed, revoked]))

        XCTAssertEqual(outcomes.map(\.transaction.revoked), [false, true])
        XCTAssertEqual(outcomes.map(\.finished), [false, false])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.revoked), [false, true])
        let published = try await waitForOutcomes(recorder, count: 2)
        XCTAssertEqual(published, outcomes)

        await backend.failRestore(with: nil)
        let retried = await launch(backend).processUnfinishedTransactions(noTransactions(), history: transactions([revoked]))
        XCTAssertEqual(retried.map(\.transaction.revoked), [true])
        try await assertFinished(try XCTUnwrap(retried.first))
    }

    /// `start(updates:)` confirms each update it is given, here StoreKit testing transactions fed through a stream in
    /// a set order: a renewal is restored onto its plan and an approved purchase is verified against its kept
    /// checkout; both are finished.
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
        let approvedResult = try await waitForTransaction("\(proLifetime)'s latest transaction", read: {
            await Transaction.latest(for: proLifetime)
        }, where: { $0.id == approved.id })
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

    /// BillFn confirmed a transaction bound to a checkout but the app stopped before finishing it. A launch long
    /// afterwards whose StoreKit cache leaves the transaction out of every enumeration keeps its checkout, that of a
    /// transaction BillFn never confirmed and an outstanding one; it drops one whose transaction is recorded finished
    /// (the app stopped between finishing it and removing the checkout). The next launch still verifies the
    /// transaction against its checkout and finishes it, with no plans, so without that checkout it would be skipped
    /// for good.
    func testConfirmedTransactionLeftUnfinishedIsVerifiedAndFinishedOnTheNextLaunch() async throws {
        let backend = FakeBillFnBackend()
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let outstanding = BillFnStoreKitCheckout(checkoutSessionId: "chk_outstanding", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let confirmed = BillFnStoreKitCheckout(checkoutSessionId: "chk_confirmed", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let finished = BillFnStoreKitCheckout(checkoutSessionId: "chk_finished", productId: proMonthly, appAccountToken: backend.appAccountToken)
        let unconfirmed = BillFnStoreKitCheckout(checkoutSessionId: "chk_unconfirmed", productId: proMonthly, appAccountToken: backend.appAccountToken)
        let elsewhere = { (id: String) in
            BillFnStoreKitTransactionFacts(transactionId: id, productId: proMonthly, appAccountToken: backend.appAccountToken, purchaseDate: Date(), isPurchase: true)
        }
        checkoutStore.save(outstanding)
        for (checkout, facts, state) in [
            (confirmed, BillFnStoreKit.facts(bought), BillFnStoreKitConfirmationState.confirmed),
            (finished, elsewhere("987654321"), .finished),
            (unconfirmed, elsewhere("987654322"), .pending),
        ] {
            checkoutStore.save(checkout)
            XCTAssertEqual(checkoutStore.claim(facts, purchasedWith: checkout), checkout)
            checkoutStore.record(facts, state: state, resolution: .checkout(checkout.checkoutSessionId))
        }

        let later = Date().addingTimeInterval(longAfter)
        let omitted = await launch(backend, plans: [], now: later).processUnfinishedTransactions(noTransactions(), history: noTransactions())
        XCTAssertTrue(omitted.isEmpty)
        XCTAssertEqual(checkoutStore(now: later).keptCheckouts().map(\.checkout), [outstanding, confirmed, unconfirmed])

        let nextLaunch = launch(backend, plans: [], now: later.addingTimeInterval(day))
        let outcomes = await nextLaunch.start()

        let outcome = try XCTUnwrap(outcomes.first { $0.transaction.transactionId == String(bought.id) })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_confirmed"])
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertFinished(outcome)
        XCTAssertEqual(checkoutStore(now: later).keptCheckouts().map(\.checkout), [outstanding, unconfirmed])
    }

    /// A purchase completed while the app was not running (an approved Ask to Buy request, an interrupted purchase), so
    /// it was never bound to its outstanding checkout, and the app is next launched long afterwards. Two launches a day
    /// apart whose StoreKit caches leave the transaction out of every enumeration keep the checkout: neither time nor
    /// absence is evidence that the attempt produced no transaction. A launch whose `Transaction.unfinished` still
    /// leaves it out finds it in `Transaction.all`, as it may claim that checkout: it verifies it against the checkout,
    /// with no plans (without the checkout it would be skipped for good), and keeps it unfinished and bound while BillFn
    /// cannot confirm it. The next such launch finishes it once BillFn confirms it. The other attempt's checkout, which
    /// nothing showed produced no transaction, stays.
    func testTransactionCompletedWhileStoppedIsVerifiedAgainstItsExpiredCheckout() async throws {
        let backend = FakeBillFnBackend()
        let attempt = BillFnStoreKitCheckout(checkoutSessionId: "chk_attempt", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let abandoned = BillFnStoreKitCheckout(checkoutSessionId: "chk_abandoned", productId: proMonthly, appAccountToken: backend.appAccountToken)
        checkoutStore.save(abandoned)
        checkoutStore.save(attempt)
        // StoreKit completes the attempt's purchase; no BillFnStoreKit sees it before the next launch.
        let completed = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)

        let later = Date().addingTimeInterval(longAfter)
        for launchedAt in [later, later.addingTimeInterval(day)] {
            let allOmitted = await launch(backend, plans: [], now: launchedAt).processUnfinishedTransactions(noTransactions(), history: noTransactions())
            XCTAssertTrue(allOmitted.isEmpty)
            XCTAssertEqual(checkoutStore.keptCheckouts().map(\.checkout), [abandoned, attempt])
            XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [nil, nil])
        }

        await backend.failVerification(with: URLError(.notConnectedToInternet))
        let failed = await launch(backend, plans: [], now: later.addingTimeInterval(2 * day)).processUnfinishedTransactions(noTransactions(), history: Transaction.all)
        XCTAssertEqual(failed.map(\.transaction.transactionId), [String(completed.id)])
        XCTAssertEqual(failed.map(\.finished), [false])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.checkout), [abandoned, attempt])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [nil, String(completed.id)])
        try await assertUnfinished(completed.id)

        await backend.failVerification(with: nil)
        let outcomes = await launch(backend, plans: [], now: later.addingTimeInterval(3 * day)).processUnfinishedTransactions(noTransactions(), history: Transaction.all)

        let outcome = try XCTUnwrap(outcomes.first { $0.transaction.transactionId == String(completed.id) })
        XCTAssertTrue(outcome.finished)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_attempt", "chk_attempt"])
        XCTAssertEqual(verifications.map(\.transaction.transactionId), [String(completed.id), String(completed.id)])
        let restores = await backend.restores
        XCTAssertTrue(restores.isEmpty)
        try await assertFinished(outcome)
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.checkout), [abandoned])
    }

    /// The same transaction offered without a purchase checkout (an update, a launch retry, a restore) while the
    /// purchase's own pass verifies it joins that pass: one BillFn call, one published outcome, the same confirmed
    /// outcome for both callers.
    func testUpdateDuringAPurchaseJoinsThePurchasePass() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        let own = BillFnStoreKitCheckout(checkoutSessionId: "chk_own", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(own)
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let observed = try await listedTransaction(bought.id)
        let kit = launch(backend, plans: [])
        let recorder = record(kit)

        let purchase = Task { await kit.process(observed, checkout: own) }
        try await waitUntil("the purchase's verify call") { await gate.arrivals == 1 }
        let update = Task { await kit.process(observed) }
        try await waitUntil("the update to wait for the purchase's pass") { await kit.callersWaitingForARunningPass == 1 }
        await gate.release()
        let purchaseOutcome = await purchase.value
        let updateOutcome = await update.value

        XCTAssertTrue(purchaseOutcome.finished)
        XCTAssertEqual(updateOutcome, purchaseOutcome)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_own"])
        // A later pass publishes after anything the two calls published, so a second confirmed outcome before it
        // would be the joined call's.
        let later = await kit.process(observed)
        let published = try await waitForOutcomes(recorder, count: 2)
        XCTAssertEqual(published, [purchaseOutcome, later])
        try await assertFinished(purchaseOutcome)
    }

    /// Two `BillFnStoreKit`s sharing one store confirm one transaction at once: one from a background pass, which binds
    /// the older outstanding checkout, the other from the purchase, with its own checkout. BillFn confirms the first and
    /// cannot be reached for the second. Finishing the first removes only the checkout it was confirmed against; the
    /// purchase's checkout stays bound and unconfirmed, so the next launch, finding the finished transaction only in its
    /// history, verifies it against that checkout and removes it once BillFn confirms.
    func testTwoInstancesConfirmingOneTransactionAgainstTwoCheckoutsKeepTheFailedOne() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        await backend.failVerifications(against: ["chk_own"])
        let older = BillFnStoreKitCheckout(checkoutSessionId: "chk_older", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let own = BillFnStoreKitCheckout(checkoutSessionId: "chk_own", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(older)
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(own)
        let observed = try await listedTransaction(bought.id)

        let kits = [launch(backend, plans: []), launch(backend, plans: [])]
        let background = Task { await kits[0].process(observed) }
        try await waitUntil("the background pass's verify call") { await gate.arrivals == 1 }
        let purchase = Task { await kits[1].process(observed, checkout: own) }
        try await waitUntil("the purchase's verify call") { await gate.arrivals == 2 }
        await gate.release()
        let backgroundOutcome = await background.value
        let purchaseOutcome = await purchase.value

        XCTAssertTrue(backgroundOutcome.finished)
        XCTAssertFalse(purchaseOutcome.finished)
        XCTAssertEqual(checkoutStore.keptCheckouts(), [
            BillFnStoreKitKeptCheckout(checkout: own, savedAt: try XCTUnwrap(checkoutStore.keptCheckouts().first).savedAt, transactionId: String(bought.id)),
        ])

        await backend.failVerifications(against: [])
        let retried = await launch(backend, plans: []).processUnfinishedTransactions(noTransactions(), history: transactions([observed]))
        XCTAssertEqual(retried.map(\.finished), [true])
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId).sorted(), ["chk_older", "chk_own", "chk_own"])
        XCTAssertEqual(verifications.last?.checkoutSessionId, "chk_own")
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
    }

    /// A purchase's own result overlaps a background pass (an update) that bound its transaction to an older
    /// outstanding checkout. The purchase does not take that pass's outcome: once it ends, the purchase's transaction is
    /// verified against the purchase's own checkout in its own pass, and both checkouts go once BillFn confirms.
    func testPurchaseOverlappingABackgroundPassIsVerifiedAgainstItsOwnCheckout() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        let older = BillFnStoreKitCheckout(checkoutSessionId: "chk_older", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let own = BillFnStoreKitCheckout(checkoutSessionId: "chk_own", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(older)
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(own)
        let observed = try await listedTransaction(bought.id)
        let kit = launch(backend, plans: [])
        let recorder = record(kit)

        let background = Task { await kit.process(observed) }
        try await waitUntil("the background pass's verify call") { await gate.arrivals == 1 }
        let purchase = Task { await kit.process(observed, checkout: own) }
        try await waitUntil("the purchase to wait for the running pass") { await kit.callersWaitingForARunningPass == 1 }
        await gate.release()
        let backgroundOutcome = await background.value
        let purchaseOutcome = await purchase.value

        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_older", "chk_own"])
        XCTAssertTrue(backgroundOutcome.finished)
        XCTAssertTrue(purchaseOutcome.finished)
        let published = try await waitForOutcomes(recorder, count: 2)
        XCTAssertEqual(published, [backgroundOutcome, purchaseOutcome])
        try await assertFinished(purchaseOutcome)
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
    }

    /// A purchase on the billing account finished on another device: this device has not confirmed it, so the first
    /// launch whose `Transaction.all` lists it verifies it against the expired checkout it could claim, and BillFn
    /// decides. Once BillFn confirms it, the checkout goes, and the transaction, offered again, claims nothing.
    func testPurchaseFinishedElsewhereIsConfirmedAgainstTheCheckoutItCouldClaim() async throws {
        let backend = FakeBillFnBackend()
        let leftover = BillFnStoreKitCheckout(checkoutSessionId: "chk_leftover", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(leftover)
        let elsewhere = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        await elsewhere.finish()
        let listed = try await listedTransaction(elsewhere.id)

        let later = Date().addingTimeInterval(longAfter)
        let outcomes = await launch(backend, plans: [], now: later).processUnfinishedTransactions(noTransactions(), history: Transaction.all)
        XCTAssertEqual(outcomes.map(\.transaction.transactionId), [String(elsewhere.id)])
        XCTAssertEqual(outcomes.map(\.finished), [true])
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
        XCTAssertTrue(checkoutStore.isFinished(transactionId: String(elsewhere.id)))

        let offeredAgain = await launch(backend, plans: [], now: later).process(listed)
        XCTAssertEqual(offeredAgain.status, .skipped("No BillFn checkout or plan for product \(proLifetime)"))
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_leftover"])
    }

    /// A transaction BillFn confirmed and the app finished unrevoked, refunded since and listed only in the history:
    /// the refund still reaches BillFn. Its first update fails, and the next launch, again with only the history,
    /// confirms it and records it finished.
    func testRefundAfterFinishIsConfirmedFromTheHistory() async throws {
        let backend = FakeBillFnBackend()
        let bought = try await buyOutsideBillFn(proMonthly, appAccountToken: backend.appAccountToken)
        let first = await launch(backend).process(try await listedTransaction(bought.id) { $0.revocationDate == nil })
        try await assertFinished(first)
        try session.refundTransaction(identifier: UInt(bought.id))
        let revoked = try await listedTransaction(bought.id) { $0.revocationDate != nil }
        // With no plan or checkout to confirm the refund through, a launch leaves it alone instead of skipping it each time.
        let unmapped = await launch(backend, plans: []).processUnfinishedTransactions(noTransactions(), history: transactions([revoked]))
        XCTAssertTrue(unmapped.isEmpty)

        await backend.failRestore(with: URLError(.notConnectedToInternet))
        let failed = await launch(backend).processUnfinishedTransactions(noTransactions(), history: transactions([revoked]))
        XCTAssertEqual(failed.map(\.transaction.revoked), [true])
        XCTAssertEqual(failed.map(\.finished), [false])

        await backend.failRestore(with: nil)
        let retried = await launch(backend).processUnfinishedTransactions(noTransactions(), history: transactions([revoked]))
        XCTAssertEqual(retried.map(\.transaction.revoked), [true])
        XCTAssertEqual(retried.map(\.finished), [true])
        let restores = await backend.restores
        XCTAssertEqual(restores.map(\.transaction.revoked), [false, true, true])
        XCTAssertEqual(checkoutStore.records(transactionId: String(bought.id)).map(\.state), [.finished, .finished])
        let again = await launch(backend).processUnfinishedTransactions(noTransactions(), history: transactions([revoked]))
        XCTAssertTrue(again.isEmpty)
    }

    /// A background pass bound the transaction to the purchase's own checkout (the only outstanding one): the purchase
    /// joins it, so BillFn verifies once and one outcome is published. While that purchase is still being made, its
    /// result arriving after the pass removed the checkout gets the pass's outcome too, and does not keep the checkout
    /// again or verify a second time; once the purchase returns, nothing of it is kept.
    func testPurchaseJoinsABackgroundPassBoundToItsCheckout() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        let own = BillFnStoreKitCheckout(checkoutSessionId: "chk_own", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let kit = launch(backend, plans: [])
        let recorder = record(kit)
        await kit.startPurchase(own)
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        let observed = try await listedTransaction(bought.id)

        let background = Task { await kit.process(observed) }
        try await waitUntil("the background pass's verify call") { await gate.arrivals == 1 }
        let purchase = Task { await kit.process(observed, checkout: own) }
        try await waitUntil("the purchase to join the running pass") { await kit.callersWaitingForARunningPass == 1 }
        await gate.release()
        let backgroundOutcome = await background.value
        let purchaseOutcome = await purchase.value
        let late = await kit.process(observed, checkout: own)
        await kit.endPurchase(own)

        XCTAssertTrue(backgroundOutcome.finished)
        XCTAssertEqual(purchaseOutcome, backgroundOutcome)
        XCTAssertEqual(late, backgroundOutcome)
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_own"])
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
        // A later pass publishes after anything the calls published, so a second outcome before it would be a joined one's.
        let after = await kit.process(observed)
        let published = try await waitForOutcomes(recorder, count: 2)
        XCTAssertEqual(published, [backgroundOutcome, after])
        try await assertFinished(backgroundOutcome)
    }

    /// While the purchase waits for a background pass bound to an older checkout, its own checkout is already bound to
    /// its transaction in the store, so a launch that stops during the wait leaves the next launch to verify the
    /// transaction against it, from the history alone.
    func testPurchaseCheckoutIsBoundBeforeWaiting() async throws {
        let backend = FakeBillFnBackend()
        let gate = Gate()
        await backend.holdVerifications { await gate.wait() }
        let older = BillFnStoreKitCheckout(checkoutSessionId: "chk_older", productId: proLifetime, appAccountToken: backend.appAccountToken)
        let own = BillFnStoreKitCheckout(checkoutSessionId: "chk_own", productId: proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(older)
        let bought = try await buyOutsideBillFn(proLifetime, appAccountToken: backend.appAccountToken)
        checkoutStore.save(own)
        let observed = try await listedTransaction(bought.id)
        let kit = launch(backend, plans: [])

        let background = Task { await kit.process(observed) }
        try await waitUntil("the background pass's verify call") { await gate.arrivals == 1 }
        let purchase = Task { await kit.process(observed, checkout: own) }
        try await waitUntil("the purchase to wait for the running pass") { await kit.callersWaitingForARunningPass == 1 }

        // What a launch that stopped here would find.
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.checkout), [older, own])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.transactionId), [String(bought.id), String(bought.id)])
        XCTAssertEqual(checkoutStore.keptCheckouts().map(\.settled), [false, false])

        await gate.release()
        _ = await background.value
        _ = await purchase.value
        let verifications = await backend.verifications
        XCTAssertEqual(verifications.map(\.checkoutSessionId), ["chk_older", "chk_own"])
        XCTAssertEqual(checkoutStore.keptCheckouts(), [])
    }
}
