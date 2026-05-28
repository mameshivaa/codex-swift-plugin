// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SwiftPMNoTests",
    products: [
        .library(name: "SwiftPMNoTests", targets: ["SwiftPMNoTests"]),
    ],
    targets: [
        .target(name: "SwiftPMNoTests"),
    ]
)
