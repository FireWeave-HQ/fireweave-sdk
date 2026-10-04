import Fireweave
import Foundation

/// The process-wide start state behind `fw`.
///
/// One `StartCore` lives for the life of the process (tests build their own
/// with injected `StartSources`). `startFireweave` resolves the configuration
/// synchronously and starts the core client in a detached task; until that
/// client is installed, reads are answered here: local mode from the flags,
/// remote mode with the caller's default (`NotReady`).
///
/// `@unchecked Sendable`: every mutable property is guarded by `lock`. No
/// lock is held across an `await`, while logging, or while calling into the
/// core except for its own non-blocking state reads, so a log sink or a
/// concurrent read can never deadlock against a start.
final class StartCore: @unchecked Sendable {
  private enum Phase: Equatable {
    case notStarted
    case running
    case failed
    case shutdown
  }

  /// One start, from `startFireweave` until the next start or shutdown.
  private struct Run {
    var generation: UInt64
    var config: ResolvedStart
    var signature: StartSignature
    /// The flags' local values, answered before the local client exists.
    var seeds: [String: Bool]
    /// The anonymous key: the device id (app) or the instance key (server).
    var subject: String
    /// The key the current decisions were prefetched under.
    var currentKey: String
    var persistence: FireweavePersistence
    var appSuppliedDeviceId: Bool
    var store: any DeviceIdStoring
    var task: Task<Void, Never>?
    var client: FireweaveClient?
    var failure: FireweaveError?
  }

  /// A snapshot of the running client, for work done outside the lock.
  private struct RunningClient: Sendable {
    var client: FireweaveClient
    var generation: UInt64
    var profile: FireweaveProfile
    var subject: String
  }

  private let lock = NSLock()
  private let sources: StartSources
  private let chain = OperationChain()
  private var phase = Phase.notStarted
  /// Bumped by every start and shutdown, so a late result from an older
  /// start is discarded.
  private var generation: UInt64 = 0
  private var run: Run?
  private var warned: Set<String> = []
  private var logSink: LogSink?
  /// The server instance key handed out so far. It identifies the process,
  /// so it outlives a run.
  private var instanceKeyCache: String?
  private var listeners: [UUID: AsyncStream<FireweaveStartState>.Continuation] = [:]

  init(sources: StartSources) {
    self.sources = sources
  }

  // MARK: - start

  func start(_ options: FireweaveStartOptions) throws {
    let profile = options.profile ?? sources.platformProfile
    var env = sources.env
    if let custom = options.env {
      env = trimmingLookup(custom)
    }
    var infoPlist = sources.infoPlist
    if let custom = options.infoPlist {
      infoPlist = trimmingLookup(custom)
    }
    let lookups = StartLookups(env: env, infoPlist: infoPlist, isDebugBuild: sources.isDebugBuild)
    let config = try resolveStart(
      options,
      profile: profile,
      lookups: lookups,
      channel: sources.channel,
      sdkVersion: sources.sdkVersion
    )
    let signature = StartSignature(
      config: config,
      deviceId: profile == .app ? nonBlank(options.deviceId) : nil,
      instanceId: profile == .server ? nonBlank(options.instanceId) : nil
    )
    var lines: [LogLine] = []
    let outcome = lock.locked { () -> Result<Void, FireweaveError> in
      beginLocked(config, signature: signature, options: options, lookups: lookups, lines: &lines)
    }
    emit(lines)
    try outcome.get()
  }

  private func beginLocked(
    _ config: ResolvedStart,
    signature: StartSignature,
    options: FireweaveStartOptions,
    lookups: StartLookups,
    lines: inout [LogLine]
  ) -> Result<Void, FireweaveError> {
    if phase == .running, let current = run {
      let changed = current.signature.differences(from: signature)
      if changed.isEmpty { return .success(()) }
      let fields = changed.joined(separator: ", ")
      return .failure(
        startConfigurationError(
          "startFireweave was already called with a different configuration (\(fields))."
            + " Call startFireweave once, at launch."
        )
      )
    }

    // A server never touches UserDefaults.
    var store: any DeviceIdStoring = DiscardingDeviceIdStore()
    if config.profile == .app {
      store = sources.makeStore()
    }
    let subject: String
    var appSupplied = false
    switch config.profile {
    case .server:
      if let id = signature.instanceId, let handedOut = instanceKeyCache, handedOut != id {
        return .failure(
          startConfigurationError(
            "startFireweave(instanceId:) differs from the instanceKey() already handed out."
              + " Pass instanceId on the first startFireweave."
          )
        )
      }
      if let id = signature.instanceId {
        subject = id
      } else if let handedOut = instanceKeyCache {
        subject = handedOut
      } else {
        subject = deriveInstanceKey(option: nil, env: lookups.env, hostName: sources.hostName).value
      }
      instanceKeyCache = subject
    case .app:
      if let supplied = signature.deviceId {
        subject = supplied
        appSupplied = true
      } else if config.mode == .local || options.persistence == .memory {
        // Local mode buckets nothing, so it stores nothing.
        subject = mintDeviceId()
      } else if let stored = store.load() {
        subject = stored
      } else {
        subject = mintDeviceId()
        store.save(subject)
      }
    }

    generation += 1
    let current = generation
    // Only a start that actually begins may set the log sink: an identical
    // repeat is a no-op and a conflicting one fails, and neither may swap it.
    if let sink = options.log {
      logSink = sink
    }
    for warning in config.warnings {
      warnOnceLocked(warning, into: &lines)
    }
    if config.mode == .local {
      lines.append(LogLine(level: .info, text: localModeLine(config)))
    }

    let transport = options.transport
    let task = Task.detached { [self] in
      await self.boot(generation: current, config: config, subject: subject, transport: transport)
    }
    run = Run(
      generation: current,
      config: config,
      signature: signature,
      seeds: localSeeds(config.flags),
      subject: subject,
      currentKey: subject,
      persistence: options.persistence,
      appSuppliedDeviceId: appSupplied,
      store: store,
      task: task
    )
    phase = .running
    notifyLocked(.initializing)
    return .success(())
  }

  /// Builds the core client off the caller's thread and installs it, unless
  /// a shutdown or a newer start got there first.
  private func boot(
    generation expected: UInt64,
    config: ResolvedStart,
    subject: String,
    transport: (any RemoteHTTPTransport)?
  ) async {
    let log: LogSink = { [self] line in
      self.emit([LogLine(level: .info, text: line)])
    }
    do {
      let client = try await makeStartClient(
        config,
        subject: subject,
        transport: transport,
        log: log
      )
      let installed = lock.locked { () -> Bool in
        guard phase == .running, run?.generation == expected else { return false }
        run?.client = client
        notifyLocked(stateLocked())
        return true
      }
      if !installed {
        await client.shutdown()
      }
    } catch {
      let failure = (error as? FireweaveError) ?? FireweaveError(kind: .internalError)
      var lines: [LogLine] = []
      lock.locked { () -> Void in
        guard phase == .running, run?.generation == expected else { return }
        phase = .failed
        run?.failure = failure
        notifyLocked(.failed)
        warnOnceLocked(
          "[fireweave] start failed: \(failure.message) Reads serve their defaults.",
          into: &lines
        )
      }
      emit(lines)
    }
  }

  // MARK: - reads

  /// How one read is answered: by the installed client, or here.
  func route(for key: String, context: EvaluationContext?) -> ReadRoute {
    var lines: [LogLine] = []
    let answer = lock.locked { () -> ReadRoute in
      switch phase {
      case .notStarted:
        warnOnceLocked(
          "[fireweave] A control point was read before startFireweave(). Call it first, in"
            + " App.init() or main; reads serve their defaults until then.",
          into: &lines
        )
        return .fallback(FallbackReader(error: FireweaveError(kind: .notReady)))
      case .shutdown:
        return .fallback(FallbackReader(error: FireweaveError(kind: .alreadyClosed)))
      case .failed:
        let failure = run?.failure ?? FireweaveError(kind: .notReady)
        return .fallback(FallbackReader(error: failure, subject: run?.subject))
      case .running:
        guard let current = run else {
          return .fallback(FallbackReader(error: FireweaveError(kind: .notReady)))
        }
        noteReadLocked(key, context: context, run: current, lines: &lines)
        if let client = current.client {
          return .client(client)
        }
        let seeds = current.config.mode == .local ? current.seeds : nil
        let reader = FallbackReader(
          error: FireweaveError(kind: .notReady),
          subject: current.subject,
          seeds: seeds
        )
        return .fallback(reader)
      }
    }
    emit(lines)
    return answer
  }

  private func noteReadLocked(
    _ key: String,
    context: EvaluationContext?,
    run current: Run,
    lines: inout [LogLine]
  ) {
    if current.config.mode == .local && current.config.flags[key] == nil {
      warnOnceLocked(
        "[fireweave:local] \"\(key)\" is not in your flags (\(StartNames.flagsFile)), so it"
          + " gets its default. Add it there to try it locally.",
        into: &lines
      )
    }
    if let perCall = context?.targetingKey, perCall != current.currentKey {
      warnOnceLocked(
        "[fireweave] A per-call targetingKey does not change the decision: decisions are"
          + " prefetched for fw.identify()'s user (app) or fw.instanceKey() (server).",
        into: &lines
      )
    }
  }

  // MARK: - identity

  func identify(_ targetingKey: String, options: RegisterTargetOptions) async
    -> RegisterTargetResult
  {
    guard nonBlank(targetingKey) != nil else {
      return .failure(.targetingKeyMissing())
    }
    guard currentProfile() == .app else {
      // A server registers concurrently and never re-keys the process cache.
      return await identifyServer(targetingKey, options: options)
    }
    return await chain.enqueue { [self] in
      await self.identifyApp(targetingKey, options: options)
    }.value
  }

  private func identifyServer(_ targetingKey: String, options: RegisterTargetOptions) async
    -> RegisterTargetResult
  {
    switch await runningClient() {
    case .failure(let error):
      warnIdentifyBeforeStart(error)
      return .failure(error)
    case .success(let running):
      return await running.client.registerTarget(targetingKey, options: options)
    }
  }

  private func identifyApp(_ targetingKey: String, options: RegisterTargetOptions) async
    -> RegisterTargetResult
  {
    let running: RunningClient
    switch await runningClient() {
    case .failure(let error):
      warnIdentifyBeforeStart(error)
      return .failure(error)
    case .success(let value):
      running = value
    }
    // registerTarget is gated on the lifecycle: after a failed first
    // prefetch it returns the stored error without contacting fw-server, so
    // try the prefetch again first.
    if running.client.runtime.state() == .error {
      await running.client.runtime.refresh()
    }
    let result = await running.client.identify(targetingKey, options: options)
    settle(generation: running.generation) { state in
      state.currentKey = targetingKey
    }
    return result
  }

  private func warnIdentifyBeforeStart(_ error: FireweaveError) {
    guard error.kind == .notReady else { return }
    warnOnce("[fireweave] fw.identify() ran before startFireweave(); the user was not registered.")
  }

  func reset() async {
    let profile = currentProfile()
    if profile == .server {
      warnOnce(
        "[fireweave] fw.reset() is for apps: a server prefetches under fw.instanceKey(), so"
          + " there is nothing to reset."
      )
      return
    }
    guard profile == .app else { return }
    await chain.enqueue { [self] in
      await self.resetApp()
    }.value
  }

  private func resetApp() async {
    guard case .success(let running) = await runningClient() else { return }
    running.client.setContext(EvaluationContext(targetingKey: running.subject))
    await running.client.runtime.refresh()
    settle(generation: running.generation) { state in
      state.currentKey = running.subject
    }
  }

  func forget() async {
    let profile = currentProfile() ?? sources.platformProfile
    if profile == .server {
      warnOnce("[fireweave] fw.forget() is for apps: a server stores no device id.")
      return
    }
    await chain.enqueue { [self] in
      await self.forgetApp()
    }.value
  }

  /// Consent withdrawn: delete the stored id, stop storing, and switch to a
  /// fresh in-memory id.
  private func forgetApp() async {
    let store = lock.locked { () -> any DeviceIdStoring in
      run?.persistence = .memory
      return run?.store ?? sources.makeStore()
    }
    store.remove()
    guard case .success(let running) = await runningClient(), running.profile == .app else {
      return
    }
    let fresh = mintDeviceId()
    settle(generation: running.generation) { state in
      state.subject = fresh
      state.appSuppliedDeviceId = false
    }
    running.client.setContext(EvaluationContext(targetingKey: fresh))
    await running.client.runtime.refresh()
    settle(generation: running.generation) { state in
      state.currentKey = fresh
    }
  }

  func setPersistence(_ persistence: FireweavePersistence) {
    lock.locked { () -> Void in
      guard phase == .running, var current = run, current.config.profile == .app else {
        if persistence == .memory && sources.platformProfile == .app {
          sources.makeStore().remove()
        }
        return
      }
      let previous = current.persistence
      current.persistence = persistence
      run = current
      switch persistence {
      case .memory:
        current.store.remove()
      case .userDefaults:
        let durable = current.config.mode == .remote && !current.appSuppliedDeviceId
        if previous == .memory && durable {
          current.store.save(current.subject)
        }
      }
    }
  }

  var deviceId: String? {
    lock.locked { () -> String? in
      guard phase == .running, let current = run, current.config.profile == .app else {
        return nil
      }
      return current.subject
    }
  }

  func instanceKey() -> String {
    lock.locked { () -> String in
      if phase == .running, let current = run, current.config.profile == .app {
        return current.subject
      }
      if let cached = instanceKeyCache {
        return cached
      }
      let derived = deriveInstanceKey(option: nil, env: sources.env, hostName: sources.hostName)
      instanceKeyCache = derived.value
      return derived.value
    }
  }

  // MARK: - lifecycle

  func ready(timeout: Duration?) async -> FireweaveStartState {
    let pending = lock.locked { () -> Task<Void, Never>? in
      guard phase == .running, let current = run, current.client == nil else { return nil }
      return current.task
    }
    if let pending {
      let gate = OneShotGate()
      Task {
        await pending.value
        gate.open()
      }
      if let timeout {
        let delay = nanoseconds(of: timeout)
        Task {
          try? await Task.sleep(nanoseconds: delay)
          gate.open()
        }
      }
      await gate.wait()
    }
    return lock.locked { stateLocked() }
  }

  var status: FireweaveStatus {
    lock.locked { statusLocked() }
  }

  var client: FireweaveClient? {
    lock.locked { () -> FireweaveClient? in
      phase == .running ? run?.client : nil
    }
  }

  func updates() -> AsyncStream<FireweaveStartState> {
    AsyncStream(bufferingPolicy: .bufferingNewest(32)) { continuation in
      let id = UUID()
      continuation.onTermination = { [weak self] _ in
        self?.removeListener(id)
      }
      self.lock.locked { () -> Void in
        self.listeners[id] = continuation
        continuation.yield(self.stateLocked())
      }
    }
  }

  private func removeListener(_ id: UUID) {
    lock.locked {
      listeners[id] = nil
    }
  }

  func shutdown() async {
    let (client, pending) = lock.locked { () -> (FireweaveClient?, Task<Void, Never>?) in
      guard phase == .running || phase == .failed else { return (nil, nil) }
      generation += 1
      let installed = run?.client
      let starting = installed == nil ? run?.task : nil
      run?.client = nil
      phase = .shutdown
      notifyLocked(.shutdown)
      return (installed, starting)
    }
    if let client {
      await client.shutdown()
    } else if let pending {
      // The start task sees the newer generation and shuts its client down.
      await pending.value
    }
  }

  func resetForTesting() async {
    await shutdown()
    lock.locked { () -> Void in
      phase = .notStarted
      run = nil
      warned = []
      logSink = nil
      instanceKeyCache = nil
      notifyLocked(.notStarted)
    }
  }

  // MARK: - helpers

  private func currentProfile() -> FireweaveProfile? {
    lock.locked { () -> FireweaveProfile? in
      phase == .running ? run?.config.profile : nil
    }
  }

  /// Waits for the start task, then returns the installed client or the
  /// error a call reports instead.
  private func runningClient() async -> Result<RunningClient, FireweaveError> {
    let pending = lock.locked { () -> Task<Void, Never>? in
      phase == .running ? run?.task : nil
    }
    if let pending {
      await pending.value
    }
    return lock.locked { () -> Result<RunningClient, FireweaveError> in
      switch phase {
      case .notStarted:
        return .failure(FireweaveError(kind: .notReady))
      case .shutdown:
        return .failure(FireweaveError(kind: .alreadyClosed))
      case .failed:
        return .failure(run?.failure ?? FireweaveError(kind: .notReady))
      case .running:
        guard let current = run, let client = current.client else {
          return .failure(FireweaveError(kind: .notReady))
        }
        let running = RunningClient(
          client: client,
          generation: current.generation,
          profile: current.config.profile,
          subject: current.subject
        )
        return .success(running)
      }
    }
  }

  /// Applies `update` to the run that started as `expected`, if it is still
  /// the running one, and announces the state.
  private func settle(generation expected: UInt64, _ update: (inout Run) -> Void) {
    lock.locked { () -> Void in
      guard phase == .running, var current = run, current.generation == expected else { return }
      update(&current)
      run = current
      notifyLocked(stateLocked())
    }
  }

  private func stateLocked() -> FireweaveStartState {
    switch phase {
    case .notStarted:
      return .notStarted
    case .failed:
      return .failed
    case .shutdown:
      return .shutdown
    case .running:
      guard let client = run?.client else { return .initializing }
      return Self.startState(client.runtime.state())
    }
  }

  static func startState(_ state: LifecycleState) -> FireweaveStartState {
    switch state {
    case .uninitialized, .initializing: return .initializing
    case .ready: return .ready
    case .stale: return .stale
    case .error, .fatal: return .error
    case .shutdown: return .shutdown
    }
  }

  private func statusLocked() -> FireweaveStatus {
    var status = FireweaveStatus(
      state: stateLocked(),
      channel: sources.channel,
      sdkVersion: sources.sdkVersion,
      flagCount: 0
    )
    guard phase != .notStarted, let current = run else { return status }
    let config = current.config
    status.profile = config.profile
    status.mode = config.mode
    status.modeSource = config.modeSource
    status.keySource = config.keySource
    status.environment = config.environment
    status.flagCount = config.flags.count
    if let url = config.url {
      status.host = URLComponents(string: url)?.host
      status.endpointSource = config.urlSource
    }
    if phase == .failed, let failure = current.failure {
      status.problem = FireweaveStartProblem(kind: failure.kind, message: failure.message)
    } else if let cause = current.client?.runtime.initializationError() {
      status.problem = FireweaveStartProblem(kind: cause.kind, message: cause.message)
    }
    return status
  }

  private func notifyLocked(_ state: FireweaveStartState) {
    for continuation in listeners.values {
      continuation.yield(state)
    }
  }

  private func warnOnceLocked(_ text: String, into lines: inout [LogLine]) {
    if warned.insert(text).inserted {
      lines.append(LogLine(level: .warning, text: text))
    }
  }

  private func warnOnce(_ text: String) {
    var lines: [LogLine] = []
    lock.locked {
      warnOnceLocked(text, into: &lines)
    }
    emit(lines)
  }

  /// Writes lines through the configured sink, outside the lock.
  private func emit(_ lines: [LogLine]) {
    guard !lines.isEmpty else { return }
    let sink = lock.locked { logSink }
    for line in lines {
      if let sink {
        sink(line.text)
      } else {
        writeDefaultLog(line)
      }
    }
  }
}

/// How one read is answered.
enum ReadRoute {
  /// The installed core client answers, exactly as a core read would.
  case client(FireweaveClient)
  /// The start layer answers: local seeds, or the caller's default.
  case fallback(FallbackReader)
}

/// What makes two starts "the same". Flags count in local mode only: remote
/// ignores them. The key is compared by hash and never stored here.
struct StartSignature: Equatable {
  var profile: FireweaveProfile
  var mode: Mode
  var url: String?
  var keyHash: String?
  var allowedHosts: [String]?
  var deviceId: String?
  var instanceId: String?
  var flags: String?

  init(config: ResolvedStart, deviceId: String?, instanceId: String?) {
    profile = config.profile
    mode = config.mode
    url = config.url
    keyHash = config.key.map(fnv1a64)
    allowedHosts = config.allowedHosts
    self.deviceId = deviceId
    self.instanceId = instanceId
    flags = config.mode == .local ? flagsSignature(config.flags) : nil
  }

  /// The names of the fields that differ, never their values.
  func differences(from other: StartSignature) -> [String] {
    var names: [String] = []
    if profile != other.profile { names.append("profile") }
    if mode != other.mode { names.append("mode") }
    if url != other.url { names.append("url") }
    if keyHash != other.keyHash { names.append("key") }
    if allowedHosts != other.allowedHosts { names.append("allowed hosts") }
    if deviceId != other.deviceId { names.append("device id") }
    if instanceId != other.instanceId { names.append("instance id") }
    if flags != other.flags { names.append("flags") }
    return names
  }
}

/// The `[fireweave:local]` line a local start logs once.
func localModeLine(_ config: ResolvedStart) -> String {
  let why: String
  if config.modeSource == .option {
    why = "startFireweave(mode: .local)"
  } else {
    let name = config.environment ?? "development"
    let source = config.environmentSource ?? "the environment"
    why = "no key; environment \"\(name)\" from \(source)"
  }
  let count = config.flags.count
  let noun = count == 1 ? "flag" : "flags"
  return phrase(
    "[fireweave:local] Local mode (\(why)). Serving \(count) \(noun) from your flags;",
    "nothing is sent to fw-server."
  )
}
