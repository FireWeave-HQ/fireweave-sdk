import Testing

@testable import Fireweave

/// `spec/control-points.md` "A failed re-fetch keeps the last good
/// decisions": after one successful prefetch, a failed or timed-out
/// re-fetch serves the cached decisions with reason `STALE`; the next
/// success replaces them; a failure with no earlier success still serves
/// defaults with `ERROR`.
@Suite("FireweaveRuntime: last good decisions on a failed re-fetch")
struct LastGoodRefreshTests {
  private static func batch(_ value: Bool, variant: String) -> PrefetchResult {
    [
      "checkout": AdapterResolution(
        found: true,
        enabled: true,
        value: .bool(value),
        variant: variant,
        reason: .targetingMatch
      ),
      "gated": AdapterResolution(found: false),
    ]
  }

  @Test func aFailureAfterASuccessServesTheOldValuesAsStale() async {
    let adapter = SlowFakeAdapter(delayNs: 0, result: Self.batch(true, variant: "on"))
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    #expect(runtime.state() == .ready)

    adapter.setFailure(FireweaveError(kind: .rateLimited))
    await runtime.refresh()

    #expect(runtime.state() == .stale)
    #expect(runtime.initializationError() == nil)
    #expect(runtime.lastRefreshError()?.kind == .rateLimited)
    let decision = runtime.evaluate(key: "checkout", type: .boolean, defaultValue: .bool(false))
    #expect(decision.value == .bool(true))
    #expect(decision.variant == "on")
    // The backend's reason was TARGETING_MATCH; the claim now is "last good".
    #expect(decision.reason == .stale)
    #expect(decision.errorKind == nil)
    let unmatched = runtime.evaluate(key: "gated", type: .boolean, defaultValue: .bool(true))
    #expect(unmatched.value == .bool(true))
    #expect(unmatched.reason == .stale)
  }

  @Test func aTimeoutAfterASuccessServesTheOldValuesAsStale() async {
    let adapter = SlowFakeAdapter(delayNs: 0, result: Self.batch(true, variant: "on"))
    let config = RuntimeConfig(flagsReadyTimeoutMs: 50)
    let runtime = FireweaveRuntime(adapter: adapter, config: config)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))

    adapter.setDelay(2_000_000_000)
    await runtime.refresh()

    #expect(runtime.state() == .stale)
    let decision = runtime.evaluate(key: "checkout", type: .boolean, defaultValue: .bool(false))
    #expect(decision.value == .bool(true))
    #expect(decision.reason == .stale)
  }

  @Test func aFailureWithNoEarlierSuccessServesTheDefaultWithError() async {
    let adapter = SlowFakeAdapter(
      delayNs: 0,
      result: Self.batch(true, variant: "on"),
      shouldFail: FireweaveError(kind: .network)
    )
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))

    #expect(runtime.state() == .error)
    #expect(runtime.initializationError()?.kind == .network)
    #expect(runtime.lastRefreshError()?.kind == .network)
    let decision = runtime.evaluate(key: "checkout", type: .boolean, defaultValue: .bool(false))
    #expect(decision.value == .bool(false))
    #expect(decision.reason == .error)
    #expect(decision.errorKind == .network)
  }

  @Test func aSuccessAfterStaleServesTheFreshValues() async {
    let adapter = SlowFakeAdapter(delayNs: 0, result: Self.batch(true, variant: "on"))
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    adapter.setFailure(FireweaveError(kind: .backendUnavailable))
    await runtime.refresh()
    #expect(runtime.state() == .stale)

    adapter.setFailure(nil)
    adapter.setResult(Self.batch(false, variant: "off"))
    await runtime.refresh()

    #expect(runtime.state() == .ready)
    #expect(runtime.lastRefreshError() == nil)
    let decision = runtime.evaluate(key: "checkout", type: .boolean, defaultValue: .bool(true))
    #expect(decision.value == .bool(false))
    #expect(decision.variant == "off")
    #expect(decision.reason == .targetingMatch)
  }

  @Test func anErrorThenASuccessThenAFailureKeepsTheLaterSuccess() async {
    let adapter = SlowFakeAdapter(
      delayNs: 0,
      result: Self.batch(true, variant: "on"),
      shouldFail: FireweaveError(kind: .authentication)
    )
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))
    #expect(runtime.state() == .error)

    adapter.setFailure(nil)
    await runtime.refresh()
    #expect(runtime.state() == .ready)
    #expect(runtime.initializationError() == nil)

    adapter.setFailure(FireweaveError(kind: .authentication))
    await runtime.refresh()
    #expect(runtime.state() == .stale)
    let decision = runtime.evaluate(key: "checkout", type: .boolean, defaultValue: .bool(false))
    #expect(decision.value == .bool(true))
  }

  @Test func aRefreshThatSettlesAfterShutdownIsDiscarded() async {
    let adapter = SlowFakeAdapter(delayNs: 0, result: Self.batch(true, variant: "on"))
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "t1"))

    adapter.setDelay(200_000_000)
    let inFlight = Task { await runtime.refresh() }
    try? await Task.sleep(nanoseconds: 50_000_000)
    await runtime.shutdown()
    await inFlight.value

    #expect(runtime.state() == .shutdown)
    let decision = runtime.evaluate(key: "checkout", type: .boolean, defaultValue: .bool(false))
    #expect(decision.errorKind == .alreadyClosed)
  }
}
