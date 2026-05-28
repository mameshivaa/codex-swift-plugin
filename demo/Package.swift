// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PhotoShareApp",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "PhotoShareApp", targets: ["PhotoShareApp"]),
    ],
    targets: [
        .target(
            name: "PhotoShareApp",
            resources: [.process("Resources")]
        ),
    ]
)
