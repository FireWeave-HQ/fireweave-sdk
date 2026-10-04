/// Backend adapter boundary (mirrors `sdks/web`'s `WebBackendAdapter` and
/// swift's `ControlPointsBackendAdapter` — ADR-0009's seam).
///
/// One shape difference from node/go/java/rust's per-call `resolve(key)`
/// port is the whole reason this SDK can offer a synchronous `evaluate()`:
/// this port has `prefetch(context)`, which returns EVERY decision for a
/// context in one round trip. Evaluation then becomes a synchronous map
/// lookup in `FireweaveRuntime` — never an adapter call.
///
/// The reason is not performance: a Flutter `build()` cannot await, so
/// nothing on the read surface may need to suspend. Both
/// `FireweaveLocalAdapter` and `FireweaveRemoteAdapter` implement this SAME
/// port (`spec/modes.md`: "Both modes expose the identical nine methods with
/// identical signatures"), so `FireweaveRuntime`/`FireweaveClient` stay
/// mode-blind.
library;

import '../domain/context.dart';
import '../domain/decision.dart';
import '../domain/errors.dart';
import '../domain/target.dart';
import '../domain/types.dart';

/// Every decision the backend returned for one context, keyed by control
/// point.
typedef PrefetchResult = Map<String, AdapterResolution>;

/// Sink for the `[fireweave:local]` `registerTarget` trace line. Injectable
/// so tests assert the call without capturing stdout, and so a host that
/// owns its logging can route it (`spec/modes.md` "The ... log sink MUST be
/// injectable").
typedef LogSink = void Function(String message);

class PrefetchOptions {
  const PrefetchOptions({this.flagKeys});

  /// Restrict the batch to these keys; omit to let the backend return all
  /// it knows.
  final List<String>? flagKeys;
}

/// Vendor-neutral outcome of resolving one flag, as returned in a
/// [PrefetchResult] batch.
///
/// **[found] has a dual meaning that callers must not conflate**:
///
/// 1. **Present in the map with `found: false`** — the definition EXISTS but
///    its targeting conditions did not select this caller
///    (`InMemoryAdapter`'s matchAttribute/matchGroups/matchPerson/
///    matchTargetingKey). `FireweaveRuntime.evaluate` reads this as
///    `DecisionReason.defaultReason` UNCONDITIONALLY — "no decision for this
///    key/context" is a claim about the flag's own targeting, not about the
///    adapter's miss policy.
/// 2. **ABSENT from the map entirely** — governed by
///    [ControlPointsBackendAdapter.missReason]: `FireweaveLocalAdapter`
///    reports `defaultReason` here too (`spec/modes.md` "Behaviour per
///    mode": local mode's unknown-key row), while `FireweaveRemoteAdapter`/
///    `InMemoryAdapter` leave `missReason` `null` and an absent key resolves
///    to `ERROR`/`FlagNotFound` instead.
///
/// [vendorFlagId]/[reasonCode] are a PRE-GATED pair
/// (`spec/decision.schema.json` `standardMetadataKeys`, ruling 11): the
/// runtime emits `fireweave.vendorFlagId`/`fireweave.reasonCode` together,
/// or neither — never one alone. The gate is applied where the raw
/// "condition index" signal exists as adapter input (`InMemoryAdapter`),
/// before this resolution is constructed.
class AdapterResolution {
  const AdapterResolution({
    this.found = true,
    this.enabled,
    this.value,
    this.variant,
    this.flagType,
    this.reason,
    this.reasonCode,
    this.version,
    this.vendorFlagId,
    this.payload,
    this.fromCache = false,
  });

  final bool found;
  final bool? enabled;
  final JsonValue value;
  final String? variant;
  final FlagType? flagType;
  final DecisionReason? reason;
  final String? reasonCode;
  final int? version;
  final int? vendorFlagId;
  final JsonValue payload;
  final bool fromCache;

  /// Plain-JSON snapshot; used to detect changed keys across prefetches.
  Map<String, Object?> toJson() => <String, Object?>{
    'found': found,
    'enabled': enabled,
    'value': value,
    'variant': variant,
    'flagType': flagType?.wireName,
    'reason': reason?.wireName,
    'reasonCode': reasonCode,
    'version': version,
    'vendorFlagId': vendorFlagId,
    'payload': payload,
    'fromCache': fromCache,
  };
}

class RegisterTargetOptions {
  const RegisterTargetOptions({this.kind, this.properties, this.environment});

  final TargetKind? kind;
  final Map<String, Object?>? properties;
  final String? environment;
}

/// Outcome of target registration.
///
/// `ok: false` means the target was NOT registered — rules that depend on
/// its properties will not match until a later attempt succeeds. Callers in
/// a sign-in path normally ignore this; a careful caller logs it — a
/// silently unregistered target is exactly how targeting rules end up
/// matching nobody.
class RegisterTargetResult {
  const RegisterTargetResult._({required this.ok, this.error});

  const RegisterTargetResult.success() : this._(ok: true);

  const RegisterTargetResult.failure(FireweaveError error)
    : this._(ok: false, error: error);

  final bool ok;
  final FireweaveError? error;
}

/// `evaluate()`'s reserved fifth argument
/// (`conformance/surface/control-points.surface.json`:
/// `evaluate(key, type, default, context?, options?)`).
///
/// [includePayload] is FUNCTIONAL here, as in swift (and unlike web's inert
/// options): payload attachment is genuine v1 surface
/// (`Decision.flagMetadata['fireweave.payload']`), this SDK runs the shared
/// 65 fixtures for real (`eval-payload-attached`), and
/// [AdapterResolution.payload] already carries the raw payload from prefetch
/// to the read.
class EvaluateOptions {
  const EvaluateOptions({this.includePayload = false});

  final bool includePayload;
}

/// One HTTP response as seen by the remote adapter.
class TransportResponse {
  const TransportResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// Injectable HTTP transport — the ONE place this SDK touches the network.
///
/// A platform default is chosen by conditional import on every Dart target:
/// `dart:io`'s `HttpClient` on the VM and on Flutter for Android, iOS,
/// macOS, Windows, and Linux; the browser's `fetch` (via `dart:js_interop`)
/// on Flutter web and under `dart compile js`/`wasm`. Tests inject a fake;
/// an app with its own HTTP stack can inject that instead.
///
/// Implementations MUST throw a [FireweaveError] of kind `Timeout` or
/// `Network` for transport-level failures; the adapter maps HTTP status
/// codes itself.
abstract interface class HttpTransport {
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  });
}

/// Protocol every Fireweave backend adapter implements.
abstract interface class ControlPointsBackendAdapter {
  /// Miss-reason override for a control point ABSENT from the prefetch
  /// result (`spec/modes.md` "Behaviour per mode": local mode's unknown-key
  /// row is `default`/reason `DEFAULT`, not an error — unlike remote's
  /// `default`/`ERROR`/`FlagNotFound`). `FireweaveLocalAdapter` returns
  /// `DecisionReason.defaultReason` here; `FireweaveRemoteAdapter` and
  /// `InMemoryAdapter` return `null` and keep the FlagNotFound/ERROR path.
  DecisionReason? get missReason;

  /// Bring the backend to a usable state. Throws [FireweaveError] on fatal
  /// config.
  Future<void> initialize();

  /// Fetch every decision for a context in one round trip. Throws
  /// [FireweaveError] on transport faults.
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  });

  /// Register a target. Resolves rather than throws — this runs in sign-in
  /// paths, where a targeting concern must not break authentication.
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  });

  /// Deterministically release resources. Idempotent; must never throw.
  Future<void> shutdown();
}
