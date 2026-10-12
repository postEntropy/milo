// swift-tools-version: 6.2

import PackageDescription

// The connection layer, apart from the app so it can be tested. `xtool` has no test
// command and an app target cannot be run here, but this package is Foundation only
// and the machine it is built on can run `swift test` over it directly:
//
//     cd ios/Connection && swift test
//
let package = Package(
    name: "Connection",
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MiloConnection", targets: ["MiloConnection"]),
    ],
    targets: [
        .target(name: "MiloConnection"),
        .testTarget(name: "MiloConnectionTests", dependencies: ["MiloConnection"]),
    ]
)
