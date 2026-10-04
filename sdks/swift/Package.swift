// swift-tools-version: 6.0
import PackageDescription

// Dependency budget (Phase 6 controller ruling): LITERALLY ZERO external
// package dependencies. Foundation supplies both the HTTP client
// (URLSession) and the JSON parser (JSONSerialization / Codable) — no
// swift-server, no Alamofire, no SwiftyJSON. Foundation itself is part of
// the Swift toolchain, not an SPM package dependency, exactly like Rust's
// `std`/Go's stdlib are not entries in `[dependencies]`/`go.mod`.
//
// `dependencies: []` below is asserted by
// Tests/FireweaveTests/ArchitectureGuardTests.swift
// (`packageManifestDeclaresZeroDependencies`), which parses this very file's
// text rather than trusting a comment.
let package = Package(
    name: "Fireweave",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "Fireweave", targets: ["Fireweave"]),
        // The start profile (docs/adr/0012-start-profile.md): one
        // `startFireweave()` call plus the process-wide `fw` accessor,
        // layered over the unchanged `Fireweave` core, which it re-exports.
        .library(name: "FireweaveStart", targets: ["FireweaveStart"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Fireweave",
            dependencies: []
        ),
        // Depends on the core target only. It is the only target that reads
        // the process environment, Info.plist, UserDefaults or the host name
        // (Tests/FireweaveStartTests/StartGuardTests.swift pins that).
        // FIREWEAVE_START_DEBUG is this target's own debug flag: the app
        // profile treats a debug build with no key and no environment name
        // as development, and a release build fails closed instead.
        .target(
            name: "FireweaveStart",
            dependencies: ["Fireweave"],
            swiftSettings: [
                .define("FIREWEAVE_START_DEBUG", .when(configuration: .debug)),
            ]
        ),
        // Fixture conformance runner (contracts/harness.md) ships as an
        // executable target in the same package so it can use the library's
        // public API directly (InMemoryAdapter, FireweaveRuntime, ...) —
        // mirrors rust's `[[bin]] conformance` in the same crate. This is an
        // in-package TARGET dependency, not an external package dependency;
        // it does not count against the zero-dependency ruling above.
        .executableTarget(
            name: "FireweaveConformance",
            dependencies: ["Fireweave"]
        ),
        .testTarget(
            name: "FireweaveTests",
            dependencies: ["Fireweave"]
        ),
        .testTarget(
            name: "FireweaveStartTests",
            dependencies: ["FireweaveStart"]
        ),
    ]
)
