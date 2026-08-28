import Testing

@testable import Fireweave

@Suite("FireweaveClient")
struct ClientTests {
  private func client() -> FireweaveClient {
    FireweaveClient(runtime: FireweaveRuntime(adapter: InMemoryAdapter()))
  }

  @Test func flagsAliasSharesIdentityWithControlPoints() {
    let fw = client()
    #expect(fw.flags === fw.controlPoints)
  }

  @Test func invokeCapabilityDegradesUnsupported() async {
    let fw = client()
    await fw.initialize()
    let result = fw.invokeCapability("releases.teleport")
    #expect(!result.ok)
    #expect(result.degraded)
    #expect(result.errorKind == .unsupportedCapability)
  }

  @Test func nineMethodsAreCallableAtThePinnedArity() async {
    let fw = client()
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

  @Test func detailsReturnsADecisionValueReturnsTheBareValue() async {
    let fw = client()
    await fw.initialize()
    let value = fw.controlPoints.getBooleanValue("absent", default: false)
    let details = fw.controlPoints.getBooleanDetails("absent", default: false)
    #expect(value == false)
    #expect(details.value == .bool(false))
    #expect(details.reason == .error)
  }

  @Test func registerTargetExistsWithLocalModeRecordedAndTraced() async throws {
    let fw = try await initFireweave(.local(InitFireweaveLocalOptions()))
    let result = await fw.registerTarget("user_1")
    #expect(result.ok)
  }

  /// Reachable from the SANCTIONED entry point (rust task-12 finding: an
  /// accessor that exists only on a concrete infrastructure type does NOT
  /// satisfy spec/modes.md — it must be reachable via the real
  /// `initFireweave` -> `client.runtime.backendAdapter` path, not a
  /// directly-constructed adapter kept aside in the test).
  @Test func registeredTargetIsReadableThroughTheSanctionedEntryPoint() async throws {
    let fw = try await initFireweave(.local(InitFireweaveLocalOptions()))
    let options = RegisterTargetOptions(properties: ["plan": "pro"])
    let result = await fw.registerTarget("user_42", options: options)
    #expect(result.ok)

    let localAdapter = try #require(fw.runtime.backendAdapter as? FireweaveLocalAdapter)
    let recorded = localAdapter.registeredTargets()
    #expect(recorded.count == 1)
    #expect(recorded[0].targetingKey == "user_42")
    #expect(recorded[0].properties["plan"] == .string("pro"))
  }

  @Test func identifyRegistersAndRePrefetchesUnderTheStableTargetingKey() async throws {
    let fw = try await initFireweave(.local(InitFireweaveLocalOptions(controlPoints: ["f": true])))
    let result = await fw.identify("user_9")
    #expect(result.ok)
    #expect(fw.controlPoints.getBooleanValue("f", default: false) == true)
  }
}
