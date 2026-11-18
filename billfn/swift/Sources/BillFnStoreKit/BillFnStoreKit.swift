import BillFnClient
import Foundation
import StoreKit

public struct BillFnStoreKitFailure: Error, Sendable, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool

    public init(code: String, message: String, retryable: Bool) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }

    /// Maps a BillFn, StoreKit or transport error to the code a caller (or the web bridge) reports.
    public init(error: any Error) {
        switch error {
        case BillFnClientError.server(let code, let message, _, let retryable):
            self.init(code: code, message: message, retryable: retryable)
        case let error as BillFnStoreKitError:
            self.init(code: "BILLFN_STOREKIT_ERROR", message: String(describing: error), retryable: false)
        case let error as URLError:
            self.init(code: "BILLFN_NETWORK_ERROR", message: error.localizedDescription, retryable: true)
        // StoreKit wraps the transport error when it cannot reach the App Store (loading products,
        // purchasing, syncing), so it is retryable like a BillFn network error.
        case StoreKitError.networkError(let underlying):
            self.init(code: "BILLFN_NETWORK_ERROR", message: underlying.localizedDescription, retryable: true)
        // A StoreKit system error (the device's StoreKit daemon failed) is transient: trying again can succeed.
        case StoreKitError.systemError(let underlying):
            self.init(code: "BILLFN_STOREKIT_FAILED", message: underlying.localizedDescription, retryable: true)
        case let error as BillFnClientError:
            self.init(code: "BILLFN_INVALID_RESPONSE", message: String(describing: error), retryable: false)
        default:
            self.init(code: "BILLFN_STOREKIT_FAILED", message: error.localizedDescription, retryable: false)
        }
    }
}

/// What BillFn did with one StoreKit transaction.
public struct BillFnStoreKitTransactionOutcome: Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        /// BillFn verified the transaction and returned this billing state; the transaction is finished.
        case confirmed(BillFnJSONValue)
        /// BillFn did not confirm it. The transaction stays unfinished, so StoreKit offers it again on the next launch.
        case failed(BillFnStoreKitFailure)
        /// No checkout or plan maps the product to BillFn, so the transaction is left unfinished.
        case skipped(String)
    }

    public let transaction: BillFnStoreKitTransactionReference
    public let status: Status

    public init(transaction: BillFnStoreKitTransactionReference, status: Status) {
        self.transaction = transaction
        self.status = status
    }

    public var finished: Bool {
        if case .confirmed = status { return true }
        return false
    }
}

public enum BillFnStoreKitPurchaseResult: Sendable, Equatable {
    /// StoreKit completed the purchase. The outcome says whether BillFn confirmed (and the app finished) it.
    case purchased(BillFnStoreKitCheckout, BillFnStoreKitTransactionOutcome)
    /// Awaiting approval (Ask to Buy) or another action; the transaction arrives later through `Transaction.updates`.
    case pending(BillFnStoreKitCheckout)
    case cancelled(BillFnStoreKitCheckout)
}

/// StoreKit 2 purchases through BillFn. Each purchase opens a BillFn checkout and buys its product with the
/// billing account's `appAccountToken`; a transaction is finished only after BillFn confirms it, so one BillFn
/// could not confirm is offered again by `Transaction.unfinished` and retried by `start()` on the next launch.
public actor BillFnStoreKit {
    private let backend: any BillFnStoreKitBackend
    private let plans: [String: BillFnStoreKitPlan]
    private let checkouts: any BillFnStoreKitCheckoutStore
    /// The confirmation pass running for each transaction, with the observation of it that pass sends BillFn.
    private var inFlight: [UInt64: (observation: BillFnStoreKitTransactionReference, task: Task<BillFnStoreKitTransactionOutcome, Never>)] = [:]
    /// How many callers are waiting for a running pass on the same transaction to end (tests wait on it).
    private(set) var callersWaitingForARunningPass = 0
    /// Checkouts a transaction is being verified against, so a concurrent one does not use the same checkout.
    private var claimedCheckouts: Set<String> = []
    private var listener: Task<Void, Never>?
    private let outcomeContinuation: AsyncStream<BillFnStoreKitTransactionOutcome>.Continuation

    /// Every transaction outcome, whether it came from a purchase, an update, a retry or a restore: one per
    /// confirmation pass, published as the pass ends, so a call that joins a running pass adds none.
    /// It keeps the newest 64 outcomes until read; iterate it from a single task.
    public nonisolated let outcomes: AsyncStream<BillFnStoreKitTransactionOutcome>

    public init(
        backend: any BillFnStoreKitBackend,
        plans: [BillFnStoreKitPlan] = [],
        checkouts: any BillFnStoreKitCheckoutStore = BillFnUserDefaultsCheckoutStore()
    ) {
        self.backend = backend
        self.plans = Dictionary(plans.map { ($0.productId, $0) }, uniquingKeysWith: { _, last in last })
        self.checkouts = checkouts
        (outcomes, outcomeContinuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(64))
    }

    public init(
        client: BillFnClient,
        plans: [BillFnStoreKitPlan] = [],
        checkouts: any BillFnStoreKitCheckoutStore = BillFnUserDefaultsCheckoutStore()
    ) {
        self.init(backend: BillFnHTTPStoreKitBackend(client: client), plans: plans, checkouts: checkouts)
    }

    deinit {
        listener?.cancel()
        outcomeContinuation.finish()
    }

    /// Listens to `Transaction.updates` and confirms the transactions earlier launches left unfinished.
    /// Call it once at launch, before any purchase.
    @discardableResult
    public func start() async -> [BillFnStoreKitTransactionOutcome] {
        await start(updates: Transaction.updates)
    }

    /// `start()` with the transaction updates to listen to; `start()` passes `Transaction.updates`.
    /// Each element is confirmed by `process(_:)`. Only the first call's listener runs until `stop()`.
    @discardableResult
    public func start<Updates: AsyncSequence & Sendable>(
        updates: Updates
    ) async -> [BillFnStoreKitTransactionOutcome] where Updates.Element == VerificationResult<Transaction> {
        if listener == nil {
            listener = Task.detached { [weak self] in
                do {
                    for try await update in updates {
                        guard let self else { return }
                        await self.process(update)
                    }
                } catch {
                    // The sequence ended with an error; `Transaction.updates` never throws.
                }
            }
        }
        return await processUnfinishedTransactions()
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }

    /// Confirms every unfinished transaction with BillFn and finishes those it confirms, then, only now that every
    /// unfinished transaction has been offered the checkouts it could claim, removes the checkouts past the store's
    /// retention that no transaction can still need (`removeExpiredCheckouts(excluding:offeredTransactionIds:)`).
    @discardableResult
    public func processUnfinishedTransactions() async -> [BillFnStoreKitTransactionOutcome] {
        await processUnfinishedTransactions(Transaction.unfinished)
    }

    /// `processUnfinishedTransactions()` with the unfinished transactions to confirm; it passes `Transaction.unfinished`.
    /// StoreKit can leave an unfinished transaction out of an enumeration, so a transaction missing from `unfinished`
    /// is not taken as finished: a checkout matched to it expires only once BillFn's confirmation of it is recorded.
    @discardableResult
    public func processUnfinishedTransactions<Unfinished: AsyncSequence & Sendable>(
        _ unfinished: Unfinished
    ) async -> [BillFnStoreKitTransactionOutcome] where Unfinished.Element == VerificationResult<Transaction> {
        var results: [BillFnStoreKitTransactionOutcome] = []
        var offered: Set<String> = []
        do {
            for try await transaction in unfinished {
                offered.insert(String(transaction.unsafePayloadValue.id))
                results.append(await process(transaction))
            }
        } catch {
            // A transaction the failed enumeration did not reach may still claim an expired checkout, so none is
            // removed. `Transaction.unfinished` never throws.
            return results
        }
        // A checkout being verified against right now is claimed, and kept.
        checkouts.removeExpiredCheckouts(excluding: claimedCheckouts, offeredTransactionIds: offered)
        return results
    }

    public func purchase(planKey: String, priceId: String? = nil, interval: String? = nil) async throws -> BillFnStoreKitPurchaseResult {
        let checkout = try await backend.createCheckout(
            BillFnStoreKitCheckoutRequest(planKey: planKey, priceId: priceId, interval: interval)
        )
        guard let product = try await Product.products(for: [checkout.productId]).first else {
            throw BillFnStoreKitError.productNotFound(checkout.productId)
        }
        // Saved before buying, so a purchase that completes after this launch still verifies against its checkout.
        checkouts.save(checkout)
        let result: Product.PurchaseResult
        do {
            result = try await product.purchase(options: [.appAccountToken(checkout.appAccountToken)])
        } catch StoreKitError.userCancelled {
            // StoreKit reports some cancellations as an error rather than as `.userCancelled`.
            checkouts.removeCheckout(checkoutSessionId: checkout.checkoutSessionId)
            return .cancelled(checkout)
        } catch let error as Product.PurchaseError {
            // StoreKit refused the purchase before sending it to the App Store, so it cannot produce a transaction.
            checkouts.removeCheckout(checkoutSessionId: checkout.checkoutSessionId)
            throw error
        }
        // Any other error (network, system) may come after the App Store took the purchase, so the checkout stays
        // kept until its transaction arrives or the store's retention expires it.
        switch result {
        case .success(let verification):
            return .purchased(checkout, await process(verification, checkout: checkout))
        case .pending:
            return .pending(checkout)
        case .userCancelled:
            checkouts.removeCheckout(checkoutSessionId: checkout.checkoutSessionId)
            return .cancelled(checkout)
        @unknown default:
            throw BillFnStoreKitError.unknownPurchaseResult
        }
    }

    /// Syncs with the App Store (which may ask the user to sign in) and confirms each current entitlement with BillFn.
    public func restore(syncWithAppStore: Bool = true) async throws -> [BillFnStoreKitTransactionOutcome] {
        try await restore(syncWithAppStore: syncWithAppStore, entitlements: Transaction.currentEntitlements)
    }

    /// `restore()` with the entitlements to confirm; `restore()` passes `Transaction.currentEntitlements`.
    /// Each element is confirmed by `process(_:)`.
    public func restore<Entitlements: AsyncSequence & Sendable>(
        syncWithAppStore: Bool = true,
        entitlements: Entitlements
    ) async throws -> [BillFnStoreKitTransactionOutcome] where Entitlements.Element == VerificationResult<Transaction> {
        if syncWithAppStore {
            try await AppStore.sync()
        }
        var results: [BillFnStoreKitTransactionOutcome] = []
        for try await entitlement in entitlements {
            results.append(await process(entitlement))
        }
        return results
    }

    /// Confirms one transaction with BillFn and finishes it if BillFn confirms it; `start()` passes each
    /// `Transaction.updates` element here. A transaction with a kept checkout for its product and `appAccountToken`
    /// (the one it was already matched to, else the oldest outstanding one its purchase attempt may have saved, see
    /// `mayClaimOutstanding`) is verified against that checkout; any other one (a renewal, a restored purchase, a
    /// transaction BillFn already confirmed) is restored onto the plan its product maps to.
    ///
    /// StoreKit's own signature check is not the trust boundary: BillFn reads the transaction from the App Store
    /// Server API and checks its `appAccountToken`, so a transaction StoreKit could not verify is still sent to
    /// BillFn, and finished only when BillFn confirms it.
    @discardableResult
    public func process(_ verification: VerificationResult<Transaction>) async -> BillFnStoreKitTransactionOutcome {
        await process(verification, checkout: nil)
    }

    /// `checkout` is the one the purchase that produced this transaction opened, when known.
    private func process(
        _ verification: VerificationResult<Transaction>,
        checkout: BillFnStoreKitCheckout?
    ) async -> BillFnStoreKitTransactionOutcome {
        let transaction = verification.unsafePayloadValue
        let reference = BillFnStoreKitTransactionReference(
            transactionId: String(transaction.id),
            originalTransactionId: String(transaction.originalID),
            productId: transaction.productID,
            appAccountToken: transaction.appAccountToken,
            revoked: transaction.revocationDate != nil
        )
        // The same observation joins the running pass and gets its outcome. A changed one (revoked while the running
        // pass confirms the unrevoked transaction) waits for that pass to end, then BillFn confirms it in its own pass.
        while let running = inFlight[transaction.id] {
            callersWaitingForARunningPass += 1
            let outcome = await running.task.value
            callersWaitingForARunningPass -= 1
            if running.observation == reference {
                return outcome
            }
            if inFlight[transaction.id]?.task == running.task {
                inFlight[transaction.id] = nil
            }
        }
        // Each pass publishes its outcome before its task ends, so a changed observation's pass, which starts only after
        // it, publishes after it; a caller that joined a pass publishes nothing.
        let task = Task {
            let outcome = await self.confirmNow(transaction, reference: reference, purchasedWith: checkout)
            self.outcomeContinuation.yield(outcome)
            return outcome
        }
        inFlight[transaction.id] = (reference, task)
        let outcome = await task.value
        if inFlight[transaction.id]?.task == task {
            inFlight[transaction.id] = nil
        }
        return outcome
    }

    private func confirmNow(
        _ transaction: Transaction,
        reference: BillFnStoreKitTransactionReference,
        purchasedWith purchaseCheckout: BillFnStoreKitCheckout?
    ) async -> BillFnStoreKitTransactionOutcome {
        let facts = BillFnStoreKitAttemptFacts(transaction)
        let checkout = claimCheckout(for: facts, reasonIsPurchase: Self.reasonIsPurchase(transaction), purchasedWith: purchaseCheckout)
        defer {
            if let checkout { claimedCheckouts.remove(checkout.checkoutSessionId) }
        }
        do {
            let billing: BillFnJSONValue
            if let checkout {
                // Recorded before BillFn is asked: if the verify call fails or the app stops before `finish()`, the
                // checkout stays kept (it no longer expires) and the next launch verifies against it again.
                checkouts.markMatched(checkout, transactionId: reference.transactionId)
                billing = try await verify(reference, against: checkout)
            } else if let plan = plans[transaction.productID] {
                billing = try await backend.restorePurchase(plan: plan, transaction: reference)
            } else {
                return BillFnStoreKitTransactionOutcome(
                    transaction: reference,
                    status: .skipped("No BillFn checkout or plan for product \(transaction.productID)")
                )
            }
            // Recorded before `finish()`: once StoreKit no longer offers it as unfinished, a redelivered or restored
            // copy must not claim an outstanding checkout.
            checkouts.recordConfirmed(transactionId: reference.transactionId)
            await transaction.finish()
            if let checkout {
                // Only this checkout: another attempt on the product may have saved its own meanwhile.
                checkouts.removeCheckout(checkoutSessionId: checkout.checkoutSessionId)
            }
            return BillFnStoreKitTransactionOutcome(transaction: reference, status: .confirmed(billing))
        } catch {
            return BillFnStoreKitTransactionOutcome(transaction: reference, status: .failed(BillFnStoreKitFailure(error: error)))
        }
    }

    /// Verifies the transaction against its checkout. When BillFn rejects that for good (a non-retryable error, such
    /// as `BILLFN_CONFLICT` once a later renewal superseded the transaction, but not an HTTP error from something in
    /// front of BillFn) and a plan maps the product, the transaction is restored onto the plan instead (by its original
    /// transaction id), so it is not retried against the checkout forever. With no plan, the rejection is the outcome: the transaction stays unfinished and its
    /// checkout kept, and each launch reports it again as a non-retryable failure.
    private func verify(_ reference: BillFnStoreKitTransactionReference, against checkout: BillFnStoreKitCheckout) async throws -> BillFnJSONValue {
        do {
            return try await backend.verifyCheckout(checkoutSessionId: checkout.checkoutSessionId, transaction: reference)
        } catch BillFnClientError.server(let code, _, _, false) where code != "BILLFN_HTTP_ERROR" && plans[reference.productId] != nil {
            return try await backend.restorePurchase(plan: plans[reference.productId]!, transaction: reference)
        }
    }

    /// How much earlier than a checkout was saved a transaction's purchase date may be and still claim it, for a
    /// device clock ahead of the App Store's.
    static let checkoutClockTolerance: TimeInterval = 15 * 60

    /// Whether the transaction can be the one the purchase attempt that saved an outstanding checkout at `savedAt`
    /// produced, so it may claim that checkout. It must have been purchased after the attempt started (within the
    /// clock tolerance): an older one is a restored purchase and would take a pending attempt's checkout. It must be a
    /// purchase, not a renewal: every renewal carries the billing account's `appAccountToken`, so it would take a
    /// leftover checkout (an attempt that failed on the network or was declined) and send BillFn's verify a renewal id.
    /// A first purchase, an upgrade or crossgrade and a resubscription are purchases; a renewal, including one that
    /// recovers from billing retry, is not. When the reason is unknown (`reasonIsPurchase` nil) it claims nothing.
    static func mayClaimOutstanding(_ transaction: BillFnStoreKitAttemptFacts, reasonIsPurchase: Bool?, savedAt: Date) -> Bool {
        guard savedAt <= transaction.purchaseDate.addingTimeInterval(checkoutClockTolerance) else { return false }
        return reasonIsPurchase ?? false
    }

    /// Whether StoreKit says the transaction is a purchase rather than a renewal: `Transaction.reason` from iOS 17 and
    /// macOS 14, else the `transactionReason` of the signed transaction, nil when it has none.
    private static func reasonIsPurchase(_ transaction: Transaction) -> Bool? {
        if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
            return transaction.reason == .purchase
        }
        // Not `reasonStringRepresentation`: before iOS 17 it reports "PURCHASE" when the transaction has no reason.
        return reasonIsPurchase(transactionJSON: transaction.jsonRepresentation)
    }

    /// The `transactionReason` of a signed transaction's JSON payload: true for `PURCHASE`, false for `RENEWAL`, nil
    /// when it is missing or anything else.
    static func reasonIsPurchase(transactionJSON: Data) -> Bool? {
        let payload = try? JSONSerialization.jsonObject(with: transactionJSON) as? [String: Any]
        switch payload?["transactionReason"] as? String {
        case "PURCHASE": return true
        case "RENEWAL": return false
        default: return nil
        }
    }

    /// The checkout to verify the transaction against: the purchase's own one, else the kept checkout this transaction
    /// was already matched to, else the oldest outstanding kept checkout for its product and `appAccountToken` that
    /// it may claim (`mayClaimOutstanding`). Never one matched to another transaction or one another transaction is
    /// being verified against, and never an outstanding one for a transaction BillFn already confirmed.
    private func claimCheckout(
        for transaction: BillFnStoreKitAttemptFacts,
        reasonIsPurchase: Bool?,
        purchasedWith purchaseCheckout: BillFnStoreKitCheckout?
    ) -> BillFnStoreKitCheckout? {
        let transactionId = String(transaction.id)
        let kept = checkouts.keptCheckouts()
        let available: (BillFnStoreKitCheckout) -> Bool = { checkout in
            guard checkout.productId == transaction.productId, checkout.appAccountToken == transaction.appAccountToken,
                  !self.claimedCheckouts.contains(checkout.checkoutSessionId) else { return false }
            let matchedTo = kept.first(where: { $0.checkout.checkoutSessionId == checkout.checkoutSessionId })?.transactionId
            return matchedTo == nil || matchedTo == transactionId
        }
        let mayClaimOutstanding = { (savedAt: Date) in
            !self.checkouts.isConfirmed(transactionId: transactionId)
                && Self.mayClaimOutstanding(transaction, reasonIsPurchase: reasonIsPurchase, savedAt: savedAt)
        }
        let candidate = purchaseCheckout.flatMap { available($0) ? $0 : nil }
            ?? kept.first(where: { $0.transactionId == transactionId && available($0.checkout) })?.checkout
            ?? kept.first(where: { $0.transactionId == nil && available($0.checkout) && mayClaimOutstanding($0.savedAt) })?.checkout
        if let candidate { claimedCheckouts.insert(candidate.checkoutSessionId) }
        return candidate
    }

    public static func manageSubscriptionsURL() -> URL {
        URL(string: "https://apps.apple.com/account/subscriptions")!
    }

    public static func makeManageSubscriptionAction() -> BillFnOperationAction {
        BillFnOperationAction(
            type: "manage-subscription",
            url: manageSubscriptionsURL().absoluteString,
            metadata: ["provider": "apple"]
        )
    }
}

/// What `BillFnStoreKit.mayClaimOutstanding` and the checkout match read from a StoreKit transaction.
struct BillFnStoreKitAttemptFacts: Sendable, Equatable {
    let id: UInt64
    let productId: String
    let appAccountToken: UUID?
    let purchaseDate: Date

    init(id: UInt64, productId: String, appAccountToken: UUID? = nil, purchaseDate: Date) {
        self.id = id
        self.productId = productId
        self.appAccountToken = appAccountToken
        self.purchaseDate = purchaseDate
    }

    init(_ transaction: Transaction) {
        self.init(
            id: transaction.id,
            productId: transaction.productID,
            appAccountToken: transaction.appAccountToken,
            purchaseDate: transaction.purchaseDate
        )
    }
}
