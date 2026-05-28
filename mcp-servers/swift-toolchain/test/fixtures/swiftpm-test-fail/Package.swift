// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SwiftPMTestFail",
    products: [
        .library(name: "SwiftPMTestFail", targets: ["SwiftPMTestFail"]),
    ],
    targets: [
        .target(name: "SwiftPMTestFail"),
        .testTarget(name: "SwiftPMTestFailTests", dependencies: ["SwiftPMTestFail"]),
    ]
)
