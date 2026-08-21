import Foundation

/// Ceiling on a prefetch so a hung backend cannot block boot
/// (`ADR-0009` "Fail-open, not fail-silent").
public let defaultFlagsReadyTimeoutMs: Int = 5_000

/// Construction-time configuration for `FireweaveRuntime`.
public struct RuntimeConfig: Sendable {
  public var limits: ContextLimits
  /// Extra reserved attribute keys, ON TOP OF the canonical
  /// `defaultReservedAttributeKeys` pair (`targetingKey`, `kind`).
  public var reservedAttributeKeys: Set<String>
  public var requireTargetingKey: Bool
  public var flagsReadyTimeoutMs: Int
  public var globalContext: EvaluationContext?
  /// Restrict prefetch to a known set of control points.
  public var flagKeys: [String]?

  public init(
    limits: ContextLimits = defaultContextLimits,
    reservedAttributeKeys: Set<String> = [],
    requireTargetingKey: Bool = false,
    flagsReadyTimeoutMs: Int = defaultFlagsReadyTimeoutMs,
    globalContext: EvaluationContext? = nil,
    flagKeys: [String]? = nil
  ) {
    self.limits = limits
    self.reservedAttributeKeys = reservedAttributeKeys
    self.requireTargetingKey = requireTargetingKey
    self.flagsReadyTimeoutMs = flagsReadyTimeoutMs
    self.globalContext = globalContext
    self.flagKeys = flagKeys
  }
}

/// `FireweaveRuntime`: shared engine behind `FireweaveClient`.
///
/// ## The sync/async seam (Phase 6 controller ruling: "web's shape, not
/// node's")
///
/// `initialize()`/`refresh()` are `async` and populate `cacheBox`
/// (`setClientContext` itself is a plain synchronous setter — a caller who
/// wants the new context reflected in the cache calls `refresh()`
/// afterwards, exactly like `FireweaveClient.identify` does);
/// `evaluate()` is a pure, SYNCHRONOUS read of whatever
/// `cacheBox` currently holds. That split is what lets nine synchronous
/// methods sit on top of an architecture that talks to a real network
/// backend, without a caller ever awaiting inside a render path
/// (`ADR-0009`, studied via `sdks/web` for the seam; this port/runtime shape
/// is built from `spec/control-points.md` + `spec/modes.md` directly, not
/// copied from web's browser-only, remote-only surface — swift additionally
/// supports `local` mode, per this task's brief).
///
/// ## Concurrency safety (why this cannot deadlock a render path)
///
/// See `ControlPointsCacheBox`'s doc comment for the mechanism. In short:
/// `evaluate()` takes exactly one `cacheBox.snapshot()` (a single, tiny,
/// non-blocking critical section) and does everything else — validation,
/// cache lookup, `Decision` construction — as pure computation with no lock
/// held and no `await`. A prefetch running concurrently on a background
/// `Task` only ever contends for that same tiny critical section when it
/// finally calls `cacheBox.apply(...)`; it can never be "in the middle of"
/// holding the lock while awaiting network I/O, because the network I/O
/// happens entirely BEFORE the lock is ever touched (`refresh()` awaits
/// `adapter.prefetch` first, then calls the synchronous `cacheBox.apply`).
/// This is what makes it safe to call `evaluate()` from the main actor at
/// the exact moment a prefetch is in flight off it — the two can never
/// deadlock each other because neither's locked section ever waits on the
/// other.
///
/// `FireweaveRuntime` is `Sendable` (`@unchecked` because `cacheBox` is a
/// manually-synchronized class the compiler cannot verify, and `adapter` is
/// a `Sendable`-constrained existential) so one instance is shared freely
/// across threads/actors — the natural shape for a client used from both
/// UI code and background work.
public final class FireweaveRuntime: @unchecked Sendable {
  private let adapter: any ControlPointsBackendAdapter
  private let limits: ContextLimits
  private let reservedAttributeKeys: Set<String>
  private let requireTargetingKey: Bool
  private let flagsReadyTimeoutMs: Int
  private let flagKeys: [String]?
  private let cacheBox = ControlPointsCacheBox()
  private let contextBox: ContextBox

  public init(adapter: any ControlPointsBackendAdapter, config: RuntimeConfig = RuntimeConfig()) {
    self.adapter = adapter
    self.limits = config.limits
    self.reservedAttributeKeys = config.reservedAttributeKeys
    self.requireTargetingKey = config.requireTargetingKey
    self.flagsReadyTimeoutMs = config.flagsReadyTimeoutMs
    self.flagKeys = config.flagKeys
    self.contextBox = ContextBox(global: config.globalContext)
  }

  /// The concrete adapter backing this runtime — the SANCTIONED path back
  /// to a mode-specific accessor (e.g. `FireweaveLocalAdapter.registeredTargets()`)
  /// via a checked `as?` downcast. Swift's `as?` on a protocol existential
  /// is always available (unlike Rust, which needed a hand-rolled `AsAny`
  /// supertrait — task-12-report.md fix-report finding 2 — because Rust
  /// erases concrete types behind `dyn Trait`; Swift's existentials retain
  /// full runtime type metadata, so no such workaround is needed here).
  /// See `Client.swift`'s `runtime` property for why this is reachable
  /// from the sanctioned entry point (`initFireweave` -> `client.runtime.adapter`),
  /// not just from a concrete type constructed directly.
  public var backendAdapter: any ControlPointsBackendAdapter { adapter }

  public func state() -> LifecycleState { cacheBox.currentState() }

  /// The stored `.error`/`.fatal` cause, if any — lets a caller (the
  /// conformance runner's `initialize` operation, in particular) inspect
  /// WHY a boot failed without that reason ever having been `throw`n
  /// (`spec/control-points.md` "initialise is the exception" applies to
  /// `initFireweave`, not this runtime, which is deliberately fail-open —
  /// see `initialize()`'s doc comment).
  public func initializationError() -> FireweaveError? { cacheBox.snapshot().initError }

  // MARK: - context layering

  public func setClientContext(_ context: EvaluationContext?) {
    contextBox.setClient(context)
  }

  private func mergedContext(invocation: EvaluationContext?) -> EvaluationContext {
    let (global, client) = contextBox.snapshot()
    return mergeContexts([global, client, invocation])
  }

  // MARK: - lifecycle

  /// Bring the adapter up and populate the cache. Never throws — a hung or
  /// failing prefetch must not block app boot (`ADR-0009` "Fail-open, not
  /// fail-silent"). The four Configuration rows that MUST fail loudly
  /// (`spec/modes.md`) are validated by `initFireweave` BEFORE this is ever
  /// called (`validateInitOptions` + `assertHostAllowed`, both synchronous)
  /// — by the time control reaches here, only genuinely transient failures
  /// remain, and those degrade to `.error`/`.stale`, never a `throw`.
  public func initialize(context: EvaluationContext? = nil) async {
    if cacheBox.currentState() == .shutdown { return }
    cacheBox.setState(.initializing)
    if let context { contextBox.mergeIntoGlobal(context) }

    do {
      try await adapter.initialize()
    } catch {
      // adapter.initialize() itself failing is a BOOT failure, not a
      // transient one — `.fatal`, distinct from `refresh()`'s prefetch
      // failures below (`.error`). See `LifecycleState.fatal`'s doc
      // comment; pinned by `life-init-fail-configuration`.
      let fwError =
        (error as? FireweaveError) ?? FireweaveError(kind: .backendUnavailable, initFatal: true)
      cacheBox.failFatal(fwError)
      return
    }
    await refresh()
  }

  /// Re-run the prefetch against the current global+client context. Races
  /// the ceiling via `PrefetchRaceGate` (see that type's doc comment for
  /// why not a `TaskGroup`).
  public func refresh() async {
    if cacheBox.currentState() == .shutdown { return }

    let (global, client) = contextBox.snapshot()
    let merged = mergeContexts([global, client])
    if case .failure = validateContext(
      merged, limits: limits,
      reservedKeys: reservedAttributeKeys.union(defaultReservedAttributeKeys),
      requireTargetingKey: false
    ) {
      cacheBox.setState(.error)
      return
    }

    let gate = PrefetchRaceGate()
    let options = flagKeys.map { PrefetchOptions(flagKeys: $0) }

    Task { [adapter] in
      do {
        let result = try await adapter.prefetch(context: merged, options: options)
        gate.resolve(.prefetched(result))
      } catch {
        let fwError = (error as? FireweaveError) ?? FireweaveError(kind: .network)
        gate.resolve(.failed(fwError))
      }
    }
    Task {
      try? await Task.sleep(nanoseconds: UInt64(max(flagsReadyTimeoutMs, 0)) * 1_000_000)
      gate.resolve(.timedOut)
    }

    switch await gate.wait() {
    case .prefetched(let result):
      cacheBox.apply(result)
    case .failed(let error):
      cacheBox.fail(error)
    case .timedOut:
      // Fail OPEN (boot continues) but not SILENT: reads will carry
      // STALE and the lifecycle state says so. The losing prefetch
      // Task, if it eventually completes, is simply discarded — see
      // PrefetchRaceGate's doc comment.
      cacheBox.setState(.stale)
    }
  }

  // MARK: - evaluation (the synchronous read path)

  /// Evaluate a flag. Never throws; failures return the default.
  ///
  /// Validates in the fixed order `spec/control-points.md` "Validation,
  /// before any I/O" names, stopping at the first failure: (1) key, (2)
  /// default vs type, (3) context, (4) lifecycle. Only once all four pass
  /// does this consult the cache — a pure, already-fetched read, never an
  /// adapter call (see the type doc comment for why this is what makes the
  /// method synchronous and concurrency-safe).
  public func evaluate(
    key: String,
    type: FlagType,
    defaultValue: JSONValue,
    context invocationContext: EvaluationContext? = nil,
    options: EvaluateOptions? = nil
  ) -> Decision {
    if case .failure(let err) = validateControlPointKey(key) {
      return Self.errorDecision(defaultValue, err)
    }
    if case .failure(let err) = validateDefaultValue(type, defaultValue) {
      return Self.errorDecision(defaultValue, err)
    }

    let merged = mergedContext(invocation: invocationContext)
    let reserved = reservedAttributeKeys.union(defaultReservedAttributeKeys)
    if case .failure(let err) = validateContext(
      merged, limits: limits, reservedKeys: reserved, requireTargetingKey: requireTargetingKey
    ) {
      return Self.errorDecision(defaultValue, err)
    }

    let snap = cacheBox.snapshot()
    if let lifecycleErr = Self.lifecycleError(state: snap.state, initError: snap.initError) {
      return Self.errorDecision(defaultValue, lifecycleErr)
    }

    // Two DIFFERENT "no value" signals live here, and conflating them is
    // a real correctness hazard (not just a style choice):
    //
    // 1. The key is PRESENT in the batch but `found == false` — the
    //    definition exists but its targeting conditions did not select
    //    this caller (`InMemoryAdapter`'s rich matchAttribute/matchGroups/
    //    matchPerson/matchTargetingKey conditions). This is ALWAYS
    //    `.defaultReason`, regardless of which adapter produced it —
    //    "no decision for this key/context" is a claim about the FLAG,
    //    not about the adapter's miss policy.
    // 2. The key is ABSENT from the batch entirely — governed by
    //    `adapter.missReason`: local mode's unknown-key row is `default`/
    //    `DEFAULT` (`spec/modes.md` "Behaviour per mode"); every other
    //    adapter's absent key is `default`/`ERROR`/`FlagNotFound`.
    if let resolution = snap.cache[key] {
      if !resolution.found {
        return Decision(value: defaultValue, reason: .defaultReason)
      }
      return Self.decisionFromResolution(
        resolution, type: type, defaultValue: defaultValue, options: options, snap: snap
      )
    }

    if adapter.missReason == .defaultReason {
      return Decision(value: defaultValue, reason: .defaultReason)
    }
    // A cache miss while STALE is not a missing control point — it is an
    // unanswered question. Reporting FlagNotFound there would send a
    // caller hunting for a flag that may well exist.
    if snap.state == .stale {
      return Decision(
        value: defaultValue, variant: "default", reason: .stale,
        flagMetadata: ["fireweave.stale": true]
      )
    }
    return Self.errorDecision(defaultValue, .flagNotFound())
  }

  private static func decisionFromResolution(
    _ resolution: AdapterResolution,
    type: FlagType,
    defaultValue: JSONValue,
    options: EvaluateOptions?,
    snap: (state: LifecycleState, cache: PrefetchResult, initError: FireweaveError?)
  ) -> Decision {
    let value = resolution.value ?? .null
    if !matchesExpectedType(value, type) {
      return Self.errorDecision(defaultValue, FireweaveError(kind: .typeMismatch))
    }

    var metadata: FlagMetadata = [:]
    if let version = resolution.version {
      metadata["fireweave.flagVersion"] = .number(Double(version))
    }
    // Detailed enrichment (ruling 11): emit both keys, or neither. This
    // pass-through does NOT re-derive the ruling-11 gate itself — that
    // gate needs a "did the backend report a condition index" signal
    // only `InMemoryAdapter`'s fixture input carries, and it applies the
    // gate before constructing the `AdapterResolution` this reads (same
    // fix rust's task-12 review round applied to its own runtime).
    if let vendorFlagId = resolution.vendorFlagId, let reasonCode = resolution.reasonCode {
      metadata["fireweave.vendorFlagId"] = .number(Double(vendorFlagId))
      metadata["fireweave.reasonCode"] = .string(reasonCode)
    }
    if resolution.fromCache {
      metadata["fireweave.fromCache"] = .bool(true)
    }
    if options?.includePayload == true, let payload = resolution.payload {
      let payloadString: String
      if case .string(let s) = payload {
        payloadString = s
      } else {
        payloadString = payload.toStableJSONString()
      }
      metadata["fireweave.payload"] = .string(payloadString)
    }

    let reason: DecisionReason
    if resolution.enabled == false {
      reason = .disabled
    } else if let forced = resolution.reason {
      reason = forced
    } else if resolution.fromCache || snap.state == .stale {
      reason = .stale
    } else {
      reason = .targetingMatch
    }

    return Decision(
      value: value, variant: resolution.variant, reason: reason, flagMetadata: metadata)
  }

  // MARK: - target registration

  /// Register a target. Resolves rather than throwing — this runs in
  /// sign-in paths, where a targeting concern must not break
  /// authentication (`spec/modes.md` "registerTarget in local mode").
  public func registerTarget(
    targetingKey: String,
    options: RegisterTargetOptions? = nil
  ) async -> RegisterTargetResult {
    let snap = cacheBox.snapshot()
    if let lifecycleErr = Self.lifecycleError(state: snap.state, initError: snap.initError) {
      return .failure(lifecycleErr)
    }
    return await adapter.registerTarget(targetingKey: targetingKey, options: options)
  }

  /// Extension-call lifecycle gate (kept for `invokeCapability`, even
  /// though v1's `SUPPORTED_CAPABILITIES` is empty and never reaches it
  /// today — ruling 17, mirrored from rust/web): READY/STALE pass (`nil`);
  /// after shutdown the gate is `.alreadyClosed`; any pre-ready state
  /// degrades with `.unsupportedCapability`.
  public func extensionLifecycleGate() -> FireweaveError? {
    switch cacheBox.currentState() {
    case .ready, .stale: return nil
    case .shutdown: return FireweaveError(kind: .alreadyClosed)
    case .uninitialized, .initializing, .error, .fatal:
      return FireweaveError(kind: .unsupportedCapability)
    }
  }

  /// Test/fixture hook: pin the lifecycle state directly (used by the
  /// conformance runner's `given.providerState` provisioning, and by unit
  /// tests — mirrors rust's `force_state`).
  public func forceState(_ state: LifecycleState) {
    cacheBox.forceState(state)
  }

  /// Test/fixture hook: seed the cache directly without a real prefetch
  /// (used by the conformance runner for the in-memory backend, where
  /// "prefetch" is instantaneous by construction anyway, and by
  /// `fault-stale-cache`, which provisions staleness directly rather than
  /// through a real timeout).
  func seedCache(_ result: PrefetchResult, state: LifecycleState = .ready) {
    cacheBox.apply(result)
    if state != .ready { cacheBox.forceState(state) }
  }

  /// Deterministic, idempotent shutdown; never throws.
  public func shutdown() async {
    if cacheBox.currentState() == .shutdown { return }
    await adapter.shutdown()
    cacheBox.clear()
  }

  // MARK: - helpers

  private static func lifecycleError(state: LifecycleState, initError: FireweaveError?)
    -> FireweaveError?
  {
    switch state {
    case .ready, .stale: return nil
    case .shutdown: return FireweaveError(kind: .alreadyClosed)
    case .error, .fatal: return initError ?? FireweaveError(kind: .backendUnavailable)
    case .uninitialized, .initializing: return FireweaveError(kind: .notReady)
    }
  }

  private static func errorDecision(_ defaultValue: JSONValue, _ error: FireweaveError) -> Decision
  {
    var metadata: FlagMetadata = [flagMetadataErrorKindKey: .string(error.kind.rawValue)]
    if error.kind == .flagNotFound && error.quotaLimited {
      metadata["fireweave.quotaLimited"] = .bool(true)
    }
    return Decision(
      value: defaultValue,
      reason: .error,
      errorCode: error.openFeatureErrorCode,
      errorMessage: error.message,
      errorKind: error.kind,
      flagMetadata: metadata
    )
  }
}

/// Lock-guarded holder for the global/client context layers — separate from
/// `ControlPointsCacheBox` (which guards lifecycle state + the prefetched
/// cache) because context layers change on a different rhythm (sign-in,
/// `setContext`) than the cache does (prefetch completion), and keeping them
/// as two small locks rather than one bigger one avoids `evaluate()`'s
/// context-merge step contending with a concurrent `cacheBox.apply()` (or
/// vice versa) for no reason — the two are read together but never need to
/// be read ATOMICALLY with respect to each other (a torn read across the two
/// only ever means "this one evaluation saw the context from just before or
/// just after a `setContext` call", which is the same race every other
/// language's SDK has too).
final class ContextBox: @unchecked Sendable {
  private let lock = NSLock()
  private var global: EvaluationContext?
  private var client: EvaluationContext?

  init(global: EvaluationContext?) {
    self.global = global
  }

  func snapshot() -> (global: EvaluationContext?, client: EvaluationContext?) {
    lock.withLock { (global, client) }
  }

  func setClient(_ context: EvaluationContext?) {
    lock.withLock { client = context }
  }

  func mergeIntoGlobal(_ context: EvaluationContext) {
    lock.withLock { global = mergeContexts([global, context]) }
  }
}
