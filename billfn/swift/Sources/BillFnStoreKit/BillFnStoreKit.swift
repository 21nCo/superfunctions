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
    private var inFlight: [UInt64: Task<BillFnStoreKitTransactionOutcome, Never>] = [:]
    /// Checkouts a transaction is being verified against, so a concurrent one does not use the same checkout.
    private var claimedCheckouts: Set<String> = []
    private var listener: Task<Void, Never>?
    private let outcomeContinuation: AsyncStream<BillFnStoreKitTransactionOutcome>.Continuation

    /// Every transaction outcome, whether it came from a purchase, an update, a retry or a restore.
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

    /// Confirms every unfinished transaction with BillFn and finishes those it confirms, then reconciles the checkout
    /// store: drops matched checkouts whose transaction is finished and, only now that every unfinished transaction
    /// has been offered the checkouts it could claim, outstanding checkouts past the store's retention.
    @discardableResult
    public func processUnfinishedTransactions() async -> [BillFnStoreKitTransactionOutcome] {
        // Only checkouts matched before reading the unfinished transactions are swept: a transaction matched while
        // they are read (a purchase completing meanwhile) may be missing from what was read.
        let matchedBefore = checkouts.keptCheckouts().filter { $0.transactionId != nil }
        var results: [BillFnStoreKitTransactionOutcome] = []
        var unfinished: Set<String> = []
        for await transaction in Transaction.unfinished {
            unfinished.insert(String(transaction.unsafePayloadValue.id))
            results.append(await process(transaction))
        }
        // A matched checkout whose transaction is no longer unfinished was left by a launch that stopped between
        // finishing the transaction and removing the checkout. One being verified right now is claimed.
        let keptNow = checkouts.keptCheckouts()
        for kept in matchedBefore {
            let checkoutSessionId = kept.checkout.checkoutSessionId
            guard let transactionId = kept.transactionId, !unfinished.contains(transactionId),
                  !claimedCheckouts.contains(checkoutSessionId),
                  keptNow.contains(where: { $0.checkout.checkoutSessionId == checkoutSessionId && $0.transactionId == transactionId })
            else { continue }
            checkouts.removeCheckout(checkoutSessionId: checkoutSessionId)
        }
        // An expired outstanding checkout no unfinished transaction claimed belongs to an attempt that never produced
        // a transaction. The store removes it only if it is still outstanding; one being verified against is kept.
        checkouts.removeExpiredOutstandingCheckouts(excluding: claimedCheckouts)
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
        if syncWithAppStore {
            try await AppStore.sync()
        }
        var results: [BillFnStoreKitTransactionOutcome] = []
        for await entitlement in Transaction.currentEntitlements {
            results.append(await process(entitlement))
        }
        return results
    }

    /// Confirms one transaction with BillFn and finishes it if BillFn confirms it; `start()` passes each
    /// `Transaction.updates` element here. A transaction with a kept checkout for its product and `appAccountToken`
    /// (the one it was already matched to, else, unless it is a renewal, the oldest outstanding one saved before it
    /// was purchased) is verified against that checkout; any other one (a renewal, a restored purchase) is restored
    /// onto the plan its product maps to.
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
        if let running = inFlight[transaction.id] {
            return await running.value
        }
        let task = Task { await self.confirmNow(transaction, purchasedWith: checkout) }
        inFlight[transaction.id] = task
        let outcome = await task.value
        inFlight[transaction.id] = nil
        outcomeContinuation.yield(outcome)
        return outcome
    }

    private func confirmNow(_ transaction: Transaction, purchasedWith purchaseCheckout: BillFnStoreKitCheckout?) async -> BillFnStoreKitTransactionOutcome {
        let reference = BillFnStoreKitTransactionReference(
            transactionId: String(transaction.id),
            originalTransactionId: String(transaction.originalID),
            productId: transaction.productID,
            appAccountToken: transaction.appAccountToken,
            revoked: transaction.revocationDate != nil
        )
        let checkout = claimCheckout(for: transaction, purchasedWith: purchaseCheckout)
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
    /// as `BILLFN_CONFLICT` once a later renewal superseded the transaction) and a plan maps the product, the
    /// transaction is restored onto the plan instead (by its original transaction id), so it is not retried against
    /// the checkout forever. With no plan, the rejection is the outcome: the transaction stays unfinished and its
    /// checkout kept, and each launch reports it again as a non-retryable failure.
    private func verify(_ reference: BillFnStoreKitTransactionReference, against checkout: BillFnStoreKitCheckout) async throws -> BillFnJSONValue {
        do {
            return try await backend.verifyCheckout(checkoutSessionId: checkout.checkoutSessionId, transaction: reference)
        } catch BillFnClientError.server(_, _, _, false) where plans[reference.productId] != nil {
            return try await backend.restorePurchase(plan: plans[reference.productId]!, transaction: reference)
        }
    }

    /// Whether the transaction can be the one a purchase attempt produced, so it may claim an outstanding checkout.
    /// A renewal never is: every renewal carries the billing account's `appAccountToken`, so it would otherwise take a
    /// leftover checkout (an attempt that failed on the network or was declined) and send BillFn's verify a renewal id.
    /// From iOS 17 and macOS 14 StoreKit says why the transaction exists, so an upgrade, a crossgrade or a
    /// resubscription bought through its own checkout (whose id differs from its original id) still claims it.
    /// Earlier systems do not say, so there only a first purchase (id equal to its original id) claims one; any other
    /// transaction is restored onto the plan its product maps to, and skipped if none does.
    static func mayCompleteAnAttempt(_ transaction: Transaction) -> Bool {
        if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
            return transaction.reason == .purchase
        }
        return transaction.id == transaction.originalID
    }

    /// How much earlier than a checkout was saved a transaction's purchase date may be and still claim it, for a
    /// device clock ahead of the App Store's.
    static let checkoutClockTolerance: TimeInterval = 15 * 60

    /// The checkout to verify the transaction against: the purchase's own one, else the kept checkout this transaction
    /// was already matched to, else the oldest outstanding kept checkout for its product and `appAccountToken` saved
    /// before the transaction was purchased. Never one matched to another transaction or one another transaction is
    /// being verified against, and never an outstanding one for a renewal (`mayCompleteAnAttempt`) or for a
    /// transaction bought before its attempt started (a restored purchase), which would take a pending attempt's checkout.
    private func claimCheckout(for transaction: Transaction, purchasedWith purchaseCheckout: BillFnStoreKitCheckout?) -> BillFnStoreKitCheckout? {
        let transactionId = String(transaction.id)
        let kept = checkouts.keptCheckouts()
        let available: (BillFnStoreKitCheckout) -> Bool = { checkout in
            guard checkout.productId == transaction.productID, checkout.appAccountToken == transaction.appAccountToken,
                  !self.claimedCheckouts.contains(checkout.checkoutSessionId) else { return false }
            let matchedTo = kept.first(where: { $0.checkout.checkoutSessionId == checkout.checkoutSessionId })?.transactionId
            return matchedTo == nil || matchedTo == transactionId
        }
        let latestSave = transaction.purchaseDate.addingTimeInterval(Self.checkoutClockTolerance)
        let candidate = purchaseCheckout.flatMap { available($0) ? $0 : nil }
            ?? kept.first(where: { $0.transactionId == transactionId && available($0.checkout) })?.checkout
            ?? (Self.mayCompleteAnAttempt(transaction)
                ? kept.first(where: { $0.transactionId == nil && $0.savedAt <= latestSave && available($0.checkout) })?.checkout
                : nil)
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
