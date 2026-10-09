/// The release channel this build of the package came from. It chooses the
/// default fw-server endpoint (docs/adr/0012-start-profile.md, rule 3).
library;

import 'build_info.dart';
import 'names.dart';

/// Release channel of an SDK build.
enum SdkChannel {
  production,
  staging;

  /// The fw-server this channel's builds call by default. Both hosts are in
  /// the core's default allowlist, so the default needs no custom one.
  String get defaultUrl => switch (this) {
    SdkChannel.production => productionUrl,
    SdkChannel.staging => stagingUrl,
  };
}

/// The channel rule as a pure function of a package version:
/// `tools/release/version.sh` stamps a staging release `X.Y.Z-staging.N`.
/// Anything else is production.
SdkChannel channelForVersion(String version) =>
    version.contains('-staging.') ? SdkChannel.staging : SdkChannel.production;

/// This build's channel, from the stamp `version.sh apply dart` writes.
SdkChannel get sdkChannel =>
    buildSdkChannel == 'staging' ? SdkChannel.staging : SdkChannel.production;

/// This build's package version, from the same stamp.
String get sdkVersion => buildSdkVersion;
