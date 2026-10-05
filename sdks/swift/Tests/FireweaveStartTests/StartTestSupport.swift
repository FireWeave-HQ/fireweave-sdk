import Foundation
import Testing

@testable import FireweaveStart

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

let testProjectKey = "project-api-key_test123"
let testBrowserKey = "fw_public_test123"

/// Builds an analytics-vendor key prefix without writing one as a literal
/// (the core redactor and the repo's vendor-leak guards look for them).
func vendorPrefix(_ letter: String) -> String {
  "ph" + letter + "_"
}

/// The error a throwing call raised, if it was a `FireweaveError`.
func startError(_ body: () throws -> Void) -> FireweaveError? {
  do {
    try body()
    return nil
  } catch let error as FireweaveError {
    return error
  } catch {
    return nil
  }
}

/// Sources for one test: no process environment, no Info.plist, no
/// UserDefaults. Everything the start profile reads comes from here.
func makeSources(
  env: [String: String] = [:],
  plist: [String: String] = [:],
  host: String? = "api-pod-1",
  profile: FireweaveProfile = .server,
  debug: Bool = false,
  channel: FireweaveChannel = .production,
  store: any DeviceIdStoring = RecordingDeviceIdStore()
) -> StartSources {
  StartSources(
    env: { name in nonBlank(env[name]) },
    infoPlist: { name in nonBlank(plist[name]) },
    hostName: { host },
    platformProfile: profile,
    isDebugBuild: debug,
    channel: channel,
    sdkVersion: channel == .staging ? "2.3.0-staging.1" : "2.2.0",
    makeStore: { store }
  )
}

/// A handle of its own, so tests never share the process-wide `fw`.
func makeHandle(_ sources: StartSources) -> FireweaveHandle {
  FireweaveHandle(core: StartCore(sources: sources))
}

/// Collects `[fireweave]` lines.
final class LogCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var collected: [String] = []

  var sink: LogSink {
    return { [self] line in
      self.append(line)
    }
  }

  var lines: [String] {
    lock.locked { collected }
  }

  func append(_ line: String) {
    lock.locked {
      collected.append(line)
    }
  }

  func count(containing text: String) -> Int {
    lines.filter { $0.contains(text) }.count
  }
}

/// An in-memory device-id store that counts writes.
final class RecordingDeviceIdStore: DeviceIdStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  private var saves = 0

  init(initial: String? = nil) {
    value = initial
  }

  var stored: String? {
    lock.locked { value }
  }

  var saveCount: Int {
    lock.locked { saves }
  }

  func load() -> String? {
    lock.locked { value }
  }

  func save(_ deviceId: String) {
    lock.locked {
      value = deviceId
      saves += 1
    }
  }

  func remove() {
    lock.locked {
      value = nil
    }
  }
}

/// One request the fake transport received.
struct RecordedRequest: Sendable {
  var path: String
  var targetingKey: String?
  var authorization: String?
  var body: JSONValue
}

/// Answers `/v1/flags/evaluate` with the current decisions and every other
/// path with `{}`, after an optional delay, recording what was sent. The
/// status and the decisions can change mid-test.
final class StartFakeTransport: RemoteHTTPTransport, @unchecked Sendable {
  static let newCheckoutOn = """
    {"decisions":[{"flagKey":"new-checkout","value":true,"variant":"on",\
    "reason":"TARGETING_MATCH","found":true,"enabled":true}]}
    """

  static let newCheckoutOff = """
    {"decisions":[{"flagKey":"new-checkout","value":false,"variant":"off",\
    "reason":"TARGETING_MATCH","found":true,"enabled":true}]}
    """

  private let lock = NSLock()
  private var statusCode: Int
  private let delayNs: UInt64
  private var decisionsJSON: String
  private var recorded: [RecordedRequest] = []

  init(
    statusCode: Int = 200,
    delayNs: UInt64 = 0,
    decisionsJSON: String = StartFakeTransport.newCheckoutOn
  ) {
    self.statusCode = statusCode
    self.delayNs = delayNs
    self.decisionsJSON = decisionsJSON
  }

  var requests: [RecordedRequest] {
    lock.locked { recorded }
  }

  func evaluations() -> [RecordedRequest] {
    requests.filter { $0.path.hasSuffix("/v1/flags/evaluate") }
  }

  func registrations() -> [RecordedRequest] {
    requests.filter { $0.path.hasSuffix("/v1/targets/register") }
  }

  /// The HTTP status of every later response.
  func setStatusCode(_ code: Int) {
    lock.locked {
      statusCode = code
    }
  }

  /// The evaluate body of every later response.
  func setDecisions(_ json: String) {
    lock.locked {
      decisionsJSON = json
    }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    if delayNs > 0 {
      try await Task.sleep(nanoseconds: delayNs)
    }
    let path = request.url?.path ?? ""
    let body = request.httpBody.flatMap { try? JSONValue.parse(data: $0) } ?? .null
    let record = RecordedRequest(
      path: path,
      targetingKey: body.objectValue?["targetingKey"]?.stringValue,
      authorization: request.value(forHTTPHeaderField: "Authorization"),
      body: body
    )
    let (status, decisions) = lock.locked { () -> (Int, String) in
      recorded.append(record)
      return (statusCode, decisionsJSON)
    }
    let json = path.hasSuffix("/v1/flags/evaluate") ? decisions : "{}"
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: nil
    )!
    return (Data(json.utf8), response)
  }
}

/// Polls `condition` every 20 ms until it holds or `seconds` pass, and
/// returns whether it held.
func eventually(within seconds: Double = 3, _ condition: () -> Bool) async -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 20_000_000)
  }
  return condition()
}
