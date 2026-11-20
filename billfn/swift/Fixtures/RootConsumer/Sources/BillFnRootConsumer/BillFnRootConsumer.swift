import BillFnClient
import BillFnStoreKit
import BillFnWebViewBridgeHost
import Foundation

/// Wires the three BillFn products together the way an app does, so the fixture only builds
/// when the root package exposes all of them with their public API.
public func makeBillFnRootConsumer(baseURL: URL) -> (BillFnStoreKit, BillFnBridgeDispatcher) {
    let client = BillFnClient(configuration: BillFnClientConfiguration(baseURL: baseURL))
    let storeKit = BillFnStoreKit(client: client, plans: [
        BillFnStoreKitPlan(productId: "com.example.pro.month", planKey: "pro"),
    ])
    let dispatcher = BillFnBridgeDispatcher(
        configuration: BillFnBridgeConfiguration(baseURL: baseURL.absoluteString),
        storeKit: storeKit
    )
    return (storeKit, dispatcher)
}
