/// The flags map: every control point the app reads, with the value served
/// in local mode. It lives in its own file (`lib/fireweave/flags.dart` by
/// convention) and is passed as `Fireweave.start(flags: flags)`.
///
/// It holds local values only. In remote mode fw-server and the rollout
/// decide, and call sites keep `false` as their default, so a flags file can
/// never switch a feature on in production.
library;

import 'package:fireweave/fireweave.dart';

/// One control point the app reads.
final class Flag {
  /// [localValue] is served in local mode and ignored in remote mode.
  const Flag.local(this.localValue, {this.description});

  /// Value served in local mode. Ignored in remote mode.
  final bool localValue;

  /// Optional note for humans and agents. Never sent anywhere.
  final String? description;

  @override
  bool operator ==(Object other) =>
      other is Flag &&
      other.localValue == localValue &&
      other.description == description;

  @override
  int get hashCode => Object.hash(localValue, description);

  @override
  String toString() => 'Flag.local($localValue)';
}

FireweaveError _configError(String message) =>
    FireweaveError.configuration(message, initFatal: true);

/// Checks every key with the core's control point key rule and returns an
/// unmodifiable copy. Throws a `Configuration` [FireweaveError] naming the
/// bad key.
Map<String, Flag> normalizeFlags(Map<String, Flag>? flags) {
  if (flags == null || flags.isEmpty) {
    return const <String, Flag>{};
  }
  final keys = flags.keys.toList()..sort();
  for (final key in keys) {
    if (validateControlPointKey(key) case Invalid(:final error)) {
      throw _configError(
        "[fireweave] flags: '$key' is not a valid control point key "
        '(${error.message}).',
      );
    }
  }
  return Map<String, Flag>.unmodifiable(<String, Flag>{
    for (final key in keys) key: flags[key]!,
  });
}

/// Declare the app's control points. Returns an unmodifiable copy, checked
/// with the core's key rule, so a typo fails where it was made:
///
/// ```dart
/// // lib/fireweave/flags.dart
/// final flags = defineFlags({
///   'new-checkout': Flag.local(true, description: 'New checkout flow'),
/// });
/// ```
Map<String, Flag> defineFlags(Map<String, Flag> flags) => normalizeFlags(flags);

/// The core local adapter's seed map.
Map<String, bool> localSeeds(Map<String, Flag> flags) => <String, bool>{
  for (final entry in flags.entries) entry.key: entry.value.localValue,
};

/// Canonical rendering of the local values, for the idempotency check.
String flagsSignature(Map<String, Flag> flags) {
  final keys = flags.keys.toList()..sort();
  return keys.map((k) => '${k.length}:$k=${flags[k]!.localValue}').join(';');
}
