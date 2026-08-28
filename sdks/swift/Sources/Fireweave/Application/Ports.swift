/// Backend adapter boundary (mirrors `sdks/web`'s `WebBackendAdapter` —
/// ADR-0009's seam, studied for the shape, built from the spec).
///
/// One shape difference from node/go/java/rust's per-call `resolve(key)`
/// port is the whole reason swift can offer a synchronous `evaluate()`: this
/// port has `prefetch(context:)`, which returns EVERY decision for a context
/// in one round trip. Evaluation then becomes a synchronous, lock-guarded
/// map lookup in `FireweaveRuntime` — never an adapter call.
///
/// The reason is not performance, it is the "controller ruling" this task
/// was given: a UI thread cannot await inside a render path, so nothing on
/// the read surface may need to suspend. Both `FireweaveLocalAdapter` and
/// `FireweaveRemoteAdapter` implement this SAME port (`spec/modes.md`:
/// "Both modes expose the identical nine methods with identical
/// signatures"), so `FireweaveRuntime`/`FireweaveClient` stay mode-blind.

/// Every decision the backend returned for one context, keyed by control
/// point.
public typealias PrefetchResult = [String: AdapterResolution]

public struct PrefetchOptions: Sendable, Equatable {
  /// Restrict the batch to these keys; omit to let the backend return all
  /// it knows.
  public var flagKeys: [String]?

  public init(flagKeys: [String]? = nil) {
    self.flagKeys = flagKeys
  }
}

/// Vendor-neutral outcome of resolving one flag, as returned in a
/// `PrefetchResult` batch.
///
/// **`found` has a dual meaning that callers must not conflate** (a genuine
/// design question this batch-shaped port raises that rust's per-key
/// `Result<FlagResolution, FireweaveError>` port never had to answer, since
/// `Err` gave it a THIRD channel for "key genuinely unknown"):
///
/// 1. **Present in the map with `found: false`** — the definition EXISTS but
///    its targeting conditions did not select this caller
///    (`InMemoryAdapter`'s matchAttribute/matchGroups/matchPerson/
///    matchTargetingKey). `FireweaveRuntime.evaluate` reads this as
///    `.defaultReason` UNCONDITIONALLY — "no decision for this key/context"
///    is a claim about the flag's own targeting, not about the adapter's
///    miss policy, so it applies the same way regardless of which adapter
///    produced it.
/// 2. **ABSENT from the map entirely** — governed by
///    `ControlPointsBackendAdapter.missReason`: `FireweaveLocalAdapter`
///    reports `.defaultReason` here too (`spec/modes.md` "Behaviour per
///    mode": local mode's unknown-key row), while `FireweaveRemoteAdapter`/
///    `InMemoryAdapter` leave `missReason` `nil` and an absent key resolves
///    to `.error`/`.flagNotFound` instead.
///
/// A resolution is only ever constructed with `found: false` for case 1 —
/// case 2 is expressed by simply never inserting a key into the
/// `PrefetchResult` dictionary, never by inserting a `found: false` entry.
///
/// `vendorFlagId`/`reasonCode` are a PRE-GATED pair
/// (`spec/decision.schema.json` `standardMetadataKeys`, ruling 11): the
/// runtime emits `fireweave.vendorFlagId`/`fireweave.reasonCode` together,
/// or neither — never one alone. There is deliberately no separate
/// `conditionIndex` field here, mirroring rust's post-review fix
/// (task-12-report.md fix-report finding 1): that gate is a statement about
/// what the BACKEND reported, and the one place that raw signal exists as
/// adapter input is `InMemoryAdapter` (fixture `reason.conditionIndex`),
/// which applies the gate itself before constructing the `AdapterResolution`
/// it returns — see `InMemoryAdapter.swift`.
public struct AdapterResolution: Sendable, Equatable {
  public var found: Bool
  public var enabled: Bool?
  public var value: JSONValue?
  public var variant: String?
  public var flagType: FlagType?
  public var reason: DecisionReason?
  public var reasonCode: String?
  public var version: Int?
  public var vendorFlagId: Int?
  public var payload: JSONValue?
  public var fromCache: Bool

  public init(
    found: Bool = true,
    enabled: Bool? = nil,
    value: JSONValue? = nil,
    variant: String? = nil,
    flagType: FlagType? = nil,
    reason: DecisionReason? = nil,
    reasonCode: String? = nil,
    version: Int? = nil,
    vendorFlagId: Int? = nil,
    payload: JSONValue? = nil,
    fromCache: Bool = false
  ) {
    self.found = found
    self.enabled = enabled
    self.value = value
    self.variant = variant
    self.flagType = flagType
    self.reason = reason
    self.reasonCode = reasonCode
    self.version = version
    self.vendorFlagId = vendorFlagId
    self.payload = payload
    self.fromCache = fromCache
  }
}

public struct RegisterTargetOptions: Sendable, Equatable {
  public var kind: TargetKind?
  public var properties: [String: JSONValue]?
  public var environment: String?

  public init(
    kind: TargetKind? = nil, properties: [String: JSONValue]? = nil, environment: String? = nil
  ) {
    self.kind = kind
    self.properties = properties
    self.environment = environment
  }
}

/// Outcome of target registration.
///
/// `ok: false` means the target was NOT registered — rules that depend on
/// its properties will not match until a later attempt succeeds. Callers in
/// a sign-in path normally ignore this; a careful caller logs it — a
/// silently unregistered target is exactly how targeting rules end up
/// matching nobody.
public struct RegisterTargetResult: Sendable, Equatable {
  public var ok: Bool
  public var error: FireweaveError?

  public static func success() -> RegisterTargetResult {
    RegisterTargetResult(ok: true, error: nil)
  }
  public static func failure(_ error: FireweaveError) -> RegisterTargetResult {
    RegisterTargetResult(ok: false, error: error)
  }
}

/// `evaluate()`'s reserved fifth argument
/// (`conformance/surface/control-points.surface.json`:
/// `evaluate(key, type, default, context?, options?)`).
///
/// `includePayload` is FUNCTIONAL here (unlike `sdks/web`'s inert
/// `EvaluateOptions`, whose doc comment explains it has no in-flight I/O to
/// carry a `signal` for and no per-call exposure opt-in) — a deliberate
/// divergence from the web precedent studied for the sync/async SEAM, not
/// an oversight: payload attachment is genuine v1 SURFACE (`Decision
/// .flagMetadata["fireweave.payload"]`, never cut like releases/exposures/
/// signals), swift runs the shared 65 fixtures for real
/// (`eval-payload-attached`), and `AdapterResolution.payload` already
/// carries the raw payload all the way from prefetch to this struct with no
/// architectural obstacle — there is no reason to leave a real, in-scope
/// capability inert just because web's separate, remote-only suite had no
/// occasion to exercise it. `signal`/`sendExposure` remain genuinely N/A for
/// the same reasons web's doc comment gives (no in-flight I/O to abort;
/// exposure recording is out of v1 scope entirely).
public struct EvaluateOptions: Sendable, Equatable {
  public var includePayload: Bool

  public init(includePayload: Bool = false) {
    self.includePayload = includePayload
  }
}

/// Protocol every Fireweave backend adapter implements. `Sendable` because a
/// `FireweaveRuntime` (itself `Sendable`, see `Runtime.swift`) holds one
/// across concurrency domains.
public protocol ControlPointsBackendAdapter: Sendable {
  /// Miss-reason override for a control point ABSENT from the prefetch
  /// result (`spec/modes.md` "Behaviour per mode": local mode's
  /// unknown-key row is `default`/reason `DEFAULT`, not an error — unlike
  /// remote's `default`/`ERROR`/`FlagNotFound`). `FireweaveLocalAdapter`
  /// returns `.defaultReason` here; `FireweaveRemoteAdapter` and
  /// `InMemoryAdapter` return `nil` and keep the FlagNotFound/ERROR path.
  var missReason: DecisionReason? { get }

  /// Bring the backend to a usable state. Throws `FireweaveError` on fatal
  /// config.
  func initialize() async throws

  /// Fetch every decision for a context in one round trip. Throws
  /// `FireweaveError` on transport faults.
  func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult

  /// Register a target. Resolves rather than throws — this runs in
  /// sign-in paths, where a targeting concern must not break
  /// authentication.
  func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult

  /// Deterministically release resources. Idempotent; must never throw.
  func shutdown() async
}
