import BillFnClient
import BillFnStoreKit
import Foundation

let client = BillFnClient(
    configuration: BillFnClientConfiguration(
        baseURL: URL(string: "https://billfn.example.test/billfn/")!
    )
)
let storeKit = BillFnStoreKit(client: client, plans: [
    BillFnStoreKitPlan(productId: "apple.pro.month", planKey: "pro"),
])

// At launch: listen to Transaction.updates and confirm what earlier launches left unfinished.
await storeKit.start()

let result = try await storeKit.purchase(planKey: "pro")
print("Purchase:", result)

let manageAction = BillFnStoreKit.makeManageSubscriptionAction()
print("Open Apple-managed subscriptions at:", manageAction.url ?? "")
