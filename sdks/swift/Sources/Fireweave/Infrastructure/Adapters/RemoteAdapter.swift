import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Fireweave remote backend adapter — default production path.
///
/// Real HTTP client (`URLSession`, part of Foundation — no third-party HTTP
/// package) for fw-server `POST /v1/flags/evaluate` and
/// `POST /v1/targets/register`. Auth: `Authorization: Bearer <apiKey>`.
/// Speaks only the vendor-neutral Fireweave remote protocol
/// (`spec/remote-protocol.md`) — no vendor SDK, key, or host ever enters the
/// application process.
///
/// `prefetch` is the ONE place this adapter does network I/O — never a
/// per-call `evaluate()`, which is why the read surface can be synchronous
/// (see `Ports.swift`'s doc comment). One `POST /v1/flags/evaluate` fetches
/// every decision for a context in a single round trip; `FireweaveRuntime`
/// then reads the resulting cache synchronously.
public struct RemoteAdapterConfig: Sendable {
  public var apiUrl: String
  public var apiKey: String
  /// `nil` means the adapter-level fallback (`defaultAllowedHosts(for:)`):
  /// the URL's own hostname plus loopback — NOT the canonical
  /// `defaultAllowedHosts` list. `initFireweave` (the sanctioned entry
  /// point) already enforces the stricter canonical default before this
  /// adapter is ever constructed; this fallback only matters for direct
  /// adapter construction that bypasses `initFireweave` (as the
  /// conformance runner deliberately does for host-allowlist fixtures).
  public var allowedHosts: [String]?
  public var requestTimeoutMs: Int

  public init(
    apiUrl: String,
    apiKey: String,
    allowedHosts: [String]? = nil,
    requestTimeoutMs: Int = 3_000
  ) {
    self.apiUrl = apiUrl
    self.apiKey = apiKey
    self.allowedHosts = allowedHosts
    self.requestTimeoutMs = requestTimeoutMs
  }
}

/// Injectable HTTP transport (tests / the conformance runner's loopback
/// fault stub). Production uses `URLSessionTransport`, a thin wrapper over
/// `URLSession`.
public protocol RemoteHTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: RemoteHTTPTransport {
  private let session: URLSession

  public init(requestTimeoutMs: Int) {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = Double(requestTimeoutMs) / 1000.0
    self.session = URLSession(configuration: config)
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw FireweaveError(kind: .malformedResponse)
    }
    return (data, http)
  }
}

public final class FireweaveRemoteAdapter: ControlPointsBackendAdapter, @unchecked Sendable {
  private static let evaluatePath = "/v1/flags/evaluate"
  private static let registerTargetPath = "/v1/targets/register"

  private let lock = NSLock()
  private var apiUrl: String
  private let apiKey: String
  private let allowedHosts: [String]?
  private let transport: RemoteHTTPTransport
  private var ready = false
  private var closed = false

  public init(config: RemoteAdapterConfig, transport: RemoteHTTPTransport? = nil) {
    self.apiUrl = config.apiUrl
    self.apiKey = config.apiKey
    self.allowedHosts = config.allowedHosts
    self.transport = transport ?? URLSessionTransport(requestTimeoutMs: config.requestTimeoutMs)
  }

  public let missReason: DecisionReason? = nil

  public func isClosed() -> Bool {
    lock.withLock { closed }
  }

  public func initialize() async throws {
    let (wasClosed, currentUrl) = lock.withLock { (closed, apiUrl) }
    if wasClosed {
      throw FireweaveError(kind: .alreadyClosed)
    }

    let trimmed = currentUrl.hasSuffix("/") ? String(currentUrl.dropLast()) : currentUrl
    guard !trimmed.isEmpty, !apiKey.isEmpty else {
      throw FireweaveError.configuration("invalid configuration", initFatal: true)
    }
    let allow = (allowedHosts?.isEmpty == false) ? allowedHosts : defaultAllowedHosts(for: trimmed)
    try assertHostAllowed(trimmed, allowedHosts: allow, initFatal: true)

    lock.withLock {
      apiUrl = trimmed
      ready = true
    }
  }

  private func request(path: String, body: JSONValue) async throws -> JSONValue {
    let (currentReady, currentClosed, url, key) = lock.withLock { (ready, closed, apiUrl, apiKey) }

    guard !currentClosed else { throw FireweaveError(kind: .alreadyClosed) }
    guard currentReady else { throw FireweaveError(kind: .notReady) }

    guard let requestURL = URL(string: url + path) else {
      throw FireweaveError(kind: .malformedResponse)
    }
    var urlRequest = URLRequest(url: requestURL)
    urlRequest.httpMethod = "POST"
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    urlRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body.toFoundationAny())

    let (data, response): (Data, HTTPURLResponse)
    do {
      (data, response) = try await transport.send(urlRequest)
    } catch let error as FireweaveError {
      throw error
    } catch let urlError as URLError {
      throw Self.mapURLError(urlError)
    } catch {
      throw FireweaveError(kind: .network)
    }

    switch response.statusCode {
    case 200...299:
      break
    case 401: throw FireweaveError(kind: .authentication)
    case 403: throw FireweaveError(kind: .authorization)
    case 429: throw FireweaveError(kind: .rateLimited)
    default: throw FireweaveError(kind: .backendUnavailable)
    }

    guard let parsed = try? JSONValue.parse(data: data), parsed.isObject else {
      throw FireweaveError(kind: .malformedResponse)
    }
    return parsed
  }

  private static func mapURLError(_ error: URLError) -> FireweaveError {
    switch error.code {
    case .timedOut: return FireweaveError(kind: .timeout)
    default: return FireweaveError(kind: .network)
    }
  }

  /// **Spec-ambiguity finding.** A missing `targetingKey` at PREFETCH time
  /// returns an EMPTY batch rather than throwing — deliberately different
  /// from node/go/java/rust's per-call `resolve()`, which throws
  /// `targetingKeyMissing()` unconditionally, because in THIS architecture
  /// `FireweaveRuntime.initialize()` always triggers an immediate prefetch
  /// (`refresh()`), even before any real identity is known (an anonymous
  /// pre-sign-in boot, or `life-init-success`'s fixture, which supplies no
  /// context at all and simply expects `initialize()` to reach READY).
  /// The other languages never hit this case at boot, because they only
  /// call `resolve()` lazily, per real `evaluate()` call with a real
  /// context — this SDK's "prefetch on initialize" design (the Phase 6
  /// controller ruling) has no equivalent lazy point to defer to. Throwing
  /// here would incorrectly conflate "no identity yet" (a normal, expected
  /// state before sign-in) with "the backend is broken" (`.error`), and
  /// would make an anonymous boot structurally impossible to reach READY.
  /// The `requireTargetingKey` config flag — enforced once, centrally, by
  /// `Domain/Validation.swift`'s `validateContext` at EVALUATE time — is
  /// the single, already-existing authority for whether a missing
  /// targeting key must be fatal for a given deployment; this adapter no
  /// longer duplicates that policy with a hardcoded, unconditional
  /// requirement of its own. A subsequent `identify()`/`setContext()` call
  /// with a real targeting key triggers a real `refresh()`, which DOES
  /// reach the network with a populated batch.
  public func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult
  {
    guard let targetingKey = context.targetingKey, !targetingKey.isEmpty else {
      return [:]
    }

    var body: [String: JSONValue] = ["targetingKey": .string(targetingKey)]
    if let flagKeys = options?.flagKeys {
      body["flagKeys"] = .array(flagKeys.map(JSONValue.string))
    }

    var attributes: [String: JSONValue] = [:]
    var groups: JSONValue?
    var groupProperties: JSONValue?
    for (key, value) in context.attributes {
      if key == "groups" || key == "fireweave.groups", value.isObject {
        groups = value
        continue
      }
      if key == "groupProperties" || key == "fireweave.groupProperties", value.isObject {
        groupProperties = value
        continue
      }
      if key.hasPrefix("$") || key.hasPrefix("fireweave.") { continue }
      attributes[key] = value
    }
    if !attributes.isEmpty { body["attributes"] = .object(attributes) }
    if let groups { body["groups"] = groups }
    if let groupProperties { body["groupProperties"] = groupProperties }

    let data = try await request(path: Self.evaluatePath, body: .object(body))
    let decisions = data.objectValue?["decisions"]?.arrayValue ?? []
    let quotaLimited = data.objectValue?["quotaLimited"]?.boolValue ?? false

    var result: PrefetchResult = [:]
    for item in decisions {
      guard let obj = item.objectValue, let flagKey = obj["flagKey"]?.stringValue else { continue }
      // "found: false" on the wire means genuinely unknown to the
      // backend — leave the key OUT of the batch entirely (this
      // adapter's `missReason` is `nil`, so an absent key resolves to
      // `.error`/`.flagNotFound` at read time), rather than inserting
      // an `AdapterResolution(found: false, ...)` — that shape is
      // reserved for InMemoryAdapter's "conditions didn't match"
      // signal (see `AdapterResolution`'s doc comment); the remote
      // wire protocol has no analogous "matched" concept; a decision
      // present in the array always means fw-server already applied
      // targeting server-side.
      if obj["found"]?.boolValue == false { continue }

      let meta = obj["flagMetadata"]?.objectValue
      result[flagKey] = AdapterResolution(
        found: true,
        enabled: obj["enabled"]?.boolValue ?? true,
        value: obj["value"] ?? .null,
        variant: obj["variant"]?.stringValue,
        reason: obj["reason"]?.stringValue.flatMap(DecisionReason.init(rawValue:)),
        reasonCode: meta?["fireweave.reasonCode"]?.stringValue,
        version: meta?["fireweave.flagVersion"]?.numberValue.map(Int.init),
        vendorFlagId: meta?["fireweave.vendorFlagId"]?.numberValue.map(Int.init),
        payload: obj["payload"].flatMap { $0.isNull ? nil : $0 },
        fromCache: false
      )
    }
    if quotaLimited {
      // Quota-limited responses resolve as FlagNotFound with
      // fireweave.quotaLimited metadata (`contracts/errors.json`) —
      // modeled here as an empty batch for any key not already present
      // (the runtime's absent-key path throws FlagNotFound; the
      // quota flag itself is surfaced via the thrown error below when
      // the WHOLE batch is quota-limited and returned nothing).
      if result.isEmpty {
        throw FireweaveError.flagNotFound(quotaLimited: true)
      }
    }
    return result
  }

  /// Never throws for transport failures: registration sits in sign-in
  /// paths, and an analytics call must not break sign-in. Retried ONCE
  /// when the error taxonomy marks the failure retryable; a rejected
  /// payload or bad key is not retried, since it would be rejected
  /// identically.
  public func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult
  {
    let (currentClosed, currentReady) = lock.withLock { (closed, ready) }
    if currentClosed { return .failure(FireweaveError(kind: .alreadyClosed)) }
    if !currentReady { return .failure(FireweaveError(kind: .notReady)) }
    if targetingKey.isEmpty { return .failure(.targetingKeyMissing()) }

    var body: [String: JSONValue] = ["targetingKey": .string(targetingKey)]
    if let kind = options?.kind { body["kind"] = .string(kind.rawValue) }
    if let environment = options?.environment { body["environment"] = .string(environment) }
    if let properties = options?.properties, !properties.isEmpty {
      body["properties"] = .object(properties)
    }

    var lastError: FireweaveError?
    for _ in 0..<2 {
      do {
        _ = try await request(path: Self.registerTargetPath, body: .object(body))
        return .success()
      } catch let error as FireweaveError {
        lastError = error
        if !error.isRetryable { break }
      } catch {
        lastError = FireweaveError(kind: .internalError)
        break
      }
    }
    return .failure(lastError ?? FireweaveError(kind: .internalError))
  }

  public func shutdown() async {
    lock.withLock {
      closed = true
      ready = false
    }
  }
}
