/// Fireweave SDK for Swift (spec v0.1.0).
///
/// Exactly two v1 capabilities (`spec/control-points.md` "Scope of v1"):
/// control points and target registration. Dependency budget: Foundation
/// only (`URLSession` for HTTP, `JSONSerialization`/`Codable` for JSON) —
/// `Package.swift`'s `dependencies:` array is empty.
///
/// ## The synchronous read surface
///
/// `controlPoints`'s nine methods are SYNCHRONOUS — a pure, lock-guarded
/// cache read (`Application/Runtime.swift`). `prefetch`/`initialize` are
/// `async` and populate that cache. This is the Phase 6 controller ruling
/// ("web's shape, not node's": a UI thread cannot `await` inside a render
/// path) — studied via `sdks/web`'s `ADR-0009` seam, built from
/// `spec/control-points.md` + `spec/modes.md` directly.
///
/// Quick start (local mode, offline):
///
/// ```swift
/// import Fireweave
///
/// let client = try await initFireweave(.local(InitFireweaveLocalOptions(
///     controlPoints: ["my-flag": true]
/// )))
/// client.controlPoints.getBooleanValue("my-flag", default: false)  // true, synchronously
/// await client.shutdown()
/// ```
///
/// There are no hidden global clients: everything is constructed explicitly
/// and injectable for tests.

/// Frozen SDK spec version this package implements (`spec/version.json`).
public let specVersion = "0.1.0"
