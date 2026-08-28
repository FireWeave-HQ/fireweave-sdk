/// `initFireweave` — the single SDK entry point (`spec/modes.md`).
///
/// `mode` is required and never inferred: a missing or mistyped credential
/// must fail loudly at boot, not silently fall back to local evaluation —
/// that failure mode looks like a green boot and a feature that never
/// ramps. This is the SANCTIONED composition root (mirrors rust's
/// `application::mode`/node's `application/mode.ts`): the only file under
/// `Application/` that references concrete `Infrastructure/Adapters/*`
/// types (`Tests/FireweaveTests/ArchitectureGuardTests.swift`'s
/// layer-direction scan exempts exactly this file).
///
/// Initialisation fails loudly (`throws`); reads on the returned client
/// never do (`spec/control-points.md` "initialise is the exception").
///
/// ## A note on `FireweaveRuntime.initialize()` never throwing
///
/// `FireweaveRuntime.initialize()` is deliberately fail-OPEN — a hung or
/// failing prefetch must not block app boot (`ADR-0009` "Fail-open, not
/// fail-silent"), so it swallows adapter failures into `.fatal`/`.error`/
/// `.stale` state instead of throwing. That non-throwing contract is
/// correct for TRANSIENT failures (the network happened to be down) but
/// wrong for the four Configuration rows below, which `spec/modes.md`
/// requires to fail loudly at boot. This function closes that gap in two
/// parts: `validateInitOptions` (`Domain/Validation.swift`) covers rows
/// 1/2/4 (mode absent, remote apiKey/apiUrl blank, local combined with
/// credentials); `assertHostAllowed` covers row 3 (the host allowlist) with
/// a direct, SYNCHRONOUS call, before ever calling into the runtime — that
/// call is what makes a bad host fail LOUDLY here, because the runtime
/// itself deliberately never throws. A genuinely transient prefetch failure
/// (host is fine, network hiccups) still resolves into `.error`/`.stale`
/// rather than throwing — that fail-open behaviour is unchanged and is not
/// one of the four rows.
public struct InitFireweaveRemoteOptions: Sendable {
  /// Evaluate against fw-server over the network (`spec/remote-protocol.md`).
  public var mode: Mode { .remote }
  /// Fireweave project key. Required — never read from the environment.
  public var apiKey: String
  /// fw-server base URL. Required — never read from the environment.
  public var apiUrl: String
  /// SSRF/misconfiguration allowlist override (`spec/modes.md` "apiUrl
  /// fails the host allowlist"). Default: the canonical Fireweave hosts +
  /// loopback (`defaultAllowedHosts`). A self-hosted fw-server must list
  /// its own host explicitly; `["*"]` opts out.
  public var allowedHosts: [String]?
  public var requestTimeoutMs: Int
  /// Initial evaluation context (e.g. an anonymous targetingKey) to
  /// prefetch under.
  public var context: EvaluationContext?

  public init(
    apiKey: String,
    apiUrl: String,
    allowedHosts: [String]? = nil,
    requestTimeoutMs: Int = 3_000,
    context: EvaluationContext? = nil
  ) {
    self.apiKey = apiKey
    self.apiUrl = apiUrl
    self.allowedHosts = allowedHosts
    self.requestTimeoutMs = requestTimeoutMs
    self.context = context
  }
}

public struct InitFireweaveLocalOptions: Sendable {
  public var mode: Mode { .local }
  /// Per-key boolean overrides — the seeded local map. A present key
  /// resolves with reason `.staticReason`; an absent key misses so the
  /// caller's own default is used. May be empty or omitted entirely.
  public var controlPoints: [String: Bool]
  /// Sink for the `[fireweave:local]` `registerTarget` trace line
  /// (`spec/modes.md` "registerTarget in local mode"). `nil` means the
  /// adapter's own default (stderr).
  public var log: LogSink?
  /// Initial evaluation context (e.g. an anonymous targetingKey) to
  /// prefetch under.
  public var context: EvaluationContext?

  public init(
    controlPoints: [String: Bool] = [:], log: LogSink? = nil, context: EvaluationContext? = nil
  ) {
    self.controlPoints = controlPoints
    self.log = log
    self.context = context
  }
}

/// The full initialisation-options shape (`spec/modes.md`).
///
/// A caller passes EXACTLY ONE case — `mode` is fixed by which case they
/// construct, matching node/web's tagged-union approach (rather than rust/
/// go/java's flat struct with an optional `mode` field): Swift's `enum` with
/// associated values makes "mode absent" (`InitOptions` itself is never
/// optional; a caller must pick a case) and "local combined with remote
/// credentials" (the `.local` case's payload has no `apiKey`/`apiUrl`
/// fields to combine) BOTH unrepresentable by construction for two of the
/// four Configuration rows — `validateInitOptions` below still re-validates
/// all four for a single, auditable, cross-language-comparable code path
/// (and because `remote`'s own blank-apiKey/apiUrl row IS representable:
/// `InitFireweaveRemoteOptions.apiKey` is a plain `String`, not a
/// non-empty-by-construction type).
public enum InitFireweaveOptions: Sendable {
  case remote(InitFireweaveRemoteOptions)
  case local(InitFireweaveLocalOptions)
}

private func modeAndCredentials(_ options: InitFireweaveOptions) -> (Mode, String?, String?) {
  switch options {
  case .remote(let opts): return (.remote, opts.apiKey, opts.apiUrl)
  case .local: return (.local, nil, nil)
  }
}

private func initLocal(_ options: InitFireweaveLocalOptions) async -> FireweaveClient {
  let adapter = FireweaveLocalAdapter(devFlags: options.controlPoints, log: options.log)
  let runtime = FireweaveRuntime(adapter: adapter)
  let client = FireweaveClient(runtime: runtime)
  await client.initialize(context: options.context)
  return client
}

private func initRemote(_ options: InitFireweaveRemoteOptions) async throws -> FireweaveClient {
  // `validateInitOptions` (called by `initFireweave`, below) has already
  // ruled out blank apiKey/apiUrl by the time this runs — only the host
  // allowlist row remains to check here. This call — not
  // `runtime.initialize()` — is what makes a bad host fail LOUDLY here,
  // because the runtime itself deliberately never throws (see the module
  // doc comment).
  try assertHostAllowed(options.apiUrl, allowedHosts: options.allowedHosts, initFatal: true)

  let adapter = FireweaveRemoteAdapter(
    config: RemoteAdapterConfig(
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      allowedHosts: options.allowedHosts,
      requestTimeoutMs: options.requestTimeoutMs
    )
  )
  let runtime = FireweaveRuntime(adapter: adapter)
  let client = FireweaveClient(runtime: runtime)
  await client.initialize(context: options.context)
  return client
}

/// Builds the adapter matching `options`'s mode and brings a
/// `FireweaveClient` up.
///
/// Throws `FireweaveError(kind: .configuration)` for every row of the
/// initialisation-validation table (`spec/modes.md`) this SDK can
/// represent:
///  - `mode` absent — unrepresentable here (a caller must pick `.remote` or
///    `.local`); see `Mode.swift`'s doc comment for why "unrecognised" has
///    no Swift analogue either (recurrence of rust finding 3).
///  - `mode: .remote` with `apiKey`/`apiUrl` missing/blank.
///  - `apiUrl` fails the host allowlist.
///  - `mode: .local` with credentials supplied — unrepresentable here too
///    (`.local`'s payload has no credential fields), but `validateInitOptions`
///    still re-checks it for cross-language parity (see the type doc
///    comment above).
public func initFireweave(_ options: InitFireweaveOptions) async throws -> FireweaveClient {
  let (mode, apiKey, apiUrl) = modeAndCredentials(options)
  if case .failure(let error) = validateInitOptions(mode: mode, apiKey: apiKey, apiUrl: apiUrl) {
    throw error
  }
  switch options {
  case .local(let opts): return await initLocal(opts)
  case .remote(let opts): return try await initRemote(opts)
  }
}
