// swift-tools-version: 6.2

import PackageDescription

// The widget's own arithmetic, apart from the app so it can be tested. `xtool` has
// no test command and an app target cannot be run here, but this package is
// Foundation only and the machine it is built on can run `swift test` over it
// directly:
//
//     cd ios/GenUi && swift test
//
// It is the browser's `web/src/chat/genui/evaluate.ts` in Swift, held to the same
// cases on disk (`test/fixtures/genui-evaluate.json`) so the two surfaces cannot
// quietly compute different numbers from one widget.
let package = Package(
    name: "GenUi",
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MiloGenUi", targets: ["MiloGenUi"]),
    ],
    targets: [
        .target(name: "MiloGenUi"),
        .testTarget(name: "MiloGenUiTests", dependencies: ["MiloGenUi"]),
    ]
)
