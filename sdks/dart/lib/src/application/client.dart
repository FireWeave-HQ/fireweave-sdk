/// `FireweaveClient` — control-point evaluation and target registration
/// (`spec/control-points.md`): the only two v1 capabilities. Facade methods
/// degrade instead of throwing.
library;

import '../domain/context.dart';
import '../domain/decision.dart';
import '../domain/errors.dart';
import '../domain/types.dart';
import 'ports.dart';
import 'runtime.dart';

/// Result of [FireweaveClient.invokeCapability].
class ExtensionResult {
  const ExtensionResult._({
    required this.ok,
    this.errorKind,
    this.errorCode,
    this.errorMessage,
    this.degraded = false,
  });

  const ExtensionResult.success() : this._(ok: true);

  ExtensionResult.failure(FireweaveError error, {required bool degraded})
    : this._(
        ok: false,
        errorKind: error.kind,
        errorCode: error.openFeatureErrorCode,
        errorMessage: error.message,
        degraded: degraded,
      );

  final bool ok;
  final ErrorKind? errorKind;
  final String? errorCode;
  final String? errorMessage;
  final bool degraded;
}

/// Names [FireweaveClient.invokeCapability] will dispatch instead of
/// degrading with `UnsupportedCapability`. Empty in v1: releases, exposures,
/// signals, capabilities discovery, and guardrails are all out of scope
/// (`spec/control-points.md` "Scope of v1") and MUST NOT be exposed, so a
/// cut namespace's capability string resolves exactly like any other
/// unknown string.
const Set<String> _supportedCapabilities = <String>{};

/// Typed evaluation helpers — the nine methods (`spec/control-points.md`
/// "The nine methods"). A class with reference identity, so
/// `client.flags` (the deprecated alias) can be documented as SHARING
/// IDENTITY with `client.controlPoints` (ADR-0007): `identical(client.flags,
/// client.controlPoints)` holds.
///
/// Every method here is SYNCHRONOUS ("web's shape, not node's") —
/// [evaluate] is a pure cache read (`FireweaveRuntime.evaluate`), never an
/// `async` call, so it is safe inside a Flutter `build()`.
class ControlPointsNamespace {
  ControlPointsNamespace._(this._runtime);

  final FireweaveRuntime _runtime;

  /// Evaluate a flag to a canonical [Decision] — the general form the eight
  /// `get*` methods delegate to.
  ///
  /// [options] is the fifth argument pinned by
  /// `conformance/surface/control-points.surface.json`
  /// (`evaluate(key, type, default, context?, options?)`).
  Decision evaluate(
    String key,
    FlagType type,
    JsonValue defaultValue, {
    EvaluationContext? context,
    EvaluateOptions? options,
  }) => _runtime.evaluate(
    key,
    type,
    defaultValue,
    context: context,
    options: options,
  );

  bool getBooleanValue(
    String key,
    bool defaultValue, {
    EvaluationContext? context,
  }) {
    final value = evaluate(
      key,
      FlagType.boolean,
      defaultValue,
      context: context,
    ).value;
    return value is bool ? value : defaultValue;
  }

  String getStringValue(
    String key,
    String defaultValue, {
    EvaluationContext? context,
  }) {
    final value = evaluate(
      key,
      FlagType.string,
      defaultValue,
      context: context,
    ).value;
    return value is String ? value : defaultValue;
  }

  /// `number`, not `integer` (`spec/control-points.md`): Dart's `num`
  /// carries both `int` and `double`, exactly like JSON's number.
  num getNumberValue(
    String key,
    num defaultValue, {
    EvaluationContext? context,
  }) {
    final value = evaluate(
      key,
      FlagType.number,
      defaultValue,
      context: context,
    ).value;
    return value is num ? value : defaultValue;
  }

  JsonValue getObjectValue(
    String key,
    JsonValue defaultValue, {
    EvaluationContext? context,
  }) {
    final value = evaluate(
      key,
      FlagType.object,
      defaultValue,
      context: context,
    ).value;
    return (value is Map || value is List) ? value : defaultValue;
  }

  /// Detailed reads — the whole [Decision] rather than just its value.
  /// Same arguments as the `*Value` pair above, so a caller upgrades from
  /// one to the other without restructuring the call
  /// (`spec/control-points.md` "The nine methods"). SYNCHRONOUS like every
  /// other read here.
  Decision getBooleanDetails(
    String key,
    bool defaultValue, {
    EvaluationContext? context,
  }) => evaluate(key, FlagType.boolean, defaultValue, context: context);

  Decision getStringDetails(
    String key,
    String defaultValue, {
    EvaluationContext? context,
  }) => evaluate(key, FlagType.string, defaultValue, context: context);

  Decision getNumberDetails(
    String key,
    num defaultValue, {
    EvaluationContext? context,
  }) => evaluate(key, FlagType.number, defaultValue, context: context);

  Decision getObjectDetails(
    String key,
    JsonValue defaultValue, {
    EvaluationContext? context,
  }) => evaluate(key, FlagType.object, defaultValue, context: context);
}

/// Top-level Fireweave client: control-point evaluation + target
/// registration — the only two v1 capabilities. No hidden globals: callers
/// construct the runtime (or go through `initFireweave`), so tests inject
/// fakes.
class FireweaveClient {
  FireweaveClient(this.runtime)
    : controlPoints = ControlPointsNamespace._(runtime);

  final FireweaveRuntime runtime;
  final ControlPointsNamespace controlPoints;

  /// Control-point evaluation under its former name.
  ///
  /// Identical to [controlPoints] and shares its identity — both resolve to
  /// the exact same [ControlPointsNamespace] instance, so
  /// `identical(client.flags, client.controlPoints)` holds. Silent at
  /// runtime: the alias is permanent, not scheduled for removal (ADR-0007),
  /// so there is nothing to warn a caller toward — deprecation is conveyed
  /// by this annotation only, never a runtime log.
  @Deprecated(
    'Renamed to controlPoints (ADR-0007). Identical object; no '
    'migration is required.',
  )
  ControlPointsNamespace get flags => controlPoints;

  Future<void> initialize({EvaluationContext? context}) =>
      runtime.initialize(context: context);

  /// Bind the client-layer evaluation context (merge order: middle, ahead
  /// of per-call invocation, behind constructor-time global). Call
  /// [runtime]`.refresh()` (or [identify]) afterwards to re-prefetch under it.
  void setContext(EvaluationContext? context) {
    runtime.setClientContext(context);
  }

  /// Register durable targeting facts for a target (`spec/modes.md`).
  ///
  /// Resolves rather than throwing: this runs in sign-in paths, where a
  /// targeting concern must not break authentication. In local mode this
  /// records in-process and traces the call; nothing reaches fw-server.
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) => runtime.registerTarget(targetingKey, options: options);

  /// Sign-in hook: register the user's durable targeting properties, then
  /// re-prefetch under that id so percentage ramps bucket on a stable key.
  Future<RegisterTargetResult> identify(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async {
    final result = await runtime.registerTarget(targetingKey, options: options);
    runtime.setClientContext(EvaluationContext(targetingKey: targetingKey));
    await runtime.refresh();
    return result;
  }

  /// Dynamic capability dispatch. Unknown capabilities — currently all of
  /// them, v1's supported set is empty — degrade with
  /// `UnsupportedCapability`, never throw.
  ExtensionResult invokeCapability(
    String capability, {
    Map<String, Object?>? args,
  }) {
    if (!_supportedCapabilities.contains(capability)) {
      return ExtensionResult.failure(
        FireweaveError(ErrorKind.unsupportedCapability),
        degraded: true,
      );
    }
    final gate = runtime.extensionLifecycleGate();
    if (gate != null) {
      return ExtensionResult.failure(gate, degraded: true);
    }
    return const ExtensionResult.success();
  }

  Future<void> shutdown() => runtime.shutdown();
}
