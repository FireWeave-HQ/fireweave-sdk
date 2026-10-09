/// `initFireweave` — the single SDK entry point (`spec/modes.md`).
///
/// `mode` is required and never inferred: a missing or mistyped credential
/// must fail loudly at boot, not silently fall back to local evaluation —
/// that failure mode looks like a green boot and a feature that never
/// ramps. This is the SANCTIONED composition root (mirrors rust's
/// `application::mode`/node's `application/mode.ts`/swift's
/// `InitFireweave.swift`): the only file under `application/` that imports
/// `infrastructure/` (`test/architecture_guard_test.dart` exempts exactly
/// this file).
///
/// Initialisation fails loudly (throws); reads on the returned client never
/// do (`spec/control-points.md` "initialise is the exception").
///
/// ## A note on `FireweaveRuntime.initialize()` never throwing
///
/// `FireweaveRuntime.initialize()` is deliberately fail-OPEN — a hung or
/// failing prefetch must not block app boot (`ADR-0009` "Fail-open, not
/// fail-silent"), so it swallows adapter failures into `fatal`/`error`/
/// `stale` state instead of throwing. That non-throwing contract is correct
/// for TRANSIENT failures but wrong for the four Configuration rows below,
/// which `spec/modes.md` requires to fail loudly at boot. This file closes
/// that gap in two parts: `validateInitOptions` covers rows 1/2/4 (mode
/// absent, remote apiKey/apiUrl blank, local combined with credentials);
/// `assertHostAllowed` covers row 3 (the host allowlist) with a direct,
/// SYNCHRONOUS call, before ever calling into the runtime.
library;

import '../domain/context.dart';
import '../domain/mode.dart';
import '../domain/validation.dart';
import '../infrastructure/adapters/local_adapter.dart';
import '../infrastructure/adapters/remote_adapter.dart';
import '../infrastructure/hosts.dart';
import 'client.dart';
import 'ports.dart';
import 'runtime.dart';

/// The full initialisation-options shape (`spec/modes.md`).
///
/// A caller constructs EXACTLY ONE subtype — `mode` is fixed by which one
/// they construct, matching node/web's tagged union and swift's enum with
/// associated values: "mode absent" and "local combined with remote
/// credentials" are BOTH unrepresentable by construction. `validateInitOptions`
/// still re-validates all four rows for a single, auditable,
/// cross-language-comparable code path (and because `remote`'s own
/// blank-apiKey/apiUrl row IS representable).
sealed class InitFireweaveOptions {
  const InitFireweaveOptions();

  /// Evaluate against fw-server over the network (`spec/remote-protocol.md`).
  factory InitFireweaveOptions.remote({
    required String apiKey,
    required String apiUrl,
    List<String>? allowedHosts,
    int requestTimeoutMs = 3000,
    EvaluationContext? context,
    HttpTransport? httpTransport,
  }) => InitFireweaveRemoteOptions(
    apiKey: apiKey,
    apiUrl: apiUrl,
    allowedHosts: allowedHosts,
    requestTimeoutMs: requestTimeoutMs,
    context: context,
    httpTransport: httpTransport,
  );

  /// Evaluate against an in-process seeded map; no network (`spec/modes.md`).
  factory InitFireweaveOptions.local({
    Map<String, bool> controlPoints = const <String, bool>{},
    LogSink? log,
    EvaluationContext? context,
  }) => InitFireweaveLocalOptions(
    controlPoints: controlPoints,
    log: log,
    context: context,
  );

  Mode get mode;

  /// Initial evaluation context (e.g. an anonymous targetingKey) to
  /// prefetch under.
  EvaluationContext? get context;
}

final class InitFireweaveRemoteOptions extends InitFireweaveOptions {
  const InitFireweaveRemoteOptions({
    required this.apiKey,
    required this.apiUrl,
    this.allowedHosts,
    this.requestTimeoutMs = 3000,
    this.context,
    this.httpTransport,
  });

  @override
  Mode get mode => Mode.remote;

  /// Fireweave project key. Required — never read from the environment.
  final String apiKey;

  /// fw-server base URL. Required — never read from the environment.
  final String apiUrl;

  /// SSRF/misconfiguration allowlist override (`spec/modes.md` "apiUrl
  /// fails the host allowlist"). Default: the canonical Fireweave hosts +
  /// loopback (`defaultAllowedHosts`). A self-hosted fw-server must list
  /// its own host explicitly; `['*']` opts out.
  final List<String>? allowedHosts;
  final int requestTimeoutMs;

  @override
  final EvaluationContext? context;

  /// Injected HTTP transport. `null` selects the platform default — `dart:io`
  /// on the VM and on Flutter for Android, iOS, macOS, Windows, and Linux;
  /// the browser's `fetch` on Flutter web and under `dart compile js`/`wasm`.
  /// Inject one to reuse an app's own HTTP client or, in tests, a fake.
  final HttpTransport? httpTransport;
}

final class InitFireweaveLocalOptions extends InitFireweaveOptions {
  const InitFireweaveLocalOptions({
    this.controlPoints = const <String, bool>{},
    this.log,
    this.context,
  });

  @override
  Mode get mode => Mode.local;

  /// Per-key boolean overrides — the seeded local map. A present key
  /// resolves with reason `STATIC`; an absent key misses so the caller's
  /// own default is used. May be empty or omitted entirely.
  final Map<String, bool> controlPoints;

  /// Sink for the `[fireweave:local]` `registerTarget` trace line
  /// (`spec/modes.md` "registerTarget in local mode"). `null` means the
  /// adapter's own default (`print`, which reaches the Flutter console).
  final LogSink? log;

  @override
  final EvaluationContext? context;
}

Future<FireweaveClient> _initLocal(InitFireweaveLocalOptions options) async {
  final adapter = FireweaveLocalAdapter(
    devFlags: options.controlPoints,
    log: options.log,
  );
  final runtime = FireweaveRuntime(adapter);
  final client = FireweaveClient(runtime);
  await client.initialize(context: options.context);
  return client;
}

Future<FireweaveClient> _initRemote(InitFireweaveRemoteOptions options) async {
  // `validateInitOptions` (called by `initFireweave`, below) has already
  // ruled out blank apiKey/apiUrl by the time this runs — only the host
  // allowlist row remains to check here. This call — not
  // `runtime.initialize()` — is what makes a bad host fail LOUDLY, because
  // the runtime itself deliberately never throws.
  assertHostAllowed(
    options.apiUrl,
    allowedHosts: options.allowedHosts,
    initFatal: true,
  );

  final adapter = FireweaveRemoteAdapter(
    RemoteAdapterConfig(
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      allowedHosts: options.allowedHosts,
      requestTimeoutMs: options.requestTimeoutMs,
    ),
    transport: options.httpTransport,
  );
  final runtime = FireweaveRuntime(adapter);
  final client = FireweaveClient(runtime);
  await client.initialize(context: options.context);
  return client;
}

/// Builds the adapter matching [options]'s mode and brings a
/// [FireweaveClient] up.
///
/// Throws a `FireweaveError` of kind `Configuration` for every row of the
/// initialisation-validation table (`spec/modes.md`) this SDK can
/// represent:
///  - `mode` absent — unrepresentable here (a caller must construct a
///    remote or local options object); see `Mode`'s doc comment.
///  - `mode: remote` with `apiKey`/`apiUrl` missing/blank.
///  - `apiUrl` fails the host allowlist.
///  - `mode: local` with credentials supplied — unrepresentable here too
///    (the local options have no credential fields), but
///    `validateInitOptions` still re-checks it for cross-language parity.
Future<FireweaveClient> initFireweave(InitFireweaveOptions options) async {
  final (mode, apiKey, apiUrl) = switch (options) {
    InitFireweaveRemoteOptions(:final apiKey, :final apiUrl) => (
      Mode.remote,
      apiKey,
      apiUrl,
    ),
    InitFireweaveLocalOptions() => (Mode.local, null, null),
  };
  if (validateInitOptions(mode: mode, apiKey: apiKey, apiUrl: apiUrl)
      case Invalid(:final error)) {
    throw error;
  }
  return switch (options) {
    InitFireweaveLocalOptions() => _initLocal(options),
    InitFireweaveRemoteOptions() => _initRemote(options),
  };
}
