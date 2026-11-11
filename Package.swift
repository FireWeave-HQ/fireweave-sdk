// swift-tools-version: 6.0
import PackageDescription

// The SwiftPM entry point for consumers:
//   .package(url: "https://github.com/FireWeave-HQ/fireweave-sdk", from: "X.Y.Z")
// SwiftPM reads only the manifest at a repository's root and only plain semver tags, so this file
// points the two library products at sdks/swift and every Swift release also pushes a plain
// `X.Y.Z` tag (release.yml `tag` job). The SDK's own manifest, with the conformance runner and the
// tests, stays at sdks/swift/Package.swift; keep the products, platforms and settings here in step
// with it. Both declare zero dependencies (sdks/swift ArchitectureGuardTests checks both files).
let package = Package(
    name: "Fireweave",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "Fireweave", targets: ["Fireweave"]),
        .library(name: "FireweaveStart", targets: ["FireweaveStart"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Fireweave",
            path: "sdks/swift/Sources/Fireweave"
        ),
        .target(
            name: "FireweaveStart",
            dependencies: ["Fireweave"],
            path: "sdks/swift/Sources/FireweaveStart",
            swiftSettings: [
                .define("FIREWEAVE_START_DEBUG", .when(configuration: .debug)),
            ]
        ),
    ]
)
