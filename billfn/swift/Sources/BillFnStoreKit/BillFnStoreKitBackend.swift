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
    /// When the purchase attempt saved it; an outstanding checkout expires a retention period later.
    public let savedAt: Date
    /// The transaction StoreKit produced for this checkout's attempt. It is recorded as soon as the transaction is
    /// matched to the checkout, before BillFn is asked to verify it, so a transaction BillFn has not confirmed yet
    /// (a failed verify call, an app that stopped before finishing it) still finds its checkout on a later launch.
    /// A checkout with a transaction does not expire: it is removed once that transaction is finished.
    public let transactionId: String?

    public init(checkout: BillFnStoreKitCheckout, savedAt: Date, transactionId: String? = nil) {
        self.checkout = checkout
        self.savedAt = savedAt
        self.transactionId = transactionId
    }
}

/// Keeps each checkout a purchase started until its transaction is finished, so a purchase that completes later
/// (Ask to Buy, an interrupted app) is still verified against its checkout. Checkouts are kept by
/// `checkoutSessionId`: two attempts on one product are kept separately, and a cancelled or finished attempt
/// removes only its own checkout. A store drops an outstanding checkout (one with no transaction yet) only once its
/// attempt can no longer produce a transaction, never to make room for another, and never drops a checkout a
/// transaction has been matched to.
public protocol BillFnStoreKitCheckoutStore: Sendable {
    /// Every kept checkout, oldest first.
    func keptCheckouts() -> [BillFnStoreKitKeptCheckout]
    /// Keeps the checkout of a purchase attempt that is starting.
    func save(_ checkout: BillFnStoreKitCheckout)
    /// Records that `transactionId` was matched to the checkout, before BillFn verifies it, keeping the checkout if
    /// it was not kept. The checkout then stays kept until it is removed, however long verifying takes.
    func markMatched(_ checkout: BillFnStoreKitCheckout, transactionId: String)
    func removeCheckout(checkoutSessionId: String)
}

extension BillFnStoreKitCheckoutStore {
    /// The kept checkouts for the product, oldest first.
    public func checkouts(forProductId productId: String) -> [BillFnStoreKitCheckout] {
        keptCheckouts().filter { $0.checkout.productId == productId }.map(\.checkout)
    }
}

/// Keeps checkouts in `UserDefaults`. An outstanding checkout is kept for `retention` after its attempt started,
/// however many other attempts are saved or cancelled meanwhile: longer than the App Store keeps an Ask to Buy
/// request or an interrupted purchase waiting, so an attempt that has not produced a transaction by then never
/// will. A transaction that still arrives later is restored onto the plan its product maps to, if any. A checkout a
/// transaction has been matched to never expires.
public final class BillFnUserDefaultsCheckoutStore: BillFnStoreKitCheckoutStore, @unchecked Sendable {
    public static let defaultRetention: TimeInterval = 30 * 24 * 60 * 60

    private let defaults: UserDefaults
    private let key: String
    private let retention: TimeInterval
    private let now: @Sendable () -> Date
    private let lock = NSLock()

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

    private func update(_ change: (inout [BillFnStoreKitKeptCheckout]) -> Void) {
        lock.withLock {
            var kept = load()
            change(&kept)
            defaults.set(try? JSONEncoder().encode(kept), forKey: key)
        }
    }

    /// The kept checkouts without the outstanding ones past their retention; one matched to a transaction stays.
    private func load() -> [BillFnStoreKitKeptCheckout] {
        guard let data = defaults.data(forKey: key),
              let kept = try? JSONDecoder().decode([BillFnStoreKitKeptCheckout].self, from: data) else { return [] }
        let expiry = now().addingTimeInterval(-retention)
        return kept.filter { $0.transactionId != nil || $0.savedAt > expiry }
    }
}
