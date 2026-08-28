import Foundation
import Testing

@testable import Fireweave

/// Control-point SURFACE parity (`spec/control-points.md`,
/// `conformance/surface/`).
///
/// Behaviour is asserted elsewhere (`RuntimeTests`, `ClientTests`, ...);
/// this file asserts the surface EXISTS — a missing method is invisible
/// otherwise (go once shipped `client.Flags()` with no `ControlPoints`
/// namespace, unnoticed for months, because nothing structurally forced
/// seven independent implementations to agree).
private struct SurfaceMethod: Decodable {
  let name: String
  let args: [String]
  let localMode: String?

  enum CodingKeys: String, CodingKey {
    case name, args
    case localMode = "localMode"
  }
}

private struct Namespace: Decodable {
  let casing: [String: String]
  let deprecatedAlias: String
  let aliasMustShareIdentity: Bool
}

private struct ClientSection: Decodable {
  let methods: [SurfaceMethod]
  let mustNotExpose: [String]
}

private struct SurfaceDescriptor: Decodable {
  let namespace: Namespace
  let methods: [SurfaceMethod]
  let client: ClientSection
  let compatibility: [String: String]
}

private func loadDescriptor() throws -> SurfaceDescriptor {
  let path = ArchitectureGuardTests.packageRoot()
    .deletingLastPathComponent()  // sdks/
    .deletingLastPathComponent()  // repo root
    .appendingPathComponent("conformance/surface/control-points.surface.json")
  let data = try Data(contentsOf: path)
  return try JSONDecoder().decode(SurfaceDescriptor.self, from: data)
}

private func testClient() -> FireweaveClient {
  FireweaveClient(runtime: FireweaveRuntime(adapter: InMemoryAdapter()))
}

@Suite("Surface conformance (conformance/surface/control-points.surface.json)")
struct SurfaceConformanceTests {
  @Test func namespaceCasingIsControlPointsPerDescriptor() throws {
    let d = try loadDescriptor()
    #expect(d.namespace.casing["swift"] == "controlPoints")
    // The namespace exists under that exact accessor name.
    let _: ControlPointsNamespace = testClient().controlPoints
  }

  @Test func nineMethodsMatchDescriptorArity() throws {
    let d = try loadDescriptor()
    #expect(d.methods.count == 9, "expected exactly nine methods in the surface descriptor")

    let expectedArities: [String: Int] = [
      "getBooleanValue": 3, "getStringValue": 3, "getNumberValue": 3, "getObjectValue": 3,
      "getBooleanDetails": 3, "getStringDetails": 3, "getNumberDetails": 3, "getObjectDetails": 3,
      "evaluate": 5,
    ]

    var offenders: [String] = []
    for m in d.methods {
      guard let expected = expectedArities[m.name] else {
        offenders.append("\(m.name): not one of the recognized nine method names")
        continue
      }
      if m.args.count != expected {
        offenders.append(
          "\(m.name): descriptor declares \(m.args.count) args, hardcoded expectation is \(expected)"
        )
      }
    }
    #expect(offenders.isEmpty, "arity mismatches: \(offenders)")
  }

  /// The compile-time half of the arity proof — mirrors rust's identical
  /// reasoning (task-12-report.md finding 4): Swift also has no runtime
  /// method-arity reflection API, so a signature drift here fails the
  /// whole file (and therefore `swift test`) to BUILD, a strictly
  /// stronger guarantee than a runtime assertion.
  @Test func nineMethodsAreCallableAtThePinnedArity() async {
    let fw = testClient()
    await fw.initialize()
    let cp = fw.controlPoints
    let ctx = EvaluationContext(targetingKey: "t")

    let _: Bool = cp.getBooleanValue("k", default: false, context: ctx)
    let _: String = cp.getStringValue("k", default: "d", context: ctx)
    let _: Double = cp.getNumberValue("k", default: 0.0, context: ctx)
    let _: JSONValue = cp.getObjectValue("k", default: .null, context: ctx)
    let _: Decision = cp.getBooleanDetails("k", default: false, context: ctx)
    let _: Decision = cp.getStringDetails("k", default: "d", context: ctx)
    let _: Decision = cp.getNumberDetails("k", default: 0.0, context: ctx)
    let _: Decision = cp.getObjectDetails("k", default: .null, context: ctx)
    let _: Decision = cp.evaluate(
      "k", type: .boolean, default: .bool(false), context: ctx, options: EvaluateOptions())
  }

  @Test func theDeprecatedFlagsAliasSharesIdentityWithControlPoints() throws {
    let d = try loadDescriptor()
    #expect(d.namespace.deprecatedAlias == "flags")
    #expect(d.namespace.aliasMustShareIdentity)

    let fw = testClient()
    #expect(fw.flags === fw.controlPoints)
  }

  @Test func registerTargetExistsWithLocalModeRecordedAndTraced() async throws {
    let d = try loadDescriptor()
    let entry = try #require(d.client.methods.first { $0.name == "registerTarget" })
    #expect(entry.localMode == "recorded-and-traced")

    let fw = try await initFireweave(.local(InitFireweaveLocalOptions()))
    let result = await fw.registerTarget("user_1")
    #expect(result.ok)
  }

  @Test func mustNotExposeListMatchesTheFixedV1ScopeBoundary() throws {
    let d = try loadDescriptor()
    #expect(
      d.client.mustNotExpose == [
        "releases", "exposures", "signals", "capabilities", "guardrails",
        "FireweaveProvider", "FireweaveWebProvider",
      ]
    )
  }

  @Test func mustNotExposeCutNamespacesAndProviderTypesAreAbsentFromSource() throws {
    let root = ArchitectureGuardTests.packageRoot().appendingPathComponent("Sources/Fireweave")
    var haystack = ""
    for file in ArchitectureGuardTests.swiftFiles(under: root) {
      haystack += (try? String(contentsOf: file, encoding: .utf8)) ?? ""
      haystack += "\n"
    }

    let forbiddenPatterns = [
      "func releases(", "func exposures(", "func signals(", "func capabilities(",
      "func guardrails(",
      "struct Releases", "struct Exposures", "struct Signals", "struct Capabilities",
      "struct Guardrails",
      "struct FireweaveProvider", "struct FireweaveWebProvider", "class FireweaveProvider",
      "class FireweaveWebProvider", "protocol OpenFeature",
    ]
    let offenders = forbiddenPatterns.filter { haystack.contains($0) }
    #expect(offenders.isEmpty, "v1 scope violation — found item-definition shapes: \(offenders)")
  }

  @Test func compatibilityCellIsGreenForSwift() throws {
    let d = try loadDescriptor()
    #expect(d.compatibility["swift"] == "green", #"compatibility.swift must be "green""#)
  }
}
