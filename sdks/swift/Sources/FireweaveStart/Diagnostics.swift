import Fireweave
import Foundation

/// Why a running client is not serving fresh decisions.
struct RemoteFailure: Sendable, Equatable {
  var error: FireweaveError
  /// The core keeps serving the decisions of an earlier successful fetch
  /// (state `STALE`) rather than the callers' defaults.
  var servingLastGood: Bool
}

/// The failure behind the runtime's state, if it has one: the stored cause
/// of an `ERROR` state, or the failed re-fetch behind a `STALE` one. A
/// ceiling loss carries no error, so it reports nothing.
func currentFailure(_ runtime: FireweaveRuntime) -> RemoteFailure? {
  switch runtime.state() {
  case .error, .fatal:
    guard let error = runtime.initializationError() else { return nil }
    return RemoteFailure(error: error, servingLastGood: false)
  case .stale:
    guard let error = runtime.lastRefreshError() else { return nil }
    return RemoteFailure(error: error, servingLastGood: true)
  case .uninitialized, .initializing, .ready, .shutdown:
    return nil
  }
}

/// The one line a kind of fw-server failure logs (SP-27), and the group it
/// is logged once under for the life of the process.
struct RemoteDiagnosis: Sendable, Equatable {
  var group: String
  var line: String
}

/// What to say about `failure`: the key was refused (401, 403), rate-limited
/// (429), fw-server could not be reached (network, timeout, 5xx) or did not
/// answer like fw-server. Lines name the key's source and the endpoint's
/// host and source, never a value. Nil in local mode and for a failure that
/// is not about fw-server's answer.
func remoteDiagnosis(_ failure: RemoteFailure, config: ResolvedStart) -> RemoteDiagnosis? {
  guard config.mode == .remote else { return nil }
  let host = config.url.flatMap { URLComponents(string: $0)?.host } ?? "fw-server"
  let keySource = config.keySource
  let urlSource = config.urlSource ?? "the SDK channel"
  let serve: String
  if failure.servingLastGood {
    serve = "Reads keep serving the last decisions fetched (reason STALE)"
  } else {
    serve = "Reads serve their defaults"
  }
  switch failure.error.kind {
  case .authentication:
    let line = phrase(
      "[fireweave] fw-server at \(host) rejected the key from \(keySource) (HTTP 401): it is",
      "wrong, revoked or from another project. \(serve)."
    )
    return RemoteDiagnosis(group: "key-rejected-401", line: line)
  case .authorization:
    let line = phrase(
      "[fireweave] fw-server at \(host) refused the key from \(keySource) for this project or",
      "environment (HTTP 403). \(serve)."
    )
    return RemoteDiagnosis(group: "key-rejected-403", line: line)
  case .rateLimited:
    let line = phrase(
      "[fireweave] fw-server at \(host) rate-limited the key from \(keySource) (HTTP 429).",
      "\(serve) until a later request succeeds."
    )
    return RemoteDiagnosis(group: "rate-limited", line: line)
  case .network, .timeout, .backendUnavailable:
    let line = phrase(
      "[fireweave] Could not reach fw-server at \(host) (endpoint from \(urlSource)): offline,",
      "a firewall, or the wrong endpoint. \(serve)."
    )
    return RemoteDiagnosis(group: "unreachable", line: line)
  case .malformedResponse:
    let line = phrase(
      "[fireweave] fw-server at \(host) (endpoint from \(urlSource)) did not answer like",
      "fw-server: check the endpoint. \(serve)."
    )
    return RemoteDiagnosis(group: "unexpected-response", line: line)
  case .notReady, .flagNotFound, .typeMismatch, .invalidContext, .unsupportedCapability,
    .configuration, .alreadyClosed, .internalError:
    return nil
  }
}
