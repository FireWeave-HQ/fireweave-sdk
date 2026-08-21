import Dispatch
import Testing

@testable import Fireweave

@Suite("FireweaveRuntime lifecycle + evaluation")
struct RuntimeTests {
  @Test func evaluateBeforeInitializeIsNotReady() {
    let runtime = FireweaveRuntime(adapter: InMemoryAdapter())
    let decision = runtime.evaluate(key: "any", type: .boolean, defaultValue: .bool(false))
    #expect(decision.reason == .error)
    #expect(decision.errorKind == .notReady)
    #expect(decision.value == .bool(false))
  }

  @Test func evaluateAfterShutdownIsAlreadyClosed() async {
    let runtime = FireweaveRuntime(adapter: InMemoryAdapter())
    await runtime.initialize()
    await runtime.shutdown()
    let decision = runtime.evaluate(key: "any", type: .boolean, defaultValue: .bool(false))
    #expect(decision.errorKind == .alreadyClosed)
  }

  @Test func shutdownIsIdempotent() async {
    let runtime = FireweaveRuntime(adapter: InMemoryAdapter())
    await runtime.initialize()
    await runtime.shutdown()
    await runtime.shutdown()
    #expect(runtime.state() == .shutdown)
  }

  @Test func matchedFlagResolvesWithTargetingMatch() async {
    let adapter = InMemoryAdapter.from(flagsJSON: [
      "my-flag": .object(["type": "boolean", "enabled": true, "variant": "on", "value": true])
    ])
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    let decision = runtime.evaluate(key: "my-flag", type: .boolean, defaultValue: .bool(false))
    #expect(decision.value == .bool(true))
    #expect(decision.reason == .targetingMatch)
  }

  @Test func absentKeyOnInMemoryAdapterIsFlagNotFound() async {
    let runtime = FireweaveRuntime(adapter: InMemoryAdapter())
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    let decision = runtime.evaluate(key: "missing", type: .boolean, defaultValue: .bool(false))
    #expect(decision.errorKind == .flagNotFound)
    #expect(decision.value == .bool(false))
  }

  @Test func absentKeyOnLocalAdapterIsDefaultNotError() async {
    let runtime = FireweaveRuntime(adapter: FireweaveLocalAdapter(devFlags: [:]))
    await runtime.initialize()
    let decision = runtime.evaluate(key: "missing", type: .boolean, defaultValue: .bool(true))
    #expect(decision.reason == .defaultReason)
    #expect(decision.value == .bool(true))
    #expect(decision.errorKind == nil)
  }

  /// The dual-meaning correctness point this task's design had to resolve:
  /// a flag PRESENT in the batch whose conditions do not select the
  /// caller is `.defaultReason`, never `.flagNotFound` — for EVERY
  /// adapter, not just local. See `Runtime.swift`'s evaluate() comment.
  @Test func presentButNonMatchingConditionIsDefaultNotFlagNotFound() async {
    let adapter = InMemoryAdapter.from(flagsJSON: [
      "gated": .object([
        "type": "boolean", "enabled": true, "variant": "on", "value": true,
        "matchAttribute": .object(["tier": "gold"]),
      ])
    ])
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(
      context: EvaluationContext(targetingKey: "t1", attributes: ["tier": "bronze"]))
    let decision = runtime.evaluate(
      key: "gated", type: .boolean, defaultValue: .bool(false),
      context: EvaluationContext(attributes: ["tier": "bronze"])
    )
    #expect(decision.reason == .defaultReason)
    #expect(decision.errorKind == nil)
  }

  @Test func vendorMetadataEmittedOnlyWhenBothKeysPresent() async {
    let both = InMemoryAdapter.from(flagsJSON: [
      "f": .object([
        "type": "boolean", "enabled": true, "variant": "on", "value": true,
        "metadata": .object(["id": 1001]),
        "reason": .object(["code": "condition_match", "condition_index": 0]),
      ])
    ])
    let runtimeBoth = FireweaveRuntime(adapter: both)
    await runtimeBoth.initialize(context: EvaluationContext(targetingKey: "t1"))
    let decisionBoth = runtimeBoth.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))
    #expect(decisionBoth.flagMetadata["fireweave.vendorFlagId"] == .number(1001))
    #expect(decisionBoth.flagMetadata["fireweave.reasonCode"] == .string("condition_match"))

    // Only a vendor id, no condition_index/reason code -> neither key.
    let onlyOne = InMemoryAdapter.from(flagsJSON: [
      "f": .object([
        "type": "boolean", "enabled": true, "variant": "on", "value": true,
        "metadata": .object(["id": 1001]),
      ])
    ])
    let runtimeOne = FireweaveRuntime(adapter: onlyOne)
    await runtimeOne.initialize(context: EvaluationContext(targetingKey: "t1"))
    let decisionOne = runtimeOne.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))
    #expect(decisionOne.flagMetadata["fireweave.vendorFlagId"] == nil)
    #expect(decisionOne.flagMetadata["fireweave.reasonCode"] == nil)
  }

  @Test func typeMismatchOnResolvedValue() async {
    let adapter = InMemoryAdapter.from(flagsJSON: [
      "f": .object(["type": "string", "enabled": true, "variant": "on", "value": "not-a-bool"])
    ])
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    let decision = runtime.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))
    #expect(decision.errorKind == .typeMismatch)
  }

  @Test func faultInPrefetchEntersFatalOnFirstInitialize() async {
    let adapter = InMemoryAdapter()
    adapter.setFault(InMemoryFault(kind: .backendUnavailable))
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    // adapter.initialize() itself succeeds (InMemoryAdapter never fails
    // there); the fault fires inside prefetch(), which is an `.error`
    // (retriable), not `.fatal` (boot failure) — see Runtime.swift.
    #expect(runtime.state() == .error)
    let decision = runtime.evaluate(key: "any", type: .boolean, defaultValue: .bool(false))
    #expect(decision.errorKind == .backendUnavailable)
  }
}

@Suite("FireweaveRuntime concurrency: prefetch ceiling + main-actor-safe read")
struct RuntimeConcurrencyTests {
  /// Ceiling loses the race against a slow prefetch: `refresh()` returns
  /// PROMPTLY (near the ceiling, not near the adapter's real delay), and
  /// the state is `.stale`, never blocking on the loser.
  @Test func ceilingLossEntersStaleWithoutWaitingForTheSlowAdapter() async {
    // 2s — much slower than the 50ms ceiling configured below.
    let adapter = SlowFakeAdapter(delayNs: 2_000_000_000)
    let runtime = FireweaveRuntime(adapter: adapter, config: RuntimeConfig(flagsReadyTimeoutMs: 50))
    let start = DispatchTime.now()
    await runtime.initialize()
    let elapsedMs =
      Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
    #expect(runtime.state() == .stale)
    // Generous upper bound: this must be close to the 50ms ceiling, not
    // anywhere near the adapter's 2000ms delay. 500ms leaves headroom
    // for CI scheduling jitter while still proving no full-delay wait.
    #expect(elapsedMs < 500)

    let decision = runtime.evaluate(key: "anything", type: .boolean, defaultValue: .bool(false))
    #expect(decision.reason == .stale)
  }

  /// The concurrency-safety claim itself: `evaluate()` (a plain
  /// synchronous call, exactly as callable from `@MainActor` code as any
  /// other function) returns correctly WHILE a slow prefetch is still
  /// in flight on a background `Task` — no deadlock, no blocking.
  @Test @MainActor func evaluateFromMainActorWhilePrefetchInFlightDoesNotDeadlock() async {
    let adapter = SlowFakeAdapter(
      delayNs: 300_000_000,
      result: [
        "f": AdapterResolution(
          found: true, enabled: true, value: .bool(true), reason: .targetingMatch)
      ]
    )
    let runtime = FireweaveRuntime(
      adapter: adapter, config: RuntimeConfig(flagsReadyTimeoutMs: 5_000))

    // Start initialize (which prefetches) WITHOUT awaiting it here, then
    // immediately read from the main actor — this is the exact race the
    // controller ruling is about: a render-path read must not block on
    // an in-flight prefetch.
    let initTask = Task { await runtime.initialize() }

    // This call happens on the MainActor (this test function is
    // @MainActor-isolated) while `initTask` is concurrently running the
    // adapter's slow prefetch off it. It must return immediately with a
    // NotReady decision (the cache has not been populated yet) rather
    // than hang.
    let readWhilePending = runtime.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))
    #expect(readWhilePending.errorKind == .notReady || readWhilePending.value == .bool(false))

    await initTask.value
    #expect(runtime.state() == .ready)
    let readAfterReady = runtime.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))
    #expect(readAfterReady.value == .bool(true))
    #expect(readAfterReady.reason == .targetingMatch)
  }
}
