// swift-tools-version: 6.2

import PackageDescription

// The colouring of code, apart from the app so it can be tested. `xtool` has no test
// command and an app target cannot be run here, but this package is Foundation only and
// the machine it is built on can run `swift test` over it directly:
//
//     cd ios/Highlight && swift test
//
// It is the core's `src/core/highlight.ts` in Swift, held to the same cases on disk
// (`test/fixtures/highlight.json`) so the phone and the browser cannot quietly colour the
// same code two different ways.
let package = Package(
    name: "Highlight",
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MiloHighlight", targets: ["MiloHighlight"]),
    ],
    targets: [
        .target(name: "MiloHighlight"),
        .testTarget(name: "MiloHighlightTests", dependencies: ["MiloHighlight"]),
    ]
)
