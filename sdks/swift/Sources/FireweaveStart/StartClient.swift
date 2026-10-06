import Fireweave

/// Builds the core client for a resolved start, with `initFireweave`, the
/// core's own entry point, so the core's initialisation table runs
/// unchanged.
///
/// The one exception is the `transport` test seam: `initFireweave` takes no
/// transport, so with one the remote client is composed here from the same
/// public parts, after the same two checks `initFireweave` makes
/// (`validateInitOptions` and `assertHostAllowed`). This is the only file in
/// the module that names a concrete adapter.
func makeStartClient(
  _ config: ResolvedStart,
  subject: String,
  transport: (any RemoteHTTPTransport)?,
  log: @escaping LogSink
) async throws -> FireweaveClient {
  let context = EvaluationContext(targetingKey: subject)
  switch config.mode {
  case .local:
    let options = InitFireweaveLocalOptions(
      controlPoints: localSeeds(config.controlPoints),
      log: log,
      context: context
    )
    return try await initFireweave(.local(options))
  case .remote:
    guard let key = config.key, let url = config.url else {
      throw startConfigurationError("remote mode was resolved without a key or an endpoint.")
    }
    guard let transport else {
      let options = InitFireweaveRemoteOptions(
        apiKey: key,
        apiUrl: url,
        allowedHosts: config.allowedHosts,
        context: context
      )
      return try await initFireweave(.remote(options))
    }
    if case .failure(let error) = validateInitOptions(mode: .remote, apiKey: key, apiUrl: url) {
      throw error
    }
    let hosts = config.allowedHosts ?? defaultAllowedHosts
    try assertHostAllowed(url, allowedHosts: hosts, initFatal: true)
    let adapter = FireweaveRemoteAdapter(
      config: RemoteAdapterConfig(apiUrl: url, apiKey: key, allowedHosts: hosts),
      transport: transport
    )
    let client = FireweaveClient(runtime: FireweaveRuntime(adapter: adapter))
    await client.initialize(context: context)
    return client
  }
}
