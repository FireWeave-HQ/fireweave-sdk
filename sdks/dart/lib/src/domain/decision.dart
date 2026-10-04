import 'errors.dart';
import 'types.dart';

/// Canonical reason strings (`spec/decision.schema.json`).
///
/// `default` and `static` are reserved words in Dart, hence
/// [defaultReason] / [staticReason] — the wire names are unchanged.
enum DecisionReason {
  targetingMatch('TARGETING_MATCH'),
  split('SPLIT'),
  disabled('DISABLED'),
  defaultReason('DEFAULT'),
  stale('STALE'),
  cached('CACHED'),
  staticReason('STATIC'),
  error('ERROR');

  const DecisionReason(this.wireName);

  /// The reason string `contracts/` fixtures and the wire protocol use.
  final String wireName;

  /// Parses a wire name; `null` when it is not one of the eight.
  static DecisionReason? fromWireName(String raw) {
    for (final reason in values) {
      if (reason.wireName == raw) {
        return reason;
      }
    }
    return null;
  }
}

/// Result of a flag evaluation. Evaluation APIs return this, never throw
/// (`spec/control-points.md` "Return discipline — never throw into a read
/// path").
class Decision {
  const Decision({
    required this.value,
    this.variant,
    required this.reason,
    this.errorCode,
    this.errorMessage,
    this.errorKind,
    this.flagMetadata = const <String, Object?>{},
  });

  final JsonValue value;
  final String? variant;
  final DecisionReason reason;
  final String? errorCode;
  final String? errorMessage;
  final ErrorKind? errorKind;
  final FlagMetadata flagMetadata;

  bool get isError => reason == DecisionReason.error;

  /// Plain-JSON snapshot in the shape `contracts/` fixtures compare against.
  Map<String, Object?> toJson() => <String, Object?>{
    'value': value,
    'variant': variant,
    'reason': reason.wireName,
    'errorCode': errorCode,
    'errorMessage': errorMessage,
    'flagMetadata': flagMetadata,
  };

  @override
  String toString() =>
      'Decision(${reason.wireName} value=$value variant=$variant '
      'errorKind=${errorKind?.wireName} metadata=$flagMetadata)';
}
