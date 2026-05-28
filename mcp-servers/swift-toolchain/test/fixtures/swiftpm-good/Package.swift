// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SwiftPMGood",
    products: [
        .library(name: "SwiftPMGood", targets: ["SwiftPMGood"]),
    ],
    targets: [
        .target(name: "SwiftPMGood"),
        .testTarget(name: "SwiftPMGoodTests", dependencies: ["SwiftPMGood"]),
    ]
)
