import Foundation
import Testing

/// Architecture guard (`spec/control-points.md` + `spec/modes.md`, "same
/// layering" as the other reference SDKs):
///
/// - the SDK's dependency budget stays LITERALLY ZERO (`Package.swift`'s
///   `dependencies: []`) — the controller ruling for this task, stricter
///   than rust's "exactly ureq+serde+serde_json" budget;
/// - `Sources/Fireweave/Domain/` stays pure — no reference to a concrete
///   `Application`/`Infrastructure` type;
/// - `Sources/Fireweave/Application/` does not reference a concrete
///   `Infrastructure` type except through the one sanctioned seam,
///   `InitFireweave.swift` (the composition root).
///
/// **Spec-ambiguity finding (swift-specific — not a rust recurrence).**
/// Rust's equivalent guard (`tests/architecture_guard.rs`) scans real `use`
/// STATEMENTS. Swift has no per-file import mechanism between files in the
/// SAME target/module — every file in `Sources/Fireweave` can reference
/// every other file's `public`/`internal` symbols with ZERO import
/// statement, so there is no textual "import" marker to scan for at all
/// (unlike Rust, where a `crate::infrastructure::...` reference at least
/// COULD be preceded by a `use` line, even if inline-qualified references
/// can dodge that specific scan). This guard instead scans for the
/// CONCRETE TYPE NAMES that would constitute a layering violation
/// (`FireweaveLocalAdapter`, `FireweaveRemoteAdapter`,
/// `URLSessionTransport`, `RemoteAdapterConfig`, `InMemoryAdapter`) appearing
/// as real references — outside doc comments — in `Domain/` or
/// `Application/` (excluding the sanctioned composition root). This is a
/// genuinely different mechanism than rust's, not a weaker version of it:
/// splitting into separate SwiftPM targets (`FireweaveDomain`/
/// `FireweaveApplication`/`FireweaveInfrastructure`) would restore a
/// compiler-enforced boundary via real `import` statements, but was not
/// chosen here — `Package.swift`'s single `Fireweave` target with
/// `Domain/`/`Application`/`Infrastructure` SUBDIRECTORIES was, per this
/// task's brief ("targets or directories"), to keep `Package.swift` and
/// cross-layer access control (no target-boundary `public`/`internal`
/// friction) simple for a v1 cut with three layers this small.
struct ArchitectureGuardTests {
  static func packageRoot() -> URL {
    // This file lives at .../sdks/swift/Tests/FireweaveTests/ArchitectureGuardTests.swift
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // FireweaveTests/
      .deletingLastPathComponent()  // Tests/
      .deletingLastPathComponent()  // sdks/swift/
  }

  static func swiftFiles(under directory: URL) -> [URL] {
    guard
      let enumerator = FileManager.default.enumerator(
        at: directory, includingPropertiesForKeys: nil)
    else {
      return []
    }
    var files: [URL] = []
    for case let url as URL in enumerator where url.pathExtension == "swift" {
      files.append(url)
    }
    return files
  }

  /// Strips `///`/`//` doc/line comments so a prose mention (this very
  /// file's doc comment, or `Runtime.swift`'s cross-references) never
  /// false-positives the scan — mirrors rust's own care to scan real
  /// references, not text that merely mentions a name in prose.
  static func stripComments(_ source: String) -> String {
    source.split(separator: "\n", omittingEmptySubsequences: false)
      .map { line -> String in
        if let range = line.range(of: "//") {
          return String(line[line.startIndex..<range.lowerBound])
        }
        return String(line)
      }
      .joined(separator: "\n")
  }
}

@Suite("Architecture guard")
struct ArchitectureGuardSuite {
  @Test func packageManifestDeclaresZeroDependencies() throws {
    let manifestPath = ArchitectureGuardTests.packageRoot().appendingPathComponent("Package.swift")
    let contents = try String(contentsOf: manifestPath, encoding: .utf8)
    // The TOP-LEVEL `dependencies:` argument to `Package(...)` — the one
    // that names EXTERNAL package dependencies — must be `[]`. Per-target
    // `dependencies:` arrays (`.target(dependencies: ["Fireweave"])` for
    // the conformance/test targets) are in-package target references,
    // not external dependencies (see Package.swift's own doc comment),
    // and are deliberately excluded here by matching the exact 4-space
    // indentation the top-level argument sits at (target-level entries
    // are nested deeper, at 12 spaces) rather than a blanket trimmed
    // prefix match, which would otherwise match all four.
    let lines = contents.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    let topLevelDependencyLines = lines.filter { $0.hasPrefix("    dependencies:") }
    #expect(
      topLevelDependencyLines.count == 1,
      "expected exactly one top-level `dependencies:` line in Package.swift"
    )
    #expect(
      topLevelDependencyLines.first?.trimmingCharacters(in: .whitespaces) == "dependencies: [],",
      "Package.swift's top-level dependencies: must be the literal empty array [] (Phase 6 controller ruling)"
    )
  }

  private static let infrastructureConcreteTypeNames = [
    "FireweaveLocalAdapter", "FireweaveRemoteAdapter", "InMemoryAdapter", "URLSessionTransport",
    "RemoteAdapterConfig", "RemoteHTTPTransport",
  ]

  @Test func domainReferencesNoApplicationOrInfrastructureConcreteType() throws {
    let root = ArchitectureGuardTests.packageRoot().appendingPathComponent(
      "Sources/Fireweave/Domain")
    let files = ArchitectureGuardTests.swiftFiles(under: root)
    #expect(!files.isEmpty, "expected source files under Sources/Fireweave/Domain")

    var offenders: [String] = []
    let forbidden =
      Self.infrastructureConcreteTypeNames + [
        "FireweaveRuntime", "FireweaveClient", "ControlPointsNamespace",
      ]
    for file in files {
      let contents = ArchitectureGuardTests.stripComments(
        try String(contentsOf: file, encoding: .utf8))
      for name in forbidden where contents.contains(name) {
        offenders.append("\(file.lastPathComponent): references \(name)")
      }
    }
    #expect(offenders.isEmpty, "domain/ must not depend on outer layers: \(offenders)")
  }

  /// `InitFireweave.swift` is the SANCTIONED composition root — its
  /// declared job is adapter selection, so its concrete `Infrastructure`
  /// references are expected and exempt wholesale (mirrors rust's
  /// `mode.rs` exemption).
  private static let applicationCompositionRoot = "InitFireweave.swift"

  @Test func applicationOutsideCompositionRootDoesNotReferenceInfrastructure() throws {
    let root = ArchitectureGuardTests.packageRoot().appendingPathComponent(
      "Sources/Fireweave/Application")
    let files = ArchitectureGuardTests.swiftFiles(under: root)
    #expect(!files.isEmpty, "expected source files under Sources/Fireweave/Application")

    var offenders: [String] = []
    for file in files where file.lastPathComponent != Self.applicationCompositionRoot {
      let contents = ArchitectureGuardTests.stripComments(
        try String(contentsOf: file, encoding: .utf8))
      for name in Self.infrastructureConcreteTypeNames where contents.contains(name) {
        offenders.append("\(file.lastPathComponent): references \(name)")
      }
    }
    #expect(
      offenders.isEmpty,
      "application/ (outside \(Self.applicationCompositionRoot)) must not reference infrastructure/: \(offenders)"
    )
  }

  /// The flip side: confirms the exemption is actually load-bearing (the
  /// composition root DOES reference infrastructure types), not a dead
  /// carve-out for a boundary nothing crosses.
  @Test func compositionRootIsTheOnlyApplicationFileReferencingInfrastructure() throws {
    let path = ArchitectureGuardTests.packageRoot()
      .appendingPathComponent("Sources/Fireweave/Application/\(Self.applicationCompositionRoot)")
    let contents = ArchitectureGuardTests.stripComments(
      try String(contentsOf: path, encoding: .utf8))
    let referencesInfra = Self.infrastructureConcreteTypeNames.contains { contents.contains($0) }
    #expect(
      referencesInfra,
      "\(Self.applicationCompositionRoot) is exempted as the composition root but references no infrastructure type — the exemption is stale"
    )
  }
}
