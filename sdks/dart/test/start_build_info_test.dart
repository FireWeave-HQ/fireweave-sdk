@TestOn('vm')
library;

import 'dart:io';

import 'package:fireweave/fireweave.dart';
import 'package:fireweave/src/start/build_info.dart';
import 'package:fireweave/src/start/channel.dart';
import 'package:test/test.dart';

/// The start profile's default endpoint comes from this build's release
/// channel, stamped into lib/src/start/build_info.dart by
/// `tools/release/version.sh apply dart`. A release that forgets to stamp
/// fails here.
String pubspecVersion() {
  final pubspec = File(
    '${Directory.current.path}/pubspec.yaml',
  ).readAsStringSync();
  final match = RegExp(
    r'^version:\s*(\S+)\s*$',
    multiLine: true,
  ).firstMatch(pubspec);
  if (match == null) {
    fail('pubspec.yaml has no version: line');
  }
  return match.group(1)!;
}

void main() {
  test('buildSdkVersion is the pubspec version', () {
    expect(buildSdkVersion, pubspecVersion());
  });

  test('the channel is staging iff the version is a -rc. build', () {
    final staging = buildSdkVersion.contains('-rc.');
    expect(buildSdkChannel, staging ? 'staging' : 'production');
    expect(<String>{'staging', 'production'}, contains(buildSdkChannel));
    expect(sdkChannel, channelForVersion(buildSdkVersion));
    expect(sdkVersion, buildSdkVersion);
  });

  test('channelForVersion: only -rc.N is staging', () {
    expect(channelForVersion('2.4.0-rc.3'), SdkChannel.staging);
    expect(channelForVersion('2.4.0'), SdkChannel.production);
    expect(channelForVersion('2.4.0-rc'), SdkChannel.production);
    expect(channelForVersion('2.4.0-beta.1'), SdkChannel.production);
    // -staging.N stopped being a staging spelling at 3.0.0.
    expect(channelForVersion('2.4.0-staging.3'), SdkChannel.production);
    expect(channelForVersion('2.4.0-staging'), SdkChannel.production);
  });

  test('each channel defaults to its own fw-server host', () {
    expect(SdkChannel.production.defaultUrl, 'https://app-server.fireweave.ai');
    expect(
      SdkChannel.staging.defaultUrl,
      'https://staging-app-server.fireweave.ai',
    );
  });

  test('the core default allowlist admits both channel hosts', () {
    for (final channel in SdkChannel.values) {
      final host = Uri.parse(channel.defaultUrl).host;
      expect(defaultAllowedHosts, contains(host));
      expect(
        () => assertHostAllowed(channel.defaultUrl, initFatal: true),
        returnsNormally,
      );
    }
  });
}
