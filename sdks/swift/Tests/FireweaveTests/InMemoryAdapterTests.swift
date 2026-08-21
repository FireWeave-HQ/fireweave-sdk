import Testing

@testable import Fireweave

@Suite("InMemoryAdapter")
struct InMemoryAdapterTests {
  @Test func missingFlagIsAbsentFromTheBatch() async throws {
    let adapter = InMemoryAdapter()
    let result = try await adapter.prefetch(context: EvaluationContext(), options: nil)
    #expect(result.isEmpty)
  }

  @Test func matchAttributeGatesTheMatch() async throws {
    let adapter = InMemoryAdapter.from(flagsJSON: [
      "f": .object([
        "type": "boolean", "enabled": true, "variant": "on", "value": true,
        "matchAttribute": .object(["tier": "gold"]),
      ])
    ])
    let matching = try await adapter.prefetch(
      context: EvaluationContext(attributes: ["tier": "gold"]), options: nil
    )
    #expect(matching["f"]?.found == true)

    let notMatching = try await adapter.prefetch(
      context: EvaluationContext(attributes: ["tier": "bronze"]), options: nil
    )
    #expect(notMatching["f"]?.found == false)
  }

  @Test func matchPersonBehavesLikeMatchAttribute() async throws {
    let adapter = InMemoryAdapter.from(flagsJSON: [
      "f": .object([
        "type": "boolean", "enabled": true, "variant": "on", "value": true,
        "matchPerson": .object(["email_domain": "example.com"]),
      ])
    ])
    let result = try await adapter.prefetch(
      context: EvaluationContext(attributes: ["email_domain": "example.com"]), options: nil
    )
    #expect(result["f"]?.found == true)
  }

  @Test func faultOverridesEveryPrefetch() async {
    let adapter = InMemoryAdapter()
    adapter.setFault(InMemoryFault(kind: .backendUnavailable))
    await #expect(throws: FireweaveError.self) {
      try await adapter.prefetch(context: EvaluationContext(), options: nil)
    }
  }

  @Test func vendorMetadataGateRequiresAllThreeSignals() async throws {
    // vendorFlagId + reasonCode but NO conditionIndex -> gate fails, no
    // metadata surfaces at the adapter level either.
    let adapter = InMemoryAdapter.from(flagsJSON: [
      "f": .object([
        "type": "boolean", "enabled": true, "variant": "on", "value": true,
        "metadata": .object(["id": 7]),
        "reason": .object(["code": "condition_match"]),
      ])
    ])
    let result = try await adapter.prefetch(context: EvaluationContext(), options: nil)
    #expect(result["f"]?.vendorFlagId == nil)
    #expect(result["f"]?.reasonCode == nil)
  }
}
