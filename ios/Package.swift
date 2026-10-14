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
        .library(
            name: "MiloLiveActivityWidget",
            targets: ["MiloLiveActivityWidget"]
        ),
    ],
    dependencies: [
        // The connection layer, in its own package so it can be run under
        // `swift test` on this machine — see `Connection/Package.swift`.
        .package(path: "Connection"),
        // The widget arithmetic, apart from the app for the same reason and held to
        // the browser's own cases — see `GenUi/Package.swift`.
        .package(path: "GenUi"),
    ],
    targets: [
        .target(
            name: "MiloActivity",
            path: "Activity/Sources/MiloActivity"
        ),
        .target(
            name: "MiloLiveActivityWidget",
            dependencies: ["MiloActivity"],
            path: "ActivityWidget/Sources/MiloLiveActivityWidget"
        ),
        .target(
            name: "Milo",
            dependencies: [
                "MiloActivity",
                .product(name: "MiloConnection", package: "Connection"),
                .product(name: "MiloGenUi", package: "GenUi"),
            ]
        ),
    ]
)
