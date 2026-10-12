// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Milo",
    // iOS 26 for Liquid Glass, which is the surface's whole chrome. The phone
    // this is built for runs newer than that.
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        // An xtool project should contain exactly one library product,
        // representing the main app.
        .library(
            name: "Milo",
            targets: ["Milo"]
        ),
    ],
    dependencies: [
        // The connection layer, in its own package so it can be run under
        // `swift test` on this machine — see `Connection/Package.swift`.
        .package(path: "Connection"),
    ],
    targets: [
        .target(
            name: "Milo",
            dependencies: [.product(name: "MiloConnection", package: "Connection")]
        ),
    ]
)
