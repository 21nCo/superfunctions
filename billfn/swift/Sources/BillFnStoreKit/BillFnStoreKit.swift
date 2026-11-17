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
        if listener == nil {
            listener = Task.detached { [weak self] in
                for await update in Transaction.updates {
                    guard let self else { return }
                    await self.process(update)
                }
            }
        }
        return await processUnfinishedTransactions()
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }

    /// Confirms every unfinished transaction with BillFn and finishes those it confirms.
    @discardableResult
    public func processUnfinishedTransactions() async -> [BillFnStoreKitTransactionOutcome] {
        var results: [BillFnStoreKitTransactionOutcome] = []
        for await transaction in Transaction.unfinished {
            results.append(await process(transaction))
        }
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
            checkouts.removeCheckout(forProductId: checkout.productId)
            return .cancelled(checkout)
        }
        switch result {
        case .success(let verification):
            return .purchased(checkout, await process(verification))
        case .pending:
            return .pending(checkout)
        case .userCancelled:
            checkouts.removeCheckout(forProductId: checkout.productId)
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
    /// `Transaction.updates` element here. A transaction with a kept checkout is verified against that checkout;
    /// any other one (a renewal, a restored or approved purchase) is restored onto the plan its product maps to.
    ///
    /// StoreKit's own signature check is not the trust boundary: BillFn reads the transaction from the App Store
    /// Server API and checks its `appAccountToken`, so a transaction StoreKit could not verify is still sent to
    /// BillFn, and finished only when BillFn confirms it.
    @discardableResult
    public func process(_ verification: VerificationResult<Transaction>) async -> BillFnStoreKitTransactionOutcome {
        let transaction = verification.unsafePayloadValue
        if let running = inFlight[transaction.id] {
            return await running.value
        }
        let task = Task { await self.confirmNow(transaction) }
        inFlight[transaction.id] = task
        let outcome = await task.value
        inFlight[transaction.id] = nil
        outcomeContinuation.yield(outcome)
        return outcome
    }

    private func confirmNow(_ transaction: Transaction) async -> BillFnStoreKitTransactionOutcome {
        let reference = BillFnStoreKitTransactionReference(
            transactionId: String(transaction.id),
            originalTransactionId: String(transaction.originalID),
            productId: transaction.productID,
            appAccountToken: transaction.appAccountToken,
            revoked: transaction.revocationDate != nil
        )
        do {
            let billing: BillFnJSONValue
            if let checkout = checkouts.checkout(forProductId: transaction.productID),
               checkout.appAccountToken == transaction.appAccountToken {
                billing = try await backend.verifyCheckout(checkoutSessionId: checkout.checkoutSessionId, transaction: reference)
                checkouts.removeCheckout(forProductId: transaction.productID)
            } else if let plan = plans[transaction.productID] {
                billing = try await backend.restorePurchase(plan: plan, transaction: reference)
            } else {
                return BillFnStoreKitTransactionOutcome(
                    transaction: reference,
                    status: .skipped("No BillFn checkout or plan for product \(transaction.productID)")
                )
            }
            await transaction.finish()
            return BillFnStoreKitTransactionOutcome(transaction: reference, status: .confirmed(billing))
        } catch {
            return BillFnStoreKitTransactionOutcome(transaction: reference, status: .failed(BillFnStoreKitFailure(error: error)))
        }
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
