/// Fireweave SDK for Dart (spec v0.1.0) — Flutter on every platform, the
/// Dart VM, and Dart compiled to JavaScript or WebAssembly.
///
/// Exactly two v1 capabilities (`spec/control-points.md` "Scope of v1"):
/// control points and target registration. Dependency budget: the Dart SDK
/// only (`dart:io` or the browser's `fetch` via `dart:js_interop` for HTTP,
/// `dart:convert` for JSON) — `pubspec.yaml` has no `dependencies:` block,
/// and no `flutter` SDK dependency either, so the same package runs in a
/// Flutter app on Android, iOS, macOS, Windows, Linux, and web, and in any
/// plain Dart program.
///
/// ## The synchronous read surface
///
/// `controlPoints`'s nine methods are SYNCHRONOUS — a pure cache read
/// (`FireweaveRuntime.evaluate`). `initFireweave`/`refresh`/`identify` are
/// `async` and populate that cache. This is "web's shape, not node's"
/// (ADR-0009, ADR-0011): a Flutter `build()` cannot `await`, so nothing on
/// the read path may suspend.
///
/// Quick start (local mode, offline):
///
/// ```dart
/// import 'package:fireweave/fireweave.dart';
///
/// final fw = await initFireweave(InitFireweaveOptions.local(
///   controlPoints: {'new-checkout': true},
/// ));
/// fw.controlPoints.getBooleanValue('new-checkout', false); // true, synchronously
/// await fw.shutdown();
/// ```
///
/// There are no hidden global clients: everything is constructed explicitly
/// and injectable for tests.
library;

export 'src/application/client.dart'
    show ControlPointsNamespace, ExtensionResult, FireweaveClient;
export 'src/application/init_fireweave.dart'
    show
        InitFireweaveLocalOptions,
        InitFireweaveOptions,
        InitFireweaveRemoteOptions,
        initFireweave;
export 'src/application/ports.dart'
    show
        AdapterResolution,
        ControlPointsBackendAdapter,
        EvaluateOptions,
        HttpTransport,
        LogSink,
        PrefetchOptions,
        PrefetchResult,
        RegisterTargetOptions,
        RegisterTargetResult,
        TransportResponse;
export 'src/application/runtime.dart'
    show
        FireweaveRuntime,
        LifecycleState,
        RuntimeConfig,
        defaultFlagsReadyTimeoutMs;
export 'src/domain/context.dart'
    show
        ContextLimits,
        EvaluationContext,
        allowedFireweaveContextKeys,
        defaultContextLimits,
        defaultReservedAttributeKeys,
        mergeContexts;
export 'src/domain/decision.dart' show Decision, DecisionReason;
export 'src/domain/errors.dart'
    show ErrorKind, FireweaveError, flagMetadataErrorKindKey, redactSecrets;
export 'src/domain/mode.dart' show Mode;
export 'src/domain/target.dart' show TargetKind;
export 'src/domain/types.dart'
    show
        FlagMetadata,
        FlagType,
        JsonObject,
        JsonValue,
        jsonEquals,
        matchesExpectedType,
        stableJsonString;
export 'src/domain/validation.dart'
    show
        Invalid,
        Valid,
        Validated,
        validateContext,
        validateControlPointKey,
        validateDefaultValue,
        validateInitOptions,
        validateTargetingKey;
export 'src/infrastructure/adapters/in_memory_adapter.dart'
    show FlagDefinition, InMemoryAdapter, InMemoryFault;
export 'src/infrastructure/adapters/local_adapter.dart'
    show FireweaveLocalAdapter, LocalRegisteredTarget;
export 'src/infrastructure/adapters/remote_adapter.dart'
    show FireweaveRemoteAdapter, RemoteAdapterConfig;
export 'src/infrastructure/hosts.dart'
    show assertHostAllowed, defaultAllowedHosts, isLoopbackHostname;

/// Frozen SDK spec version this package implements (`spec/version.json`).
const String specVersion = '0.1.0';
