import SwiftUI

/// Hosts the StoreKit tests: StoreKit testing needs an app bundle, which `swift test` does not provide.
@main
struct BillFnStoreKitTestHostApp: App {
    var body: some Scene {
        WindowGroup("BillFn StoreKit Test Host") {
            Text("BillFn StoreKit test host")
                .padding()
                // StoreKit testing delivered no Transaction.updates to an inactive host in local runs.
                .onAppear { NSApplication.shared.activate(ignoringOtherApps: true) }
        }
    }
}
