<a href="https://app.fireweave.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png">
    <img alt="Fireweave — agents write the code. We watch every rollout, under control." src="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/FireWeave-HQ/fireweave-sdk/tree/main/sdks/swift"><img alt="swift" src="https://img.shields.io/badge/swift-from%20source-ED5502?logo=swift&style=flat&labelColor=0E0E10&logoColor=white"></a>
</p>

**Fireweave is the AI release engineer for teams shipping with coding agents.** Every change rolls out behind a control point, one step at a time, with guardrails watching real users — and if something breaks, Fireweave pauses or rolls it back before most users ever see it. It's the only way to ship as fast as your agents write code, without the fear of breaking production.

## Quick start · Swift · iOS · macOS

```bash
# Not on a registry yet: clone next to your package
git clone https://github.com/FireWeave-HQ/fireweave-sdk
```

```swift
// Package.swift (swift-tools-version: 6.0)
platforms: [.macOS(.v13), .iOS(.v16)],
dependencies: [.package(path: "../fireweave-sdk/sdks/swift")],
// in your target
dependencies: [.product(name: "Fireweave", package: "swift")]
```

```swift
import Fireweave
import Foundation

let env = ProcessInfo.processInfo.environment
let fireweave = try await initFireweave(.remote(InitFireweaveRemoteOptions(
    apiKey: env["FW_PROJECT_API_KEY"] ?? "",
    apiUrl: env["FW_API_URL"] ?? ""
)))

// Once per login: register the target, then prefetch its decisions.
_ = await fireweave.identify("user_42", options: RegisterTargetOptions(
    kind: .user, properties: ["plan": "pro"]
))

// Reads are synchronous lookups in that prefetched cache.
let enabled = fireweave.controlPoints.getBooleanValue("new-checkout", default: false)
print("new-checkout: \(enabled)")

await fireweave.shutdown()
```

## Learn more

[Concepts](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/concepts.md) · [Identity](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/identity.md) · [Testing](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/testing.md) · [Troubleshooting](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/troubleshooting.md) · [All SDKs](https://github.com/FireWeave-HQ/fireweave-sdk#quick-start)

## License

[MIT](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/LICENSE)
