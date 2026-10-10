import Foundation

/// The release channel this SDK build came from. It chooses the default
/// fw-server endpoint (docs/adr/0012-start-profile.md, rule 3).
public enum FireweaveChannel: String, Sendable, Equatable {
  case production
  case staging

  /// The fw-server this channel's builds call when no `url` is configured.
  /// Both hosts are in the core's `defaultAllowedHosts`, so the default
  /// endpoint needs no allowlist of its own.
  public var defaultURL: String {
    switch self {
    case .production: return "https://app-server.fireweave.ai"
    case .staging: return "https://staging-app-server.fireweave.ai"
    }
  }

  /// This build's channel: the stamp `tools/release/version.sh apply swift`
  /// writes into `BuildInfo.swift`, or the channel of its version if the
  /// stamp is ever unreadable.
  static var current: FireweaveChannel {
    FireweaveChannel(rawValue: BuildInfo.sdkChannel) ?? channelForVersion(BuildInfo.sdkVersion)
  }
}

/// The channel rule, as a pure function of a version string: a release
/// script staging version (`X.Y.Z-rc.N`) is staging, anything else is
/// production, including `-staging.N`, which stopped being a staging
/// spelling at 3.0.0.
func channelForVersion(_ version: String) -> FireweaveChannel {
  version.contains("-rc.") ? .staging : .production
}
