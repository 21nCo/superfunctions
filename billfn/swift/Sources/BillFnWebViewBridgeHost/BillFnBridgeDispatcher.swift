import BillFnClient
import BillFnStoreKit
import Foundation

public struct BillFnBridgeConfiguration: Sendable, Equatable {
    public let baseURL: String
    public let authOwner: String
    public let capabilities: [String]

    public init(baseURL: String, authOwner: String = "native", capabilities: [String] = ["subscription.manage", "health.check"]) {
        self.baseURL = baseURL
        self.authOwner = authOwner
        self.capabilities = capabilities
    }
}

public final class BillFnBridgeDispatcher: @unchecked Sendable {
    private let configuration: BillFnBridgeConfiguration
    private let storeKit: (any BillFnStoreKitBridgeHandling)?

    /// With `storeKit`, the bridge also answers `storekit.checkout`, `storekit.restore` and `storekit.transactions`
    /// through `respond(to:)`.
    public init(configuration: BillFnBridgeConfiguration, storeKit: (any BillFnStoreKitBridgeHandling)? = nil) {
        self.configuration = configuration
        self.storeKit = storeKit
    }

    /// Answers every bridge method, including the StoreKit ones that `handle(_:)` cannot answer synchronously.
    public func respond(to request: BillFnBridgeRequestEnvelope) async -> BillFnBridgeResponseEnvelope {
        guard request.protocolVersion == BILLFN_BRIDGE_PROTOCOL,
              BILLFN_BRIDGE_STOREKIT_METHODS.contains(request.method) else {
            return handle(request)
        }
        guard let storeKit else {
            return .failure(id: request.id, code: "BILLFN_CAPABILITY_UNAVAILABLE", message: "StoreKit purchases are not configured for this bridge")
        }
        return await respondStoreKit(request, storeKit: storeKit)
    }

    public func handle(_ request: BillFnBridgeRequestEnvelope) -> BillFnBridgeResponseEnvelope {
        guard request.protocolVersion == BILLFN_BRIDGE_PROTOCOL else {
            return .failure(id: request.id, code: "BRIDGE_PROTOCOL_MISMATCH", message: "Bridge protocol version mismatch")
        }

        guard BILLFN_BRIDGE_METHODS.contains(request.method) else {
            return .failure(id: request.id, code: "BRIDGE_METHOD_UNSUPPORTED", message: "Unsupported bridge method")
        }

        switch request.method {
        case "handshake":
            return .success(id: request.id, result: [
                "bridgeVersion": .integer(1),
                "billingOwner": .string("native"),
                "authOwner": .string(configuration.authOwner),
                "baseURL": .string(configuration.baseURL),
                "capabilities": .array(capabilities.map(BillFnBridgeValue.string))
            ])
        case "subscription.manage":
            return .success(id: request.id, result: [
                "type": .string("manage-subscription"),
                "url": .string(BillFnStoreKit.manageSubscriptionsURL().absoluteString)
            ])
        case "health.check":
            return .success(id: request.id, result: ["status": .string("ok")])
        case _ where BILLFN_BRIDGE_STOREKIT_METHODS.contains(request.method):
            return .failure(id: request.id, code: "BRIDGE_METHOD_UNSUPPORTED", message: "StoreKit methods are answered by respond(to:)")
        default:
            return .failure(id: request.id, code: "BRIDGE_METHOD_UNSUPPORTED", message: "Unsupported bridge method")
        }
    }

    private var capabilities: [String] {
        guard storeKit != nil else { return configuration.capabilities }
        return configuration.capabilities + BILLFN_BRIDGE_STOREKIT_METHODS.filter { !configuration.capabilities.contains($0) }
    }

    public func readyEvent() -> BillFnBridgeEventEnvelope {
        BillFnBridgeEventEnvelope(event: "bridge.ready", payload: ["baseURL": .string(configuration.baseURL)])
    }
}
