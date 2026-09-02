import 'dart:convert';

/// Shared public types for the Fireweave SDK.
///
/// No vendor-backend or OpenFeature-provider types appear here — these are
/// the canonical Fireweave-owned shapes per `spec/` v0.1.0.

/// JSON-compatible value (`spec/decision.schema.json` `$defs.jsonValue`).
///
/// The plain tree `dart:convert` produces — `null`, `bool`, `num`, `String`,
/// `List<Object?>`, `Map<String, Object?>` — rather than a hand-rolled
/// wrapper: it is what a Dart caller already holds after `jsonDecode`, and
/// `getObjectValue` hands it straight back. Dart's `int` is 64-bit on the
/// VM, so integers beyond 2^53 survive a round trip losslessly there.
typedef JsonValue = Object?;

/// A JSON object (`Map<String, Object?>`).
typedef JsonObject = Map<String, Object?>;

/// `flagMetadata` values per `spec/decision.schema.json`: `bool | String | num`.
typedef FlagMetadata = Map<String, Object?>;

/// Requested flag value type for typed evaluation (`spec/control-points.md`
/// "The nine methods"). Exactly four members: boolean, string, number,
/// object — there is no separate integer/float distinction in v1
/// (`Decision.value` is `jsonValue`; `getNumberValue` returns **number**,
/// not integer).
enum FlagType {
  boolean('boolean'),
  string('string'),
  number('number'),
  object('object');

  const FlagType(this.wireName);

  /// The `flagType` string used at the wire and fixture boundary.
  final String wireName;

  /// Parses a wire name; `null` when it is not one of the four.
  static FlagType? fromWireName(String raw) {
    for (final type in values) {
      if (type.wireName == raw) {
        return type;
      }
    }
    return null;
  }
}

/// Matches whether `value`'s runtime shape agrees with `expected`. Shared by
/// the default-value validator (before any I/O) and the runtime's
/// post-resolve check (after the cache read) — same predicate, two
/// different inputs.
bool matchesExpectedType(Object? value, FlagType expected) {
  switch (expected) {
    case FlagType.boolean:
      return value is bool;
    case FlagType.string:
      return value is String;
    case FlagType.number:
      return value is num;
    case FlagType.object:
      return value is Map || value is List;
  }
}

/// Deep structural equality over JSON trees. Numbers compare by value
/// (`2 == 2.0`), maps by key set and per-key equality, lists element-wise.
bool jsonEquals(Object? a, Object? b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) {
      return false;
    }
    for (final key in a.keys) {
      if (!b.containsKey(key) || !jsonEquals(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i += 1) {
      if (!jsonEquals(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (a is Map || b is Map || a is List || b is List) {
    return false;
  }
  return a == b;
}

Object? _withSortedKeys(Object? value) {
  if (value is Map) {
    final keys = value.keys.map((k) => k.toString()).toList()..sort();
    return <String, Object?>{
      for (final key in keys) key: _withSortedKeys(value[key]),
    };
  }
  if (value is List) {
    return value.map(_withSortedKeys).toList();
  }
  return value;
}

/// Serializes with sorted keys and no whitespace — the deterministic
/// ordering `spec/decision.schema.json`'s `fireweave.payload` stable-JSON-
/// string requirement needs (mirrors node/python's stable-stringify helper
/// and swift's `.sortedKeys` serialization).
String stableJsonString(Object? value) => jsonEncode(_withSortedKeys(value));

/// UTF-8 byte length of `text` — the unit every context bound is measured in
/// (`contracts/README.md` "Ratified context limits").
int utf8ByteLength(String text) => utf8.encode(text).length;
