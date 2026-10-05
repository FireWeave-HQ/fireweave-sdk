import Foundation
import Testing

@testable import FireweaveStart

/// What the start profile does when something goes wrong: an app's
/// configuration fault never throws (SP-23), a server re-fetches its
/// decisions and keeps the last good ones when a re-fetch fails
/// (`spec/control-points.md`), and every kind of fw-server failure logs one
/// line for the life of the process and lands in `lastErrorKind` (SP-27).
@Suite("Start profile: failures")
struct StartFailureTests {
  private func app(debug: Bool = false) -> FireweaveHandle {
    makeHandle(makeSources(profile: .app, debug: debug))
  }

  private func server() -> FireweaveHandle {
    makeHandle(makeSources(env: ["FIREWEAVE_KEY": testProjectKey]))
  }

  private func refreshing(
    _ transport: StartFakeTransport,
    every interval: Duration,
    log: LogCollector = LogCollector()
  ) -> FireweaveStartOptions {
    FireweaveStartOptions(log: log.sink, refreshInterval: interval, transport: transport)
  }

  // MARK: - SP-23: an app never throws

  @Test func anAppConfigurationFaultIsReportedNotThrown() async throws {
    let log = LogCollector()
    let handle = app()
    // A release build with no browser key and no environment name.
    let thrown = startError { try handle.core.start(FireweaveStartOptions(log: log.sink)) }
    #expect(thrown == nil)

    let status = handle.status
    #expect(status.state == .failed)
    #expect(status.profile == .app)
    let problem = try #require(status.problem)
    #expect(problem.kind == .configuration)
    #expect(problem.message.contains("FIREWEAVE_BROWSER_KEY"))
    #expect(log.count(containing: "FireWeave is not running; reads serve their defaults.") == 1)

    let decision = handle.controlPoints.getBooleanDetails("new-checkout", default: true)
    #expect(decision.value == .bool(true))
    #expect(decision.reason == .error)
    #expect(decision.errorKind == .configuration)
    let state = await handle.ready()
    #expect(state == .failed)
    let identified = await handle.identify("user-1")
    #expect(identified.error?.kind == .configuration)

    // A corrected start begins as after a shutdown.
    let transport = StartFakeTransport()
    try handle.core.start(FireweaveStartOptions(key: testBrowserKey, transport: transport))
    let recovered = await handle.ready()
    #expect(recovered == .ready)
    #expect(handle.status.problem == nil)
    #expect(handle.controlPoints.getBooleanValue("new-checkout", default: false))
    await handle.shutdown()
  }

  @Test func anAppFaultWhileRunningKeepsTheRunningStart() async throws {
    let log = LogCollector()
    let handle = app(debug: true)
    try handle.core.start(FireweaveStartOptions(flags: ["a": true], log: log.sink))
    #expect(handle.status.mode == .local)

    // A server key in an app is a fault; the running start survives it.
    let thrown = startError { try handle.core.start(FireweaveStartOptions(key: testProjectKey)) }
    #expect(thrown == nil)
    #expect(handle.status.state != .failed)
    #expect(handle.controlPoints.getBooleanValue("a", default: false))
    #expect(log.count(containing: "Keeping the running configuration.") == 1)
    #expect(log.lines.allSatisfy { !$0.contains(testProjectKey) })
    await handle.shutdown()
  }

  @Test func anAppConflictingStartIsLoggedAndKeepsTheFirst() async throws {
    let log = LogCollector()
    let handle = app()
    try handle.core.start(FireweaveStartOptions(flags: ["a": true], mode: .local, log: log.sink))
    let changed = FireweaveStartOptions(flags: ["a": false], mode: .local)
    let thrown = startError { try handle.core.start(changed) }
    #expect(thrown == nil)
    #expect(handle.controlPoints.getBooleanValue("a", default: false))
    #expect(log.count(containing: "different configuration (flags). Keeping the first one") == 1)
    await handle.shutdown()
  }

  // MARK: - the server's periodic re-fetch

  @Test func aServerRefreshSwapsTheDecisionsOnSuccess() async throws {
    let transport = StartFakeTransport()
    let handle = server()
    try handle.core.start(refreshing(transport, every: .milliseconds(50)))
    let state = await handle.ready()
    #expect(state == .ready)
    #expect(handle.controlPoints.getBooleanValue("new-checkout", default: false))

    transport.setDecisions(StartFakeTransport.newCheckoutOff)
    let swapped = await eventually {
      !handle.controlPoints.getBooleanValue("new-checkout", default: true)
    }
    #expect(swapped)
    #expect(transport.evaluations().count >= 2)
    // Every re-fetch is keyed by the instance key, like the first.
    #expect(transport.evaluations().allSatisfy { $0.targetingKey == "inst_8148fc8bb0e952ef" })
    await handle.shutdown()
  }

  @Test func aFailedServerRefreshKeepsTheLastGoodDecisions() async throws {
    let log = LogCollector()
    let transport = StartFakeTransport()
    let handle = server()
    try handle.core.start(refreshing(transport, every: .milliseconds(50), log: log))
    await handle.ready()
    let fetchedBefore = transport.evaluations().count

    transport.setStatusCode(503)
    let stale = await eventually { handle.status.state == .stale }
    #expect(stale)
    let decision = handle.controlPoints.getBooleanDetails("new-checkout", default: false)
    #expect(decision.value == .bool(true))
    #expect(decision.variant == "on")
    #expect(decision.reason == .stale)
    #expect(decision.errorKind == nil)
    #expect(handle.status.problem?.kind == .backendUnavailable)
    #expect(handle.status.lastErrorKind == .backendUnavailable)

    // More failed re-fetches: still one line for the kind.
    let more = await eventually { transport.evaluations().count >= fetchedBefore + 3 }
    #expect(more)
    #expect(log.count(containing: "Could not reach fw-server at app-server.fireweave.ai") == 1)
    #expect(log.count(containing: "Reads keep serving the last decisions fetched") == 1)

    // The decisions change before the status, so the first success sees both.
    transport.setDecisions(StartFakeTransport.newCheckoutOff)
    transport.setStatusCode(200)
    let recovered = await eventually { handle.status.state == .ready }
    #expect(recovered)
    #expect(!handle.controlPoints.getBooleanValue("new-checkout", default: true))
    #expect(handle.status.problem == nil)
    // It stays after the success, so a past failure is still visible.
    #expect(handle.status.lastErrorKind == .backendUnavailable)
    await handle.shutdown()
  }

  @Test func theServerRefreshStopsAtShutdown() async throws {
    let transport = StartFakeTransport()
    let handle = server()
    try handle.core.start(refreshing(transport, every: .milliseconds(30)))
    await handle.ready()
    let refreshed = await eventually { transport.evaluations().count >= 2 }
    #expect(refreshed)

    await handle.shutdown()
    try? await Task.sleep(nanoseconds: 50_000_000)
    let settled = transport.evaluations().count
    try? await Task.sleep(nanoseconds: 300_000_000)
    #expect(transport.evaluations().count == settled)
  }

  @Test func appsAndAZeroIntervalDoNotRefresh() async throws {
    let appTransport = StartFakeTransport()
    let plist = ["FIREWEAVE_BROWSER_KEY": testBrowserKey]
    let appHandle = makeHandle(makeSources(plist: plist, profile: .app))
    try appHandle.core.start(refreshing(appTransport, every: .milliseconds(30)))
    await appHandle.ready()

    let serverTransport = StartFakeTransport()
    let serverHandle = server()
    try serverHandle.core.start(refreshing(serverTransport, every: .zero))
    await serverHandle.ready()

    try? await Task.sleep(nanoseconds: 300_000_000)
    #expect(appTransport.evaluations().count == 1)
    #expect(serverTransport.evaluations().count == 1)
    await appHandle.shutdown()
    await serverHandle.shutdown()
  }

  // MARK: - SP-27: one line per kind of fw-server failure

  @Test func aRefusedKeyLogsOneLineNamingTheVariableNeverTheKey() async throws {
    let log = LogCollector()
    let transport = StartFakeTransport(statusCode: 401)
    let handle = server()
    let options = refreshing(transport, every: .milliseconds(30), log: log)
    try handle.core.start(options)
    await handle.ready()
    #expect(handle.status.state == .error)
    #expect(handle.status.lastErrorKind == .authentication)

    let more = await eventually { transport.evaluations().count >= 4 }
    #expect(more)
    let line = "rejected the key from FIREWEAVE_KEY (HTTP 401)"
    #expect(log.count(containing: line) == 1)
    #expect(log.count(containing: "Reads serve their defaults.") == 1)
    #expect(log.lines.allSatisfy { !$0.contains(testProjectKey) })
    #expect(!String(describing: handle.status).contains(testProjectKey))

    // For the life of the process: a new start does not log it again.
    await handle.shutdown()
    try handle.core.start(options)
    await handle.ready()
    #expect(log.count(containing: line) == 1)
    await handle.shutdown()
  }

  @Test func eachRefusalKindLogsItsOwnLine() async throws {
    let (forbidden, forbiddenLog) = try await firstFetch(answering: 403)
    #expect(forbidden.lastErrorKind == .authorization)
    #expect(forbiddenLog.count(containing: "for this project or environment (HTTP 403)") == 1)

    let (limited, limitedLog) = try await firstFetch(answering: 429)
    #expect(limited.lastErrorKind == .rateLimited)
    #expect(limitedLog.count(containing: "rate-limited the key from FIREWEAVE_KEY (HTTP 429)") == 1)
  }

  @Test func localModeReportsNoRemoteError() async throws {
    let log = LogCollector()
    let handle = server()
    try handle.core.start(FireweaveStartOptions(mode: .local, log: log.sink))
    await handle.ready()
    #expect(handle.status.lastErrorKind == nil)
    #expect(log.count(containing: "fw-server at") == 0)
    await handle.shutdown()
  }

  /// The status after a server's first prefetch is answered with `code`,
  /// and the lines it logged.
  private func firstFetch(answering code: Int) async throws -> (FireweaveStatus, LogCollector) {
    let log = LogCollector()
    let handle = server()
    let transport = StartFakeTransport(statusCode: code)
    try handle.core.start(FireweaveStartOptions(log: log.sink, transport: transport))
    await handle.ready()
    let status = handle.status
    await handle.shutdown()
    return (status, log)
  }
}
