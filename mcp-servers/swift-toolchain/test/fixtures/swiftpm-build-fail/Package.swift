// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SwiftPMBuildFail",
    products: [
        .library(name: "SwiftPMBuildFail", targets: ["SwiftPMBuildFail"]),
    ],
    targets: [
        .target(name: "SwiftPMBuildFail"),
        .testTarget(name: "SwiftPMBuildFailTests", dependencies: ["SwiftPMBuildFail"]),
    ]
)
