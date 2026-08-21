import Testing

@testable import Fireweave

@Suite("Context merge")
struct ContextMergeTests {
  @Test func laterLayersWin() {
    let global = EvaluationContext(targetingKey: "g", attributes: ["tier": "bronze"])
    let client = EvaluationContext(attributes: ["tier": "silver"])
    let invocation = EvaluationContext(attributes: ["tier": "gold"])

    let merged = mergeContexts([global, client, invocation])
    #expect(merged.targetingKey == "g")
    #expect(merged.attributes["tier"] == "gold")
  }

  @Test func mergeSkipsAbsentLayers() {
    let invocation = EvaluationContext(targetingKey: "only-one")
    let merged = mergeContexts([nil, nil, invocation])
    #expect(merged.targetingKey == "only-one")
  }

  @Test func groupsAndGroupPropertiesReadThroughAliasesAndCanonicalKeys() {
    let ctx = EvaluationContext(attributes: [
      "fireweave.groups": .object(["organization": "org_1"]),
      "groupProperties": .object(["organization": .object(["plan": "enterprise"])]),
    ])
    #expect(ctx.groups?["organization"] == "org_1")
    #expect(ctx.groupProperties?["organization"]?.objectValue?["plan"] == "enterprise")
  }
}

@Suite("Validation")
struct ValidationTests {
  @Test func keyMustBeNonEmpty() {
    #expect(validateControlPointKey("").isFailure)
    #expect(validateControlPointKey("ok").isSuccess)
  }

  @Test func keyLengthIsCountedInCharacters() {
    #expect(validateControlPointKey(String(repeating: "k", count: 257)).isFailure)
    #expect(validateControlPointKey(String(repeating: "k", count: 256)).isSuccess)
  }

  @Test func keyRejectsControlCharacters() {
    #expect(validateControlPointKey("bad\u{0007}key").isFailure)
  }

  @Test func defaultValueTypeMismatch() {
    let result = validateDefaultValue(.boolean, .string("not-a-bool"))
    #expect(result.errorKind == .typeMismatch)
    #expect(validateDefaultValue(.boolean, .bool(true)).isSuccess)
  }

  @Test func targetingKeyRequiredAndMissing() {
    let result = validateTargetingKey(nil, required: true)
    #expect(result.errorValue?.openFeatureErrorCode == "TARGETING_KEY_MISSING")
    #expect(validateTargetingKey(nil, required: false).isSuccess)
    #expect(validateTargetingKey("x", required: true).isSuccess)
  }

  @Test func contextReservedKeysRejected() {
    let ctx = EvaluationContext(targetingKey: "t", attributes: ["targetingKey": "dup"])
    let result = validateContext(
      ctx, limits: defaultContextLimits, reservedKeys: defaultReservedAttributeKeys,
      requireTargetingKey: false
    )
    #expect(result.errorKind == .invalidContext)
  }

  @Test func contextFireweaveCarveoutKeysAllowedOthersRejected() {
    let ok = EvaluationContext(
      targetingKey: "t", attributes: ["fireweave.groups": .object(["organization": "org_1"])]
    )
    #expect(
      validateContext(
        ok, limits: defaultContextLimits, reservedKeys: [], requireTargetingKey: false
      ).isSuccess)

    let bad = EvaluationContext(
      targetingKey: "t", attributes: ["fireweave.evaluationContexts": .array(["production"])]
    )
    #expect(
      validateContext(
        bad, limits: defaultContextLimits, reservedKeys: [], requireTargetingKey: false
      ).isFailure
    )
  }

  @Test func contextNestingDepthExceeded() {
    var nested: JSONValue = .object(["d9": true])
    for name in ["d8", "d7", "d6", "d5", "d4", "d3", "d2", "d1"] {
      nested = .object([name: nested])
    }
    let ctx = EvaluationContext(targetingKey: "t", attributes: nested.objectValue!)
    let result = validateContext(
      ctx, limits: defaultContextLimits, reservedKeys: [], requireTargetingKey: false)
    #expect(result.errorValue?.message == "context exceeds maximum nesting depth")
  }

  @Test func contextAttributeCountExceeded() {
    var attrs: [String: JSONValue] = [:]
    for i in 0..<200 { attrs["a\(i)"] = .number(Double(i)) }
    let ctx = EvaluationContext(targetingKey: "t", attributes: attrs)
    let result = validateContext(
      ctx, limits: defaultContextLimits, reservedKeys: [], requireTargetingKey: false)
    #expect(result.errorValue?.message == "context exceeds maximum attribute count")
  }

  @Test func initOptionsModeAbsentIsConfiguration() {
    let result = validateInitOptions(mode: nil, apiKey: nil, apiUrl: nil)
    #expect(result.errorKind == .configuration)
    #expect(result.errorValue?.openFeatureErrorCode == "PROVIDER_FATAL")
  }

  @Test func initOptionsRemoteRequiresCredentials() {
    #expect(validateInitOptions(mode: .remote, apiKey: nil, apiUrl: "https://x").isFailure)
    #expect(validateInitOptions(mode: .remote, apiKey: "key", apiUrl: "  ").isFailure)
    #expect(validateInitOptions(mode: .remote, apiKey: "key", apiUrl: "https://x").isSuccess)
  }

  @Test func initOptionsLocalRejectsStrayCredentials() {
    #expect(validateInitOptions(mode: .local, apiKey: "key", apiUrl: nil).isFailure)
    #expect(validateInitOptions(mode: .local, apiKey: nil, apiUrl: nil).isSuccess)
  }
}

extension Validated {
  var isSuccess: Bool { if case .success = self { true } else { false } }
  var isFailure: Bool { if case .failure = self { true } else { false } }
  var errorValue: FireweaveError? { if case .failure(let e) = self { e } else { nil } }
  var errorKind: ErrorKind? { errorValue?.kind }
}
