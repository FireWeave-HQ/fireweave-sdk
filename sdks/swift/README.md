# Fireweave Swift SDK

SwiftPM package for iOS 16+, macOS 13+ and Linux servers (Swift 6). Two library products:

- **`FireweaveStart`**: the start profile. One `startFireweave()` call at launch, then reads from
  anywhere through `fw`. Most apps need only this.
- **`Fireweave`**: the core. Exactly two v1 capabilities ([spec/control-points.md](../../spec/control-points.md)
  "Scope of v1"): control points (the nine methods) and target registration. It reads no
  environment and never infers a mode. `FireweaveStart` re-exports it.

No external package dependencies: Foundation only.

## Install

Not on a registry yet. Clone next to your package and depend on it by path:

```bash
git clone --branch swift/v2.2.0 https://github.com/FireWeave-HQ/fireweave-sdk
```

```swift
// Package.swift (swift-tools-version: 6.0)
platforms: [.macOS(.v13), .iOS(.v16)],
dependencies: [.package(path: "../fireweave-sdk/sdks/swift")],
// in your target
dependencies: [.product(name: "FireweaveStart", package: "swift")]
```

In an Xcode project, add the cloned `sdks/swift` folder as a local package and link
`FireweaveStart` to the app target. Link it into exactly one binary image: an app and an
embedded framework that both link it statically each get their own `fw`.

## Quick start (one line: the start profile)

The start profile ([ADR-0012](../../docs/adr/0012-start-profile.md)) replaces the generated
`FwHarness.swift` / `FwProviders.swift` files with one call and one flags file. The core API
below (`initFireweave`) is unchanged.

```swift
// FireweaveFlags.swift: every control point the app reads, with its local value
import FireweaveStart

let appFlags = defineFlags([
  "new-checkout": .local(true, description: "New checkout flow"),  // served only in local mode
])
```

**App** (SwiftUI `App.init()`, or the first line of UIKit's
`application(_:didFinishLaunchingWithOptions:)`):

```swift
import FireweaveStart

@main struct ShopApp: App {
  init() { try! startFireweave(flags: appFlags) }
  var body: some Scene { WindowGroup { RootView() } }
}
```

**Server** (Vapor `configure`, Hummingbird, a worker or a CLI `main`):

```swift
import FireweaveStart

public func configure(_ app: Application) async throws {
  try startFireweave(flags: appFlags)
  await fw.ready()  // the first request sees decisions
}
```

**Anywhere** (the core's nine read methods, unchanged; synchronous, never throw):

```swift
// @fireweave-controlpoint new-checkout
if fw.controlPoints.getBooleanValue("new-checkout", default: false) { showNewCheckout() }

await fw.identify(user.id, properties: ["plan": "pro"])  // sign-in / session restore
await fw.reset()                                         // app sign-out: back to the device id
fw.deviceId                                              // app: the anonymous key, for analytics joins
fw.setPersistence(.memory)                               // app consent withdrawn; fw.forget() also mints a new id
fw.instanceKey()                                         // server: the process's own targeting key
fw.status                                                // mode, channel, host, key source, problem; never the key
for await state in fw.updates { rerender() }             // after start, identify, reset and forget
```

`startFireweave` is synchronous: it resolves the configuration, throws before any network
I/O if it is wrong, and starts the first prefetch in the background. Until that prefetch
settles, remote reads return your default; local reads answer from your flags from the very
first read. SwiftUI does not re-render when decisions arrive: `await fw.ready()` before the
first screen, or observe `fw.updates`.

### Where the key comes from

**Apps** read Info.plist, so the key is baked into the build and nothing depends on the
Xcode scheme's environment (which a device build does not have). Use a **browser key**
(`fw_public_…`) from Project settings, API keys:

```xml
<!-- Info.plist -->
<key>FIREWEAVE_BROWSER_KEY</key>
<string>$(FIREWEAVE_BROWSER_KEY)</string>
```

```
// Fireweave.xcconfig (tracked), set as the target's base configuration
#include? "Fireweave.local.xcconfig"

// Fireweave.local.xcconfig (gitignored), or set FIREWEAVE_BROWSER_KEY in CI / Xcode Cloud
FIREWEAVE_BROWSER_KEY = fw_public_...
```

An undefined `$(FIREWEAVE_BROWSER_KEY)` expands to an empty string, which counts as unset.
`FIREWEAVE_URL` and `FIREWEAVE_ENV` work the same way. A server key (`project-api-key_…`) is
refused at start with an instruction to revoke it: anything in an app bundle can be read by
anyone who downloads the app.

**Servers** read the process environment. Deployed environments set one variable,
`FIREWEAVE_KEY` (the project key, `project-api-key_…`). Local development needs nothing when
`FIREWEAVE_ENV` (or `APP_ENV`) is `development`, `dev`, `local` or `test`.

### Options and overrides

Each value resolves as: the `startFireweave` option, then Info.plist (app) or the
environment (server), then a legacy name (warns once), then the default. Empty and
whitespace-only values count as unset.

| Option | App (Info.plist) | Server (environment) | Default | What it does |
| --- | --- | --- | --- | --- |
| `flags` | — | — | `[:]` | Local values per control point (`defineFlags`). Served in local mode only; a read of a key missing from them warns once. |
| `mode` | — | — | inferred | `.remote` or `.local`. Remote without a key throws; local ignores a key (one warning). |
| `environment` | `FIREWEAVE_ENV` | `FIREWEAVE_ENV`, then `APP_ENV` | — | Only feeds the mode rule. `FW_ENV` is not read. |
| `url` | `FIREWEAVE_URL` (legacy `FWApiUrl`) | `FIREWEAVE_URL` (legacy `FW_API_URL`, `FW_ATTEST_URL`) | this SDK build's channel | A `-staging.N` build calls `https://staging-app-server.fireweave.ai`, any other `https://app-server.fireweave.ai`. https is required except on localhost; an override's allowlist is its own host plus loopback. |
| `key` | `FIREWEAVE_BROWSER_KEY` | `FIREWEAVE_KEY` (legacy `FW_PROJECT_API_KEY`) | — | App: browser keys only. Server: project keys; browser keys are refused. Analytics vendor keys and org/CLI tokens are refused in both. Messages name the source, never the value. |
| `profile` | — | — | from the platform | `.app` on iOS, iPadOS, Mac Catalyst and macOS `.app`/`.appex` bundles; `.server` on Linux and bare macOS executables. |
| `deviceId` | — | — | stored `dev_<UUID>` | App: an app-owned anonymous id (for example your analytics id), used verbatim and never stored. |
| `persistence` | — | — | `.userDefaults` | App: `.userDefaults` keeps the id at `fireweave.device-id` (the scaffolded harness's key, so existing installs keep their ramp buckets); `.memory` stores nothing until `fw.setPersistence(.userDefaults)`. |
| `instanceId` | — | `FIREWEAVE_INSTANCE_ID` | `inst_` + hash of the host name | Server: the value of `fw.instanceKey()` and the key the process prefetches under. Set it when replicas share a host name. |
| `log` | — | — | unified log (Apple), stderr (Linux) | Receives every `[fireweave]` line. |

`FireweaveStartOptions` adds three test seams: `env` and `infoPlist` (lookups that replace the
environment and Info.plist) and `transport` (a `RemoteHTTPTransport`, for a fake server or a
custom `URLSession`). Call `startFireweave(FireweaveStartOptions(...))` to use them, and
`await resetFireweaveForTesting()` between tests.

**Mode rule.** `mode` wins. Otherwise: a key means remote. No key and a development
environment name means local. An app's **debug** build with no environment name counts as
development (the `FireweaveStart` target's own `FIREWEAVE_START_DEBUG` flag); a release build
never does. Anything else throws a `FireweaveError` of kind `.configuration` naming
`FIREWEAVE_BROWSER_KEY` (app) or `FIREWEAVE_KEY` (server), so a TestFlight or App Store build
that lost its key crashes at launch under `try!` instead of silently serving defaults. Use
`try?` if you would rather degrade to defaults.

**Reads never throw.** Before `startFireweave`, and until the first remote prefetch settles,
reads return your default (the `*Details` forms return an `ERROR` decision with `NotReady`).
A refused key or an unreachable fw-server shows up as `ERROR` decisions and in
`fw.status.problem`, never as a throw. A second `startFireweave` with the same configuration
is a no-op; a different one throws and leaves the running client alone. After
`await fw.shutdown()`, reads serve defaults (`AlreadyClosed`) until the next `startFireweave`,
which may use any configuration.

**Identity.** In an app, decisions are prefetched for the device id until `fw.identify`, then
for the user; `fw.reset()` goes back to the device id. `identify`, `reset` and `forget` run one
at a time, in call order. A server prefetches once for `fw.instanceKey()`; `fw.identify` there
registers the user's targeting properties and does not change the process's decisions, and a
per-call `context` is validated but does not select a decision.

**Debugging.** `fw.status` reports the state, profile, mode and why (`option`, `key` or
`environment`), channel, SDK version, fw-server host, endpoint source, key source, environment
name, flag count and problem. It never contains the key, so it is safe to log or send to a
crash reporter:

```swift
print("fireweave:", fw.status)
```

## The core API

Without the start profile, build the client yourself. `mode` is required and nothing is read
from the environment:

```swift
import Fireweave

let fireweave = try await initFireweave(.remote(InitFireweaveRemoteOptions(
  apiKey: projectKey,
  apiUrl: "https://app-server.fireweave.ai",
  context: EvaluationContext(targetingKey: "user_42")
)))
fireweave.controlPoints.getBooleanValue("new-checkout", default: false)
await fireweave.shutdown()
```
