import BillFnClient
import BillFnStoreKit
import BillFnWebViewBridgeHost
import Foundation

let storeKit = BillFnStoreKit(
    client: BillFnClient(configuration: BillFnClientConfiguration(baseURL: URL(string: "https://billfn.example.test/billfn")!)),
    plans: [BillFnStoreKitPlan(productId: "apple.pro.month", planKey: "pro")]
)
let dispatcher = BillFnBridgeDispatcher(
    configuration: BillFnBridgeConfiguration(
        baseURL: "https://billfn.example.test/billfn"
    ),
    storeKit: storeKit
)

let handshake = await dispatcher.respond(
    to: BillFnBridgeRequestEnvelope(
        id: "req_1",
        method: "handshake",
        payload: [
            "clientId": "embedded-web",
            "mode": "native-backed",
            "baseURL": "https://billfn.example.test/billfn"
        ]
    )
)
print("Bridge handshake:", handshake)

// The web view's checkout({ planKey: 'pro' }) arrives as this request.
let checkout = await dispatcher.respond(
    to: BillFnBridgeRequestEnvelope(id: "req_2", method: "storekit.checkout", payload: ["planKey": "pro"])
)
print("Checkout:", checkout)

// Forward each processed transaction to the web view as a transaction.updated event.
Task {
    for await outcome in storeKit.outcomes {
        print("Post to the web view:", dispatcher.transactionEvent(outcome))
    }
}
