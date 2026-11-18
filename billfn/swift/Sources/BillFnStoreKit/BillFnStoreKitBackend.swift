import BillFnClient
import Foundation

/// Maps an App Store product to the BillFn plan (and price) it sells.
public struct BillFnStoreKitPlan: Sendable, Equatable {
    public let productId: String
    public let planKey: String
    public let priceId: String?

    public init(productId: String, planKey: String, priceId: String? = nil) {
        self.productId = productId
        self.planKey = planKey
        self.priceId = priceId
    }
}

public struct BillFnStoreKitCheckoutRequest: Sendable, Equatable {
    public let planKey: String
    public let priceId: String?
    public let interval: String?

    public init(planKey: String, priceId: String? = nil, interval: String? = nil) {
        self.planKey = planKey
        self.priceId = priceId
        self.interval = interval
    }
}

/// A BillFn Apple checkout: the product to buy and the billing account's `appAccountToken`.
public struct BillFnStoreKitCheckout: Codable, Sendable, Equatable {
    public let checkoutSessionId: String
    public let productId: String
    public let appAccountToken: UUID

    public init(checkoutSessionId: String, productId: String, appAccountToken: UUID) {
        self.checkoutSessionId = checkoutSessionId
        self.productId = productId
        self.appAccountToken = appAccountToken
    }
}

/// The StoreKit transaction fields BillFn needs to confirm it.
public struct BillFnStoreKitTransactionReference: Sendable, Equatable {
    public let transactionId: String
    public let originalTransactionId: String
    public let productId: String
    public let appAccountToken: UUID?
    public let revoked: Bool

    public init(transactionId: String, originalTransactionId: String, productId: String, appAccountToken: UUID?, revoked: Bool = false) {
        self.transactionId = transactionId
        self.originalTransactionId = originalTransactionId
        self.productId = productId
        self.appAccountToken = appAccountToken
        self.revoked = revoked
    }
}

public enum BillFnStoreKitError: Error, Sendable, Equatable {
    /// BillFn's checkout did not return an Apple purchase action with a product and a UUID `appAccountToken`.
    case invalidCheckout(String)
    /// The App Store did not return the product BillFn's checkout names.
    case productNotFound(String)
    /// StoreKit returned a purchase result this version does not know.
    case unknownPurchaseResult
}

/// The BillFn calls a StoreKit purchase needs. `BillFnHTTPStoreKitBackend` makes them over HTTP.
public protocol BillFnStoreKitBackend: Sendable {
    func createCheckout(_ request: BillFnStoreKitCheckoutRequest) async throws -> BillFnStoreKitCheckout
    /// Verifies the transaction against the checkout session that started it; returns BillFn's billing state.
    func verifyCheckout(checkoutSessionId: String, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue
    /// Restores the transaction (a renewal, an approved Ask to Buy or a restored purchase) onto the plan.
    func restorePurchase(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue
}

public struct BillFnHTTPStoreKitBackend: BillFnStoreKitBackend {
    public let client: BillFnClient

    public init(client: BillFnClient) {
        self.client = client
    }

    public func createCheckout(_ request: BillFnStoreKitCheckoutRequest) async throws -> BillFnStoreKitCheckout {
        var body: [String: BillFnJSONValue] = ["planKey": .string(request.planKey), "provider": "apple"]
        if let priceId = request.priceId { body["priceId"] = .string(priceId) }
        if let interval = request.interval { body["interval"] = .string(interval) }
        let data = try await client.send(path: "checkouts", body: .object(body))

        let session = data["checkoutSession"]
        guard let checkoutSessionId = session?["checkoutSessionId"]?.stringValue, !checkoutSessionId.isEmpty else {
            throw BillFnStoreKitError.invalidCheckout("missing checkoutSessionId")
        }
        let action = session?["clientAction"]
        guard action?["type"]?.stringValue == "apple-purchase" else {
            throw BillFnStoreKitError.invalidCheckout("checkout is not an Apple purchase")
        }
        guard let productId = action?["productId"]?.stringValue, !productId.isEmpty else {
            throw BillFnStoreKitError.invalidCheckout("missing productId")
        }
        guard let token = action?["metadata"]?["appAccountToken"]?.stringValue.flatMap(UUID.init(uuidString:)) else {
            throw BillFnStoreKitError.invalidCheckout("missing or invalid appAccountToken")
        }
        return BillFnStoreKitCheckout(checkoutSessionId: checkoutSessionId, productId: productId, appAccountToken: token)
    }

    public func verifyCheckout(checkoutSessionId: String, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        try await client.send(path: "checkouts/verify", body: .object([
            "checkoutSessionId": .string(checkoutSessionId),
            "payload": Self.payload(transaction),
        ]))
    }

    public func restorePurchase(plan: BillFnStoreKitPlan, transaction: BillFnStoreKitTransactionReference) async throws -> BillFnJSONValue {
        var body: [String: BillFnJSONValue] = [
            "planKey": .string(plan.planKey),
            "provider": "apple",
            "purchaseReference": .string(transaction.originalTransactionId),
            "payload": Self.payload(transaction),
        ]
        if let priceId = plan.priceId { body["priceId"] = .string(priceId) }
        return try await client.send(path: "purchases/restore", body: .object(body))
    }

    private static func payload(_ transaction: BillFnStoreKitTransactionReference) -> BillFnJSONValue {
        .object([
            "transactionId": .string(transaction.transactionId),
            "originalTransactionId": .string(transaction.originalTransactionId),
        ])
    }
}

/// A checkout the store keeps for one purchase attempt.
public struct BillFnStoreKitKeptCheckout: Codable, Sendable, Equatable {
    public let checkout: BillFnStoreKitCheckout
    /// When the purchase attempt saved it: a transaction purchased before then (beyond the clock tolerance) never
    /// claims it while it is outstanding.
    public let savedAt: Date
    /// The transaction bound to this checkout (`BillFnStoreKitCheckoutStore.claim(_:purchasedWith:)`), nil while it is
    /// outstanding. The binding is made before BillFn is asked to verify the transaction and is kept however that
    /// ends, so a transaction BillFn has not confirmed yet (a failed verify call, an app that stopped before finishing
    /// it) finds the same checkout on a later launch. The checkout is removed once that transaction is recorded
    /// finished, never because StoreKit left the transaction out of an enumeration.
    public let transactionId: String?

    public init(checkout: BillFnStoreKitCheckout, savedAt: Date, transactionId: String? = nil) {
        self.checkout = checkout
        self.savedAt = savedAt
        self.transactionId = transactionId
    }

    func bound(to transactionId: String?) -> BillFnStoreKitKeptCheckout {
        BillFnStoreKitKeptCheckout(checkout: checkout, savedAt: savedAt, transactionId: transactionId)
    }
}

/// What the checkout store reads from a StoreKit transaction to bind it to a checkout.
public struct BillFnStoreKitTransactionFacts: Codable, Sendable, Equatable {
    public let transactionId: String
    public let productId: String
    public let appAccountToken: UUID?
    public let purchaseDate: Date
    /// Whether StoreKit says the transaction is a purchase (a first purchase, an upgrade or crossgrade, a
    /// resubscription) rather than a renewal; nil when it does not say.
    public let isPurchase: Bool?

    public init(transactionId: String, productId: String, appAccountToken: UUID?, purchaseDate: Date, isPurchase: Bool?) {
        self.transactionId = transactionId
        self.productId = productId
        self.appAccountToken = appAccountToken
        self.purchaseDate = purchaseDate
        self.isPurchase = isPurchase
    }

    /// How much earlier than a checkout was saved a transaction's purchase date may be and still claim it, for a
    /// device clock ahead of the App Store's.
    public static let checkoutClockTolerance: TimeInterval = 15 * 60

    /// Whether the transaction can be the one the purchase attempt that saved an outstanding checkout at `savedAt`
    /// produced, so it may claim that checkout. It must have been purchased after the attempt started (within the
    /// clock tolerance): an older one is a restored purchase and would take a pending attempt's checkout. It must be a
    /// purchase, not a renewal: every renewal carries the billing account's `appAccountToken`, so it would take a
    /// leftover checkout and send BillFn's verify a renewal id. When the reason is unknown it claims nothing.
    public func mayClaimOutstanding(savedAt: Date) -> Bool {
        guard savedAt <= purchaseDate.addingTimeInterval(Self.checkoutClockTolerance) else { return false }
        return isPurchase ?? false
    }

    /// Whether the transaction may claim the outstanding checkout: same product and `appAccountToken`, and
    /// `mayClaimOutstanding(savedAt:)`.
    func mayClaim(_ kept: BillFnStoreKitKeptCheckout) -> Bool {
        kept.transactionId == nil && kept.checkout.productId == productId
            && kept.checkout.appAccountToken == appAccountToken && mayClaimOutstanding(savedAt: kept.savedAt)
    }
}

/// How far BillFn has confirmed a transaction. A state only moves forward.
public enum BillFnStoreKitConfirmationState: Int, Codable, Sendable, Comparable {
    /// BillFn was asked to confirm it and has not (yet): it is retried, also from `Transaction.all`.
    case pending
    /// BillFn confirmed it; `finish()` has not returned yet.
    case confirmed
    /// `finish()` returned.
    case finished

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// What the store records of a transaction BillFnStoreKit has asked BillFn to confirm.
public struct BillFnStoreKitTransactionRecord: Codable, Sendable, Equatable {
    public let facts: BillFnStoreKitTransactionFacts
    public let state: BillFnStoreKitConfirmationState

    public init(facts: BillFnStoreKitTransactionFacts, state: BillFnStoreKitConfirmationState) {
        self.facts = facts
        self.state = state
    }
}

/// Keeps each checkout a purchase started, and what BillFn has confirmed of each transaction, so a purchase that
/// completes later (Ask to Buy, an interrupted app) is still verified against its checkout and a transaction BillFn has
/// not confirmed is retried. Each transaction is bound to at most one checkout, and each checkout to at most one
/// transaction, by `claim(_:purchasedWith:)` alone. A checkout is removed only on positive evidence: the attempt that
/// saved it ended without a transaction (`removeOutstandingCheckout(checkoutSessionId:)`), or the transaction bound to
/// it is recorded finished (`removeCheckout(boundTo:)`, `removeUnneededCheckouts()`). Never because time passed or
/// StoreKit left a transaction out of an enumeration.
public protocol BillFnStoreKitCheckoutStore: Sendable {
    /// Every kept checkout, oldest first.
    func keptCheckouts() -> [BillFnStoreKitKeptCheckout]
    /// Keeps the checkout of a purchase attempt that is starting.
    func save(_ checkout: BillFnStoreKitCheckout)
    /// Binds the transaction to the checkout to verify it against, in one step no other store or actor sharing the
    /// storage can interleave with, and returns it. In order: `purchaseCheckout` (the purchase that produced the
    /// transaction opened it; kept again if it was not, and any other checkout bound to the transaction becomes
    /// outstanding again), else the checkout already bound to the transaction, else, unless BillFn has confirmed the
    /// transaction, the oldest outstanding checkout it may claim (`mayClaim`). Never a checkout bound to another
    /// transaction. Nil when there is none.
    func claim(_ transaction: BillFnStoreKitTransactionFacts, purchasedWith purchaseCheckout: BillFnStoreKitCheckout?) -> BillFnStoreKitCheckout?
    /// Removes the checkout if it is still outstanding: its attempt was cancelled or refused, so produced no
    /// transaction. One a transaction was bound to meanwhile stays.
    func removeOutstandingCheckout(checkoutSessionId: String)
    /// Removes the checkout bound to the transaction, once the transaction is finished.
    func removeCheckout(boundTo transactionId: String)
    /// Records how far BillFn has confirmed the transaction; a recorded state never moves back.
    func record(_ transaction: BillFnStoreKitTransactionFacts, state: BillFnStoreKitConfirmationState)
    func record(transactionId: String) -> BillFnStoreKitTransactionRecord?
    /// Removes each checkout bound to a transaction recorded finished (the app stopped between finishing it and
    /// removing the checkout). It never removes an outstanding checkout.
    func removeUnneededCheckouts()
}

extension BillFnStoreKitCheckoutStore {
    /// The kept checkouts for the product, oldest first.
    public func checkouts(forProductId productId: String) -> [BillFnStoreKitCheckout] {
        keptCheckouts().filter { $0.checkout.productId == productId }.map(\.checkout)
    }

    public func isConfirmed(transactionId: String) -> Bool {
        (record(transactionId: transactionId)?.state ?? .pending) >= .confirmed
    }

    public func isFinished(transactionId: String) -> Bool {
        record(transactionId: transactionId)?.state == .finished
    }
}

/// Keeps checkouts and transaction records in `UserDefaults`. An outstanding checkout stays until its attempt is
/// cancelled or refused or a transaction bound to it is finished: StoreKit gives no evidence that an attempt (a
/// purchase whose result was lost to a network error, an Ask to Buy request) will never produce a transaction.
/// A pending record stays until BillFn confirms the transaction. Confirmed and finished records beyond the newest
/// `confirmedTransactionLimit` are dropped, oldest first, but only once no kept checkout is bound to the transaction or
/// could be claimed by it, and its purchase is older than the clock tolerance (so no checkout saved later could be).
///
/// Every instance in the process serializes its reads and changes through one lock, so stores on the same defaults
/// and key (each `BillFnStoreKit` makes its own by default) never lose each other's changes or both bind one checkout.
public final class BillFnUserDefaultsCheckoutStore: BillFnStoreKitCheckoutStore, @unchecked Sendable {
    /// How many confirmed or finished transaction records the store keeps once none is still needed.
    public static let confirmedTransactionLimit = 256

    private let defaults: UserDefaults
    private let key: String
    private let now: @Sendable () -> Date
    /// Shared by every instance: a lock per instance would let two stores on the same storage interleave their
    /// read-modify-write cycles, and `UserDefaults` does not say which instances share storage.
    private static let lock = NSLock()
    private var lock: NSLock { Self.lock }

    public init(
        defaults: UserDefaults = .standard,
        key: String = "billfn.storekit.checkouts",
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.key = key
        self.now = now
    }

    public func keptCheckouts() -> [BillFnStoreKitKeptCheckout] {
        lock.withLock { load() }
    }

    public func save(_ checkout: BillFnStoreKitCheckout) {
        update { kept, _ in
            kept.removeAll { $0.checkout.checkoutSessionId == checkout.checkoutSessionId }
            kept.append(BillFnStoreKitKeptCheckout(checkout: checkout, savedAt: now()))
        }
    }

    public func claim(_ transaction: BillFnStoreKitTransactionFacts, purchasedWith purchaseCheckout: BillFnStoreKitCheckout?) -> BillFnStoreKitCheckout? {
        let id = transaction.transactionId
        var claimed: BillFnStoreKitCheckout?
        update { kept, records in
            if let purchaseCheckout {
                let index = kept.firstIndex { $0.checkout.checkoutSessionId == purchaseCheckout.checkoutSessionId }
                if index == nil || kept[index!].transactionId == nil || kept[index!].transactionId == id {
                    kept = kept.map { $0.transactionId == id ? $0.bound(to: nil) : $0 }
                    if let index {
                        kept[index] = kept[index].bound(to: id)
                    } else {
                        kept.append(BillFnStoreKitKeptCheckout(checkout: purchaseCheckout, savedAt: now(), transactionId: id))
                    }
                    claimed = purchaseCheckout
                    return
                }
            }
            if let bound = kept.first(where: { $0.transactionId == id }) {
                claimed = bound.checkout
                return
            }
            guard (records.first { $0.facts.transactionId == id }?.state ?? .pending) < .confirmed,
                  let index = kept.firstIndex(where: transaction.mayClaim) else { return }
            kept[index] = kept[index].bound(to: id)
            claimed = kept[index].checkout
        }
        return claimed
    }

    public func removeOutstandingCheckout(checkoutSessionId: String) {
        update { kept, _ in
            kept.removeAll { $0.checkout.checkoutSessionId == checkoutSessionId && $0.transactionId == nil }
        }
    }

    public func removeCheckout(boundTo transactionId: String) {
        update { kept, _ in
            kept.removeAll { $0.transactionId == transactionId }
        }
    }

    public func record(_ transaction: BillFnStoreKitTransactionFacts, state: BillFnStoreKitConfirmationState) {
        update { kept, records in
            let previous = records.first { $0.facts.transactionId == transaction.transactionId }?.state
            records.removeAll { $0.facts.transactionId == transaction.transactionId }
            records.append(BillFnStoreKitTransactionRecord(facts: transaction, state: max(previous ?? state, state)))
            prune(&records, keeping: kept)
        }
    }

    public func record(transactionId: String) -> BillFnStoreKitTransactionRecord? {
        lock.withLock { loadRecords().first { $0.facts.transactionId == transactionId } }
    }

    public func removeUnneededCheckouts() {
        update { kept, records in
            let finished = Set(records.filter { $0.state == .finished }.map(\.facts.transactionId))
            kept.removeAll { $0.transactionId.map(finished.contains) ?? false }
            prune(&records, keeping: kept)
        }
    }

    /// Drops the oldest confirmed and finished records beyond the limit that nothing needs any more.
    private func prune(_ records: inout [BillFnStoreKitTransactionRecord], keeping kept: [BillFnStoreKitKeptCheckout]) {
        var excess = records.filter { $0.state >= .confirmed }.count - Self.confirmedTransactionLimit
        guard excess > 0 else { return }
        let recent = now().addingTimeInterval(-BillFnStoreKitTransactionFacts.checkoutClockTolerance)
        records.removeAll { record in
            guard excess > 0, record.state >= .confirmed, record.facts.purchaseDate < recent,
                  !kept.contains(where: { $0.transactionId == record.facts.transactionId || record.facts.mayClaim($0) })
            else { return false }
            excess -= 1
            return true
        }
    }

    private var recordsKey: String { "\(key).transactions" }

    private func update(_ change: (inout [BillFnStoreKitKeptCheckout], inout [BillFnStoreKitTransactionRecord]) -> Void) {
        lock.withLock {
            var kept = load()
            var records = loadRecords()
            change(&kept, &records)
            defaults.set(try? JSONEncoder().encode(kept), forKey: key)
            defaults.set(try? JSONEncoder().encode(records), forKey: recordsKey)
        }
    }

    private func load() -> [BillFnStoreKitKeptCheckout] {
        guard let data = defaults.data(forKey: key),
              let kept = try? JSONDecoder().decode([BillFnStoreKitKeptCheckout].self, from: data) else { return [] }
        return kept
    }

    private func loadRecords() -> [BillFnStoreKitTransactionRecord] {
        guard let data = defaults.data(forKey: recordsKey),
              let records = try? JSONDecoder().decode([BillFnStoreKitTransactionRecord].self, from: data) else { return [] }
        return records
    }
}
