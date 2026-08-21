// swift-tools-version: 6.0
import PackageDescription

// Dependency budget (Phase 6 controller ruling): LITERALLY ZERO external
// package dependencies. Foundation supplies both the HTTP client
// (URLSession) and the JSON parser (JSONSerialization / Codable) — no
// swift-server, no Alamofire, no SwiftyJSON. Foundation itself is part of
// the Swift toolchain, not an SPM package dependency, exactly like Rust's
// `std`/Go's stdlib are not entries in `[dependencies]`/`go.mod`.
//
// This manifest grows in later commits (executable conformance runner,
// test target) — see git history / task-13-report.md for the sequence.
let package = Package(
    name: "Fireweave",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "Fireweave", targets: ["Fireweave"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Fireweave",
            dependencies: []
        )
    ]
)
