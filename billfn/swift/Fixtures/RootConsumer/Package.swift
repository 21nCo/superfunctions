// swift-tools-version: 5.9
import PackageDescription

// A consumer of the repository root package, the way an app that adds super-functions
// (Xcode's remote package reference resolves the repository root) uses the BillFn products.
let package = Package(
    name: "BillFnRootConsumer",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "BillFnRootConsumer", targets: ["BillFnRootConsumer"]),
    ],
    dependencies: [
        .package(name: "SuperfunctionsSwift", path: "../../../.."),
    ],
    targets: [
        .target(
            name: "BillFnRootConsumer",
            dependencies: [
                .product(name: "BillFnClient", package: "SuperfunctionsSwift"),
                .product(name: "BillFnStoreKit", package: "SuperfunctionsSwift"),
                .product(name: "BillFnWebViewBridgeHost", package: "SuperfunctionsSwift"),
            ]
        ),
    ]
)
