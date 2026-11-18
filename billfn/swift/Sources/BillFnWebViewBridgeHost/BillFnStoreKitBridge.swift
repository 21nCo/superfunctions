import BillFnClient
import BillFnStoreKit
import Foundation

/// What the bridge's `storekit.*` methods call; `BillFnStoreKit` provides it.
public protocol BillFnStoreKitBridgeHandling: Sendable {
    func purchase(planKey: String, priceId: String?, interval: String?) async throws -> BillFnStoreKitPurchaseResult
    func restore(syncWithAppStore: Bool) async throws -> [BillFnStoreKitTransactionOutcome]
    func processUnfinishedTransactions() async -> [BillFnStoreKitTransactionOutcome]
}

extension BillFnStoreKit: BillFnStoreKitBridgeHandling {}

extension BillFnStoreKitTransactionReference {
    public var bridgeValue: BillFnBridgeValue {
        var value: [String: BillFnBridgeValue] = [
            "transactionId": .string(transactionId),
            "originalTransactionId": .string(originalTransactionId),
            "productId": .string(productId),
            "revoked": .bool(revoked),
        ]
        value["appAccountToken"] = appAccountToken.map { .string($0.uuidString.lowercased()) } ?? .null
        return .object(value)
    }
}

extension BillFnStoreKitFailure {
    public var bridgeValue: BillFnBridgeValue {
        .object(["code": .string(code), "message": .string(message), "retryable": .bool(retryable)])
    }
}

extension BillFnStoreKitTransactionOutcome {
    public var bridgeValue: BillFnBridgeValue {
        var value: [String: BillFnBridgeValue] = ["transaction": transaction.bridgeValue, "finished": .bool(finished)]
        switch status {
        case .confirmed(let billing):
            value["status"] = "confirmed"
            value["billing"] = billing
        case .failed(let failure):
            value["status"] = "failed"
            value["error"] = failure.bridgeValue
        case .skipped(let reason):
            value["status"] = "skipped"
            value["reason"] = .string(reason)
        }
        return .object(value)
    }
}

extension BillFnStoreKitPurchaseResult {
    public var bridgeResult: [String: BillFnBridgeValue] {
        switch self {
        case .purchased(let checkout, let outcome):
            return Self.result("purchased", checkout).merging(["outcome": outcome.bridgeValue]) { _, new in new }
        case .pending(let checkout):
            return Self.result("pending", checkout)
        case .cancelled(let checkout):
            return Self.result("cancelled", checkout)
        }
    }

    private static func result(_ status: String, _ checkout: BillFnStoreKitCheckout) -> [String: BillFnBridgeValue] {
        [
            "status": .string(status),
            "checkoutSessionId": .string(checkout.checkoutSessionId),
            "productId": .string(checkout.productId),
        ]
    }
}

extension BillFnBridgeDispatcher {
    /// The `transaction.updated` event for an outcome from `BillFnStoreKit.outcomes`.
    public func transactionEvent(_ outcome: BillFnStoreKitTransactionOutcome) -> BillFnBridgeEventEnvelope {
        BillFnBridgeEventEnvelope(event: "transaction.updated", payload: ["outcome": outcome.bridgeValue])
    }

    func respondStoreKit(_ request: BillFnBridgeRequestEnvelope, storeKit: any BillFnStoreKitBridgeHandling) async -> BillFnBridgeResponseEnvelope {
        let payload = request.payload ?? [:]
        do {
            switch request.method {
            case "storekit.checkout":
                guard case .string(let planKey)? = payload["planKey"], !planKey.isEmpty,
                      let priceId = optionalString(payload["priceId"]),
                      let interval = optionalString(payload["interval"]) else {
                    return invalid(request, "storekit.checkout requires a planKey string; priceId and interval are optional strings")
                }
                let result = try await storeKit.purchase(planKey: planKey, priceId: priceId, interval: interval)
                return .success(id: request.id, result: result.bridgeResult)
            case "storekit.restore":
                let sync: Bool
                switch payload["syncWithAppStore"] {
                case nil, .null?: sync = true
                case .bool(let value)?: sync = value
                default: return invalid(request, "storekit.restore syncWithAppStore must be a boolean")
                }
                let outcomes = try await storeKit.restore(syncWithAppStore: sync)
                return .success(id: request.id, result: ["transactions": .array(outcomes.map(\.bridgeValue))])
            default:
                let outcomes = await storeKit.processUnfinishedTransactions()
                return .success(id: request.id, result: ["transactions": .array(outcomes.map(\.bridgeValue))])
            }
        } catch {
            let failure = BillFnStoreKitFailure(error: error)
            return .failure(id: request.id, code: failure.code, message: failure.message, details: ["retryable": .bool(failure.retryable)])
        }
    }

    /// `nil` for a value that is neither absent, null nor a string; `.some(nil)` when absent.
    private func optionalString(_ value: BillFnBridgeValue?) -> String?? {
        switch value {
        case nil, .null?: return .some(nil)
        case .string(let string)?: return .some(string)
        default: return nil
        }
    }

    private func invalid(_ request: BillFnBridgeRequestEnvelope, _ message: String) -> BillFnBridgeResponseEnvelope {
        .failure(id: request.id, code: "BRIDGE_INVALID_REQUEST", message: message)
    }
}
