// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "SuperFunctionsNext",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "RecFnBotSDK",
            targets: ["RecFnBotSDK"]
        ),
        .library(
            name: "RecFnDesktopSDK",
            targets: ["RecFnDesktopSDK"]
        )
    ],
    targets: [
        .target(
            name: "RecFnWhisperCpp",
            path: "recfn/desktop/macos/Sources/RecFnWhisperCpp",
            publicHeadersPath: "include",
            cxxSettings: [
                .headerSearchPath("include")
            ],
            linkerSettings: [
                .linkedFramework("Foundation")
            ]
        ),
        .target(
            name: "RecFnDesktopSDK",
            dependencies: ["RecFnWhisperCpp"],
            path: "recfn/desktop/macos/Sources/RecFnDesktopSDK",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Foundation"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("UniformTypeIdentifiers")
            ]
        ),
        .target(
            name: "RecFnBotSDK",
            path: "recfn/bot/macos/Sources/RecFnBotSDK",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Foundation")
            ]
        )
    ]
)
