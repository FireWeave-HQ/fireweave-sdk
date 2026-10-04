import Foundation
import Testing

@testable import FireweaveStart

/// The singleton behaviour behind `fw`, on handles of their own (so these
/// suites run in parallel): reads before and after start, local and remote
/// readiness, idempotency, shutdown and restart, status and updates.
@Suite("Start profile: lifecycle")
struct StartLifecycleTests {
  private func server(env: [String: String] = [:], host: String? = "api-pod-1") -> FireweaveHandle {
    makeHandle(makeSources(env: env, host: host))
  }

  @Test func readsBeforeStartServeDefaultsWithNotReady() async {
    let handle = server()
    #expect(handle.controlPoints.getBooleanValue("new-checkout", default: true))
    #expect(handle.controlPoints.getStringValue("copy", default: "d") == "d")

    let decision = handle.controlPoints.getBooleanDetails("new-checkout", default: false)
    #expect(decision.value == .bool(false))
    #expect(decision.reason == .error)
    #expect(decision.errorKind == .notReady)
    #expect(decision.errorCode == "PROVIDER_NOT_READY")

    // The same decision an uninitialised core runtime gives.
    let runtime = FireweaveRuntime(adapter: FireweaveLocalAdapter())
    let core = runtime.evaluate(key: "new-checkout", type: .boolean, defaultValue: .bool(false))
    #expect(decision == core)

    #expect(handle.status.state == .notStarted)
    #expect(handle.client == nil)
    #expect(handle.deviceId == nil)
    let result = await handle.identify("user-1")
    #expect(!result.ok)
    #expect(result.error?.kind == .notReady)
  }

  @Test func theNineReadsHaveTheCoreSignatures() {
    let reads = server().controlPoints
    let ctx = EvaluationContext(targetingKey: "t")
    let _: Bool = reads.getBooleanValue("k", default: false, context: ctx)
    let _: String = reads.getStringValue("k", default: "d", context: ctx)
    let _: Double = reads.getNumberValue("k", default: 0.0, context: ctx)
    let _: JSONValue = reads.getObjectValue("k", default: .null, context: ctx)
    let _: Decision = reads.getBooleanDetails("k", default: false, context: ctx)
    let _: Decision = reads.getStringDetails("k", default: "d", context: ctx)
    let _: Decision = reads.getNumberDetails("k", default: 0.0, context: ctx)
    let _: Decision = reads.getObjectDetails("k", default: .null, context: ctx)
    let _: Decision = reads.evaluate(
      "k", type: .boolean, default: .bool(false), context: ctx, options: EvaluateOptions())
  }

  @Test func localModeAnswersFromTheFirstReadExactlyAsTheCoreDoes() async throws {
    let log = LogCollector()
    let handle = server()
    let flags: FireweaveFlags = ["new-checkout": true, "old-banner": false]
    try handle.core.start(FireweaveStartOptions(flags: flags, mode: .local, log: log.sink))

    // Answered synchronously, whether or not the client is installed yet.
    let first = handle.controlPoints.getBooleanDetails("new-checkout", default: false)
    #expect(first.value == .bool(true))
    #expect(first.reason == .staticReason)
    #expect(first.variant == "on")
    #expect(!handle.controlPoints.getBooleanValue("old-banner", default: true))
    let unknown = handle.controlPoints.getBooleanDetails("unknown", default: true)
    #expect(unknown.value == .bool(true))
    #expect(unknown.reason == .defaultReason)

    let state = await handle.ready()
    #expect(state == .ready)
    #expect(handle.client != nil)

    // The seed answerer and the installed core client agree read for read.
    let reader = FallbackReader(
      error: FireweaveError(kind: .notReady),
      subject: handle.instanceKey(),
      seeds: localSeeds(flags)
    )
    let probes: [(key: String, type: FlagType, fallback: JSONValue)] = [
      ("new-checkout", .boolean, .bool(false)),
      ("old-banner", .boolean, .bool(true)),
      ("unknown", .boolean, .bool(false)),
      ("new-checkout", .string, .string("x")),
      ("new-checkout", .boolean, .string("wrong default")),
      ("", .boolean, .bool(false)),
    ]
    for (key, type, fallback) in probes {
      let viaCore = handle.controlPoints.evaluate(key, type: type, default: fallback)
      let viaSeeds = reader.decide(key, type: type, default: fallback, context: nil)
      #expect(viaCore == viaSeeds, "\(key) as \(type)")
    }

    let localLine = "[fireweave:local] Local mode (startFireweave(mode: .local))"
    #expect(log.count(containing: localLine) == 1)
    #expect(log.count(containing: "\"unknown\" is not in your flags (FireweaveFlags.swift)") == 1)
    await handle.shutdown()
  }

  @Test func remoteReadsServeDefaultsUntilTheFirstPrefetchSettles() async throws {
    let transport = StartFakeTransport(delayNs: 200_000_000)
    let handle = server(env: ["FIREWEAVE_KEY": testProjectKey])
    try handle.core.start(FireweaveStartOptions(log: LogCollector().sink, transport: transport))

    let early = handle.controlPoints.getBooleanDetails("new-checkout", default: false)
    #expect(early.errorKind == .notReady)
    #expect(handle.status.state == .initializing)

    let state = await handle.ready()
    #expect(state == .ready)
    #expect(handle.controlPoints.getBooleanValue("new-checkout", default: false))

    // The server prefetches under its instance key, with the project key.
    let evaluation = try #require(transport.evaluations().first)
    #expect(evaluation.targetingKey == "inst_8148fc8bb0e952ef")
    #expect(evaluation.authorization == "Bearer " + testProjectKey)
    await handle.shutdown()
  }

  /// The render-path case: a main-actor read while the first prefetch is in
  /// flight returns at once, without waiting on the network.
  @Test @MainActor func aMainActorReadDuringAnInFlightStartReturnsAtOnce() async throws {
    let transport = StartFakeTransport(delayNs: 300_000_000)
    let handle = makeHandle(makeSources(env: ["FIREWEAVE_KEY": testProjectKey]))
    try handle.core.start(FireweaveStartOptions(log: LogCollector().sink, transport: transport))
    let started = Date()
    let decision = handle.controlPoints.getBooleanDetails("new-checkout", default: false)
    #expect(decision.errorKind == .notReady)
    #expect(Date().timeIntervalSince(started) < 0.25)
    let state = await handle.ready()
    #expect(state == .ready)
    await handle.shutdown()
  }

  @Test func readyReturnsAtItsTimeoutWhileThePrefetchIsInFlight() async throws {
    let transport = StartFakeTransport(delayNs: 2_000_000_000)
    let handle = server(env: ["FIREWEAVE_KEY": testProjectKey])
    try handle.core.start(FireweaveStartOptions(log: LogCollector().sink, transport: transport))
    let started = Date()
    let state = await handle.ready(timeout: .milliseconds(100))
    #expect(state == .initializing)
    #expect(Date().timeIntervalSince(started) < 1.5)
    await handle.shutdown()
  }

  @Test func aRefusedKeyIsAnErrorStateWithItsCause() async throws {
    let transport = StartFakeTransport(statusCode: 401)
    let handle = server(env: ["FIREWEAVE_KEY": testProjectKey])
    try handle.core.start(FireweaveStartOptions(log: LogCollector().sink, transport: transport))
    let state = await handle.ready()
    #expect(state == .error)
    #expect(handle.status.problem?.kind == .authentication)
    let decision = handle.controlPoints.getBooleanDetails("new-checkout", default: false)
    #expect(decision.errorKind == .authentication)
    await handle.shutdown()
  }

  @Test func anIdenticalSecondStartIsANoOpAndADifferentOneThrows() async throws {
    let handle = server()
    let options = FireweaveStartOptions(flags: ["a": true], mode: .local, log: LogCollector().sink)
    try handle.core.start(options)
    try handle.core.start(options)

    let changed = FireweaveStartOptions(flags: ["a": false], mode: .local)
    let thrown = startError { try handle.core.start(changed) }
    let error = try #require(thrown)
    #expect(error.kind == .configuration)
    #expect(error.message.contains("(flags)"))
    // The running configuration survives a conflicting start.
    #expect(handle.controlPoints.getBooleanValue("a", default: false))
    await handle.shutdown()
  }

  @Test func remoteConflictsNameTheFieldNeverTheKey() async throws {
    let transport = StartFakeTransport()
    let handle = server()
    let log = LogCollector()
    let first = FireweaveStartOptions(
      flags: ["a": true],
      key: "project-api-key_first",
      log: log.sink,
      transport: transport
    )
    try handle.core.start(first)
    // Flags are ignored in remote mode, so they do not conflict.
    let sameKey = FireweaveStartOptions(key: "project-api-key_first", transport: transport)
    try handle.core.start(sameKey)

    let otherKey = FireweaveStartOptions(key: "project-api-key_second", transport: transport)
    let thrown = startError { try handle.core.start(otherKey) }
    let error = try #require(thrown)
    #expect(error.message.contains("(key)"))
    #expect(!error.message.contains("project-api-key_first"))
    #expect(!error.message.contains("project-api-key_second"))
    await handle.shutdown()
  }

  @Test func aStartThatThrowsLeavesNoState() throws {
    let handle = server()
    let error = startError { try handle.core.start(FireweaveStartOptions()) }
    #expect(error?.kind == .configuration)
    #expect(handle.status.state == .notStarted)
    try handle.core.start(FireweaveStartOptions(mode: .local, log: LogCollector().sink))
    #expect(handle.status.state != .notStarted)
  }

  @Test func shutdownThenRestartWithAnyConfiguration() async throws {
    let log = LogCollector()
    let handle = server()
    try handle.core.start(FireweaveStartOptions(flags: ["a": true], mode: .local, log: log.sink))
    await handle.ready()
    await handle.shutdown()

    #expect(handle.status.state == .shutdown)
    #expect(handle.client == nil)
    let closed = handle.controlPoints.getBooleanDetails("a", default: false)
    #expect(closed.value == .bool(false))
    #expect(closed.errorKind == .alreadyClosed)

    let transport = StartFakeTransport()
    try handle.core.start(FireweaveStartOptions(key: testProjectKey, transport: transport))
    let state = await handle.ready()
    #expect(state == .ready)
    #expect(handle.status.mode == .remote)
    #expect(handle.controlPoints.getBooleanValue("new-checkout", default: false))
    await handle.shutdown()
  }

  @Test func shutdownDuringStartDiscardsTheLateClient() async throws {
    let transport = StartFakeTransport(delayNs: 200_000_000)
    let handle = server(env: ["FIREWEAVE_KEY": testProjectKey])
    try handle.core.start(FireweaveStartOptions(log: LogCollector().sink, transport: transport))
    await handle.shutdown()
    #expect(handle.status.state == .shutdown)
    #expect(handle.client == nil)
  }

  @Test func theInstanceKeyHashesTheHostNameLikeTheOtherSDKs() {
    #expect(server(host: "api-pod-1").instanceKey() == "inst_8148fc8bb0e952ef")
    #expect(server(env: ["FIREWEAVE_INSTANCE_ID": "worker-7"]).instanceKey() == "worker-7")
    let fromEnv = server(env: ["HOSTNAME": "api-pod-1"], host: "other")
    #expect(fromEnv.instanceKey() == "inst_8148fc8bb0e952ef")
    let handle = server()
    #expect(handle.instanceKey() == handle.instanceKey())
  }

  @Test func theInstanceIdOptionIsTheInstanceKeyAndThePrefetchSubject() async throws {
    let transport = StartFakeTransport()
    let handle = server()
    let options = FireweaveStartOptions(
      key: testProjectKey,
      instanceId: "worker-7",
      log: LogCollector().sink,
      transport: transport
    )
    try handle.core.start(options)
    await handle.ready()
    #expect(handle.instanceKey() == "worker-7")
    #expect(transport.evaluations().first?.targetingKey == "worker-7")
    await handle.shutdown()
  }

  @Test func anInstanceIdThatContradictsAHandedOutKeyThrows() throws {
    let handle = server()
    _ = handle.instanceKey()
    let options = FireweaveStartOptions(mode: .local, instanceId: "worker-7")
    let thrown = startError { try handle.core.start(options) }
    let error = try #require(thrown)
    #expect(error.message.contains("instanceKey()"))
  }

  @Test func statusReportsTheDecisionAndNeverTheKey() async throws {
    let transport = StartFakeTransport()
    let env = ["FIREWEAVE_KEY": testProjectKey, "FIREWEAVE_URL": "http://127.0.0.1:9"]
    let handle = server(env: env)
    let options = FireweaveStartOptions(
      flags: ["a": true],
      log: LogCollector().sink,
      transport: transport
    )
    try handle.core.start(options)
    await handle.ready()

    let status = handle.status
    #expect(status.state == .ready)
    #expect(status.profile == .server)
    #expect(status.mode == .remote)
    #expect(status.modeSource == .key)
    #expect(status.host == "127.0.0.1")
    #expect(status.endpointSource == "FIREWEAVE_URL")
    #expect(status.keySource == "FIREWEAVE_KEY")
    #expect(status.channel == .production)
    #expect(status.sdkVersion == "2.2.0")
    #expect(status.flagCount == 1)
    #expect(status.problem == nil)
    #expect(!String(describing: status).contains(testProjectKey))
    await handle.shutdown()
  }

  @Test func updatesStartWithTheCurrentStateAndFollowTheStart() async throws {
    let handle = server()
    var updates = handle.updates.makeAsyncIterator()
    let initial = await updates.next()
    #expect(initial == .notStarted)

    try handle.core.start(FireweaveStartOptions(mode: .local, log: LogCollector().sink))
    let starting = await updates.next()
    #expect(starting == .initializing)
    let settled = await updates.next()
    #expect(settled == .ready)

    await handle.shutdown()
    let closed = await updates.next()
    #expect(closed == .shutdown)
  }

  @Test func theOperationChainRunsInEnqueueOrder() async {
    let chain = OperationChain()
    let log = LogCollector()
    let slow = chain.enqueue {
      try? await Task.sleep(nanoseconds: 100_000_000)
      log.append("first")
    }
    let fast = chain.enqueue {
      log.append("second")
    }
    await slow.value
    await fast.value
    #expect(log.lines == ["first", "second"])
  }
}

@Suite("Start profile: identity")
struct StartIdentityTests {
  private func app(
    store: any DeviceIdStoring,
    plist: [String: String] = ["FIREWEAVE_BROWSER_KEY": testBrowserKey],
    debug: Bool = false
  ) -> FireweaveHandle {
    makeHandle(makeSources(plist: plist, profile: .app, debug: debug, store: store))
  }

  private func remote(_ transport: StartFakeTransport) -> FireweaveStartOptions {
    FireweaveStartOptions(log: LogCollector().sink, transport: transport)
  }

  @Test func anAppMintsOneDeviceIdAndReusesItAcrossStarts() async throws {
    let store = RecordingDeviceIdStore()
    let transport = StartFakeTransport()
    let first = app(store: store)
    try first.core.start(remote(transport))
    let minted = try #require(first.deviceId)
    #expect(minted.hasPrefix("dev_"))
    #expect(store.stored == minted)
    #expect(store.saveCount == 1)
    await first.ready()
    #expect(transport.evaluations().first?.targetingKey == minted)
    await first.shutdown()

    let second = app(store: store)
    try second.core.start(remote(transport))
    #expect(second.deviceId == minted)
    #expect(store.saveCount == 1)
    await second.shutdown()
  }

  @Test func anExistingStoredIdIsReusedVerbatim() async throws {
    let store = RecordingDeviceIdStore(initial: "dev_EXISTING-0001")
    let handle = app(store: store)
    try handle.core.start(remote(StartFakeTransport()))
    #expect(handle.deviceId == "dev_EXISTING-0001")
    #expect(store.saveCount == 0)
    await handle.shutdown()
  }

  @Test func memoryPersistenceAndAnAppSuppliedIdWriteNothing() async throws {
    let store = RecordingDeviceIdStore()
    let memory = app(store: store)
    let inMemory = FireweaveStartOptions(
      persistence: .memory,
      log: LogCollector().sink,
      transport: StartFakeTransport()
    )
    try memory.core.start(inMemory)
    #expect(memory.deviceId?.hasPrefix("dev_") == true)
    #expect(store.saveCount == 0)
    await memory.shutdown()

    let supplied = app(store: store)
    let appOwned = FireweaveStartOptions(
      deviceId: "analytics-anon-1",
      log: LogCollector().sink,
      transport: StartFakeTransport()
    )
    try supplied.core.start(appOwned)
    #expect(supplied.deviceId == "analytics-anon-1")
    #expect(store.saveCount == 0)
    await supplied.shutdown()
  }

  @Test func consentTransitions() async throws {
    let store = RecordingDeviceIdStore()
    let handle = app(store: store)
    let options = FireweaveStartOptions(
      persistence: .memory,
      log: LogCollector().sink,
      transport: StartFakeTransport()
    )
    try handle.core.start(options)
    let id = try #require(handle.deviceId)
    #expect(store.stored == nil)

    handle.setPersistence(.userDefaults)
    #expect(store.stored == id)
    handle.setPersistence(.memory)
    #expect(store.stored == nil)
    handle.setPersistence(.userDefaults)
    #expect(store.stored == id)

    await handle.ready()
    await handle.forget()
    let fresh = try #require(handle.deviceId)
    #expect(fresh != id)
    #expect(fresh.hasPrefix("dev_"))
    #expect(store.stored == nil)

    handle.setPersistence(.userDefaults)
    #expect(store.stored == fresh)
    await handle.shutdown()
  }

  @Test func localModeStoresNoDeviceId() async throws {
    let store = RecordingDeviceIdStore()
    let handle = app(store: store, plist: [:], debug: true)
    try handle.core.start(FireweaveStartOptions(log: LogCollector().sink))
    #expect(handle.status.mode == .local)
    #expect(handle.deviceId?.hasPrefix("dev_") == true)
    #expect(store.saveCount == 0)
    await handle.shutdown()
  }

  @Test func theUserDefaultsStoreUsesTheHarnessKey() async throws {
    let suite = "fireweave-start-tests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = UserDefaultsDeviceIdStore(defaults: defaults)
    #expect(store.load() == nil)

    let handle = app(store: store)
    try handle.core.start(remote(StartFakeTransport()))
    let minted = try #require(handle.deviceId)
    #expect(defaults.string(forKey: "fireweave.device-id") == minted)
    await handle.shutdown()

    defaults.set("   ", forKey: "fireweave.device-id")
    #expect(store.load() == nil)
    store.remove()
    #expect(defaults.string(forKey: "fireweave.device-id") == nil)
  }

  @Test func appIdentifyRegistersThenPrefetchesUnderTheUser() async throws {
    let transport = StartFakeTransport()
    let handle = app(store: RecordingDeviceIdStore())
    try handle.core.start(remote(transport))
    let device = try #require(handle.deviceId)

    let result = await handle.identify("user-1", properties: ["plan": "pro"])
    #expect(result.ok)
    let registration = try #require(transport.registrations().first)
    #expect(registration.targetingKey == "user-1")
    #expect(registration.body.objectValue?["kind"] == .string("user"))
    #expect(registration.body.objectValue?["properties"] == .object(["plan": .string("pro")]))
    #expect(transport.evaluations().last?.targetingKey == "user-1")

    await handle.reset()
    #expect(transport.evaluations().last?.targetingKey == device)
    await handle.shutdown()
  }

  @Test func serverIdentifyRegistersWithoutReKeyingTheProcess() async throws {
    let transport = StartFakeTransport()
    let sources = makeSources(env: ["FIREWEAVE_KEY": testProjectKey])
    let handle = makeHandle(sources)
    try handle.core.start(remote(transport))
    await handle.ready()
    let prefetches = transport.evaluations().count

    let result = await handle.identify("user-1", properties: ["plan": "pro"])
    #expect(result.ok)
    #expect(transport.registrations().first?.targetingKey == "user-1")
    #expect(transport.evaluations().count == prefetches)

    // reset and forget are app calls: no-ops on a server.
    await handle.reset()
    await handle.forget()
    #expect(transport.evaluations().count == prefetches)
    #expect(handle.deviceId == nil)
    await handle.shutdown()
  }

  @Test func aBlankTargetingKeyIsInvalidContext() async throws {
    let handle = app(store: RecordingDeviceIdStore())
    try handle.core.start(remote(StartFakeTransport()))
    let result = await handle.identify("   ")
    #expect(!result.ok)
    #expect(result.error?.kind == .invalidContext)
    await handle.shutdown()
  }
}

/// The only suite that touches the process-wide `fw`.
@Suite("Start profile: the process-wide fw", .serialized)
struct GlobalStartTests {
  @Test func startFireweaveReturnsTheProcessWideHandle() async throws {
    await resetFireweaveForTesting()
    let log = LogCollector()
    let handle = try startFireweave(flags: ["new-checkout": true], mode: .local, log: log.sink)
    #expect(handle === fw)
    #expect(fw.controlPoints.getBooleanValue("new-checkout", default: false))

    let again = try startFireweave(flags: ["new-checkout": true], mode: .local)
    #expect(again === fw)

    await resetFireweaveForTesting()
    #expect(fw.status.state == .notStarted)
  }
}
