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
        guard let checkoutSessionId = session?["checkoutSessionId"]?.stringValue else {
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
    /// When the purchase attempt saved it; an outstanding checkout expires a retention period later (see
    /// `BillFnStoreKitCheckoutStore.removeUnneededCheckouts(excluding:listedPurchases:)`).
    public let savedAt: Date
    /// The transaction StoreKit produced for this checkout's attempt. It is recorded as soon as the transaction is
    /// matched to the checkout, before BillFn is asked to verify it, so a transaction BillFn has not confirmed yet
    /// (a failed verify call, an app that stopped before finishing it) still finds its checkout on a later launch.
    /// A checkout with a transaction does not expire: it is removed once that transaction is finished, and only on
    /// the record that `finish()` returned (`recordFinished(transactionId:)`), never because StoreKit left the
    /// transaction out of an enumeration.
    public let transactionId: String?
    /// When a reconciliation first found this outstanding checkout expired with no listed purchase that could claim
    /// it; nil while it is not expired or a listed purchase could claim it.
    public let unclaimedSince: Date?

    public init(checkout: BillFnStoreKitCheckout, savedAt: Date, transactionId: String? = nil, unclaimedSince: Date? = nil) {
        self.checkout = checkout
        self.savedAt = savedAt
        self.transactionId = transactionId
        self.unclaimedSince = unclaimedSince
    }

    func unclaimed(since date: Date?) -> BillFnStoreKitKeptCheckout {
        BillFnStoreKitKeptCheckout(checkout: checkout, savedAt: savedAt, transactionId: transactionId, unclaimedSince: date)
    }
}

/// Keeps each checkout a purchase started until its transaction is finished, so a purchase that completes later
/// (Ask to Buy, an interrupted app) is still verified against its checkout. Checkouts are kept by
/// `checkoutSessionId`: two attempts on one product are kept separately, and a cancelled or finished attempt
/// removes only its own checkout. A store never drops a checkout on its own: its reads return every kept checkout,
/// expired or not, and a checkout is removed on reconciliation only by `removeUnneededCheckouts(excluding:listedPurchases:)`,
/// which `BillFnStoreKit` calls after it has offered every unfinished transaction the checkouts it could claim.
public protocol BillFnStoreKitCheckoutStore: Sendable {
    /// Every kept checkout, oldest first, including outstanding ones past their retention.
    func keptCheckouts() -> [BillFnStoreKitKeptCheckout]
    /// Keeps the checkout of a purchase attempt that is starting.
    func save(_ checkout: BillFnStoreKitCheckout)
    /// Records that `transactionId` was matched to the checkout, before BillFn verifies it, keeping the checkout if
    /// it was not kept. The checkout then stays kept until it is removed, however long verifying takes.
    func markMatched(_ checkout: BillFnStoreKitCheckout, transactionId: String)
    func removeCheckout(checkoutSessionId: String)
    /// Reconciles the kept checkouts, except those in `checkoutSessionIds` (ones a transaction is being verified
    /// against), which stay as they are. It removes each checkout matched to a transaction recorded finished (the app
    /// stopped between finishing it and removing the checkout); one matched to a transaction not recorded finished
    /// stays however old it is. An outstanding checkout (no transaction matched to it) past the store's retention stays
    /// while `listedPurchases` (the purchase date of the newest transaction in `Transaction.all` that could claim it,
    /// by `checkoutSessionId`) has a purchase made within the retention, since StoreKit can leave that unfinished
    /// transaction out of `Transaction.unfinished`; an older purchase (one finished on another device) keeps it no
    /// longer. Otherwise it is removed only by a reconciliation at least `unclaimedGrace` after an earlier one also
    /// found it expired and unclaimed, so one launch whose StoreKit cache left a purchase out of both enumerations
    /// never removes the checkout that purchase needs.
    func removeUnneededCheckouts(excluding checkoutSessionIds: Set<String>, listedPurchases: [String: Date])
    /// Records that BillFn confirmed the transaction, so when StoreKit offers it again (a redelivered update, a
    /// restored entitlement) it never claims an outstanding checkout. A store keeps a bounded number of the newest ones.
    func recordConfirmed(transactionId: String)
    func isConfirmed(transactionId: String) -> Bool
    /// Records that the transaction was finished, once `finish()` has returned. A store keeps a bounded number of the
    /// newest ones.
    func recordFinished(transactionId: String)
    func isFinished(transactionId: String) -> Bool
}

extension BillFnStoreKitCheckoutStore {
    /// `removeUnneededCheckouts(excluding:listedPurchases:)` with no listed purchases.
    public func removeUnneededCheckouts(excluding checkoutSessionIds: Set<String>) {
        removeUnneededCheckouts(excluding: checkoutSessionIds, listedPurchases: [:])
    }

    /// The kept checkouts for the product, oldest first.
    public func checkouts(forProductId productId: String) -> [BillFnStoreKitCheckout] {
        keptCheckouts().filter { $0.checkout.productId == productId }.map(\.checkout)
    }
}

/// Keeps checkouts in `UserDefaults`. An outstanding checkout is kept for `retention` after its attempt started,
/// however many other attempts are saved or cancelled meanwhile: longer than the App Store keeps an Ask to Buy
/// request or an interrupted purchase waiting, so an attempt that has not produced a transaction by then never
/// will. Retention takes effect at the next `BillFnStoreKit.processUnfinishedTransactions()` (which `start()` runs):
/// until then an expired checkout is still read and claimable, so a transaction that completed while the app was not
/// running is matched to it first. After that it stays while a recent purchase in `Transaction.all` could claim it, and
/// otherwise until a reconciliation `unclaimedGrace` after the first that found it unclaimed. A checkout a transaction
/// has been matched to never expires: it is removed once the transaction is recorded finished.
///
/// Every instance in the process serializes its reads and changes through one lock, so stores on the same defaults
/// and key (each `BillFnStoreKit` makes its own by default) never lose each other's checkouts or confirmed ids.
public final class BillFnUserDefaultsCheckoutStore: BillFnStoreKitCheckoutStore, @unchecked Sendable {
    public static let defaultRetention: TimeInterval = 30 * 24 * 60 * 60
    /// How long after a reconciliation first finds an expired outstanding checkout unclaimed a later one may remove it.
    public static let unclaimedGrace: TimeInterval = 24 * 60 * 60
    /// How many confirmed transaction ids, and how many finished ones, the store keeps: far more than a billing account
    /// confirms while a checkout saved after one of them (the only kind it could claim, within the clock tolerance) is
    /// kept, or than launches stop between finishing a transaction and removing its checkout.
    public static let confirmedTransactionLimit = 256

    private let defaults: UserDefaults
    private let key: String
    private let retention: TimeInterval
    private let now: @Sendable () -> Date
    /// Shared by every instance: a lock per instance would let two stores on the same storage interleave their
    /// read-modify-write cycles, and `UserDefaults` does not say which instances share storage.
    private static let lock = NSLock()
    private var lock: NSLock { Self.lock }

    public init(
        defaults: UserDefaults = .standard,
        key: String = "billfn.storekit.checkouts",
        retention: TimeInterval = BillFnUserDefaultsCheckoutStore.defaultRetention,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.key = key
        self.retention = retention
        self.now = now
    }

    public func keptCheckouts() -> [BillFnStoreKitKeptCheckout] {
        lock.withLock { load() }
    }

    public func save(_ checkout: BillFnStoreKitCheckout) {
        update { kept in
            kept.removeAll { $0.checkout.checkoutSessionId == checkout.checkoutSessionId }
            kept.append(BillFnStoreKitKeptCheckout(checkout: checkout, savedAt: now()))
        }
    }

    public func markMatched(_ checkout: BillFnStoreKitCheckout, transactionId: String) {
        update { kept in
            let matched = { (savedAt: Date) in
                BillFnStoreKitKeptCheckout(checkout: checkout, savedAt: savedAt, transactionId: transactionId)
            }
            if let index = kept.firstIndex(where: { $0.checkout.checkoutSessionId == checkout.checkoutSessionId }) {
                kept[index] = matched(kept[index].savedAt)
            } else {
                kept.append(matched(now()))
            }
        }
    }

    public func removeCheckout(checkoutSessionId: String) {
        update { kept in
            kept.removeAll { $0.checkout.checkoutSessionId == checkoutSessionId }
        }
    }

    public func removeUnneededCheckouts(excluding checkoutSessionIds: Set<String>, listedPurchases: [String: Date]) {
        update { kept in
            let current = now()
            let expiry = current.addingTimeInterval(-retention)
            let finished = Set(loadIds(finishedKey))
            kept = kept.compactMap { entry in
                let id = entry.checkout.checkoutSessionId
                guard !checkoutSessionIds.contains(id) else { return entry }
                if let transactionId = entry.transactionId {
                    return finished.contains(transactionId) ? nil : entry
                }
                guard entry.savedAt <= expiry else { return entry }
                if let purchased = listedPurchases[id], purchased > expiry {
                    return entry.unclaimed(since: nil)
                }
                guard let since = entry.unclaimedSince else { return entry.unclaimed(since: current) }
                return current >= since.addingTimeInterval(Self.unclaimedGrace) ? nil : entry
            }
        }
    }

    public func recordConfirmed(transactionId: String) {
        record(transactionId, forKey: confirmedKey)
    }

    public func isConfirmed(transactionId: String) -> Bool {
        lock.withLock { loadIds(confirmedKey).contains(transactionId) }
    }

    public func recordFinished(transactionId: String) {
        record(transactionId, forKey: finishedKey)
    }

    public func isFinished(transactionId: String) -> Bool {
        lock.withLock { loadIds(finishedKey).contains(transactionId) }
    }

    private var confirmedKey: String { "\(key).confirmed" }
    private var finishedKey: String { "\(key).finished" }

    private func record(_ transactionId: String, forKey idsKey: String) {
        lock.withLock {
            var ids = loadIds(idsKey).filter { $0 != transactionId }
            ids.append(transactionId)
            defaults.set(Array(ids.suffix(Self.confirmedTransactionLimit)), forKey: idsKey)
        }
    }

    private func loadIds(_ idsKey: String) -> [String] {
        defaults.stringArray(forKey: idsKey) ?? []
    }

    private func update(_ change: (inout [BillFnStoreKitKeptCheckout]) -> Void) {
        lock.withLock {
            var kept = load()
            change(&kept)
            defaults.set(try? JSONEncoder().encode(kept), forKey: key)
        }
    }

    /// Every kept checkout. Reads never expire one: that is `removeUnneededCheckouts(excluding:)`'s job.
    private func load() -> [BillFnStoreKitKeptCheckout] {
        guard let data = defaults.data(forKey: key),
              let kept = try? JSONDecoder().decode([BillFnStoreKitKeptCheckout].self, from: data) else { return [] }
        return kept
    }
}
