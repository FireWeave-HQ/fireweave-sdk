import Foundation
import Testing

/// Text guards for the start profile (docs/adr/0012-start-profile.md): the
/// core stays policy-free, every read of the process environment, Info.plist,
/// UserDefaults and the host name sits in one seam file, and `fw`'s reads are
/// exactly the core's nine. Comments are stripped before scanning, so prose
/// that names a symbol never trips a guard.
private func packageRoot() -> URL {
  URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // FireweaveStartTests/
    .deletingLastPathComponent()  // Tests/
    .deletingLastPathComponent()  // sdks/swift/
}

private func stripComments(_ source: String) -> String {
  source.split(separator: "\n", omittingEmptySubsequences: false)
    .map { line -> String in
      if let range = line.range(of: "//") {
        return String(line[line.startIndex..<range.lowerBound])
      }
      return String(line)
    }
    .joined(separator: "\n")
}

private struct SourceFile {
  var name: String
  var raw: String
  var code: String
}

private func sourceFiles(_ relativePath: String) -> [SourceFile] {
  let root = packageRoot().appendingPathComponent(relativePath)
  guard
    let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
  else {
    return []
  }
  var files: [SourceFile] = []
  for case let url as URL in enumerator where url.pathExtension == "swift" {
    let raw = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    files.append(SourceFile(name: url.lastPathComponent, raw: raw, code: stripComments(raw)))
  }
  return files
}

/// Files outside `allowed` whose code contains any of `tokens`.
private func offenders(
  in files: [SourceFile],
  tokens: [String],
  allowedIn allowed: Set<String>
) -> [String] {
  var found: [String] = []
  for file in files where !allowed.contains(file.name) {
    for token in tokens where file.code.contains(token) {
      found.append("\(file.name): \(token)")
    }
  }
  return found
}

private let environmentTokens = ["ProcessInfo", "Bundle.", "getenv", "setenv", "gethostname"]

@Suite("Start profile: guards")
struct StartGuardTests {
  @Test func environmentInfoPlistAndHostNameAreReadOnlyInTheSeam() {
    let files = sourceFiles("Sources/FireweaveStart")
    #expect(!files.isEmpty, "expected sources under Sources/FireweaveStart")
    let found = offenders(
      in: files,
      tokens: environmentTokens,
      allowedIn: ["StartEnvironment.swift"]
    )
    #expect(found.isEmpty, "read through StartEnvironment.swift only: \(found)")
  }

  @Test func userDefaultsIsTouchedOnlyInTheDeviceIdStore() {
    let files = sourceFiles("Sources/FireweaveStart")
    let found = offenders(in: files, tokens: ["UserDefaults"], allowedIn: ["DeviceIdStore.swift"])
    #expect(found.isEmpty, "touch UserDefaults through DeviceIdStore.swift only: \(found)")
  }

  /// The flip side: the seams really are where the reads happen, so the two
  /// guards above are not passing vacuously.
  @Test func theSeamFilesAreTheOnesThatRead() {
    let files = sourceFiles("Sources/FireweaveStart")
    let seam = files.first { $0.name == "StartEnvironment.swift" }?.code ?? ""
    #expect(seam.contains("ProcessInfo.processInfo.environment"))
    #expect(seam.contains("Bundle.main.object(forInfoDictionaryKey:"))
    #expect(seam.contains("gethostname("))
    let store = files.first { $0.name == "DeviceIdStore.swift" }?.code ?? ""
    #expect(store.contains("UserDefaults"))
  }

  @Test func theCoreReadsNoEnvironmentAndNeverImportsTheStartProfile() {
    let files = sourceFiles("Sources/Fireweave")
    #expect(!files.isEmpty, "expected sources under Sources/Fireweave")
    let tokens = environmentTokens + ["UserDefaults", "FireweaveStart"]
    let found = offenders(in: files, tokens: tokens, allowedIn: [])
    #expect(found.isEmpty, "the core stays policy-free (spec/modes.md): \(found)")
  }

  /// `initFireweave` stays the composition root; the only concrete adapter
  /// the start profile may name is the remote one, for the transport seam.
  @Test func concreteAdaptersAreNamedOnlyByTheClientFactory() {
    let files = sourceFiles("Sources/FireweaveStart")
    let remote = offenders(
      in: files,
      tokens: ["FireweaveRemoteAdapter", "RemoteAdapterConfig"],
      allowedIn: ["StartClient.swift"]
    )
    #expect(remote.isEmpty, "\(remote)")
    let others = offenders(
      in: files,
      tokens: ["FireweaveLocalAdapter", "InMemoryAdapter", "URLSessionTransport"],
      allowedIn: []
    )
    #expect(others.isEmpty, "\(others)")
    let factory = files.first { $0.name == "StartClient.swift" }?.code ?? ""
    #expect(factory.contains("initFireweave(.local("))
    #expect(factory.contains("initFireweave(.remote("))
  }

  /// Identity ordering uses a lock-chained task tail: actors are re-entrant
  /// across `await` (SE-0306), which would let identify and reset interleave.
  @Test func noActorOrdersIdentity() {
    let files = sourceFiles("Sources/FireweaveStart")
    let found = files.filter { file in
      file.code.split(separator: "\n").contains { line in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("actor ") || trimmed.contains(" actor ")
      }
    }
    #expect(found.isEmpty, "\(found.map(\.name))")
  }

  @Test func fwExposesExactlyTheNineCoreReads() throws {
    let path = packageRoot()
      .deletingLastPathComponent()  // sdks/
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance/surface/control-points.surface.json")
    let data = try Data(contentsOf: path)
    let descriptor = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let methods = descriptor?["methods"] as? [[String: Any]] ?? []
    let expected = Set(methods.compactMap { $0["name"] as? String })
    #expect(expected.count == 9)

    let files = sourceFiles("Sources/FireweaveStart")
    let code = files.first { $0.name == "FireweaveControlPoints.swift" }?.code ?? ""
    let declared = code.split(separator: "\n").compactMap { line -> String? in
      guard let range = line.range(of: "public func ") else { return nil }
      return line[range.upperBound...].split(separator: "(").first.map(String.init)
    }
    #expect(Set(declared) == expected)
    #expect(declared.count == 9)
  }

  @Test func cutNamespacesAreAbsent() {
    let files = sourceFiles("Sources/FireweaveStart")
    let patterns = [
      "func releases(", "func exposures(", "func signals(", "func capabilities(",
      "func guardrails(", "class FireweaveProvider", "struct FireweaveProvider",
      "protocol OpenFeature",
    ]
    let found = offenders(in: files, tokens: patterns, allowedIn: [])
    #expect(found.isEmpty, "v1 scope (spec/control-points.md): \(found)")
  }

  /// No analytics-vendor key prefix is written anywhere in the start
  /// profile, comments included: the key-family check matches a pattern.
  @Test func noVendorKeyPrefixIsWritten() {
    let prefixes = ["c", "s", "x"].map { "ph" + $0 + "_" }
    var found: [String] = []
    for file in sourceFiles("Sources/FireweaveStart") {
      for prefix in prefixes where file.raw.contains(prefix) {
        found.append("\(file.name): \(prefix)")
      }
    }
    #expect(found.isEmpty, "\(found)")
  }

  @Test func thePackageDeclaresTheStartProductOnTheCoreAlone() throws {
    let manifest = try String(
      contentsOf: packageRoot().appendingPathComponent("Package.swift"),
      encoding: .utf8
    )
    let product = #".library(name: "FireweaveStart", targets: ["FireweaveStart"])"#
    #expect(manifest.contains(product))
    let target = "name: \"FireweaveStart\",\n            dependencies: [\"Fireweave\"],"
    #expect(manifest.contains(target))
    #expect(manifest.contains(#".define("FIREWEAVE_START_DEBUG", .when(configuration: .debug))"#))
  }
}
