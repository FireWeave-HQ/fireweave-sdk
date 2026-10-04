/// The server start profile behind `package:fireweave/server.dart`: Dart VM
/// servers, CLIs and AOT executables (node: `src/start/`, go: `fw/`).
///
/// Reads the process environment through `server_env_io.dart` only, so this
/// library compiles only where `dart:io` exists. Configuration faults throw
/// a `Configuration` [FireweaveError] from `Fireweave.start`; reads never
/// throw.
library;

import 'package:fireweave/fireweave.dart';

import 'channel.dart';
import 'core.dart';
import 'flags.dart';
import 'identity.dart';
import 'names.dart';
import 'policy.dart';
import 'server_env_io.dart';
import 'transport/owned_transport.dart' show hasDartIo;

/// Reads one variable, trimmed; `null` when unset or empty.
typedef EnvLookup = String? Function(String name);

String? _clean(String? value) {
  if (value == null) {
    return null;
  }
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

/// The server profile's singleton for this isolate.
final class ServerCore extends StartCore {
  ServerCore() : super(StartProfile.server);

  /// Environment reader of the last start (the `env` map, or the process).
  EnvLookup? lookup;
  String? instanceIdOption;
  ({String value, InstanceKeySource source})? instance;

  EnvLookup get _read =>
      lookup ?? (name) => _clean(readProcessEnvironment(name));

  String get instanceKey => (instance ??= deriveServerInstanceKey(
    instanceIdOption,
    _read,
    readHostName,
  )).value;

  @override
  FireweaveError? checkContext(EvaluationContext? context) {
    final perCall = context?.targetingKey;
    if (perCall == null || perCall == currentKey) {
      return null;
    }
    warnOnce(
      '[fireweave] Server reads are prefetched under fw.instanceKey, so a '
      'per-call targetingKey cannot be answered from the cache; the read '
      'serves its default (InvalidContext). Read without a context, or build '
      'a client per user with initFireweave.',
    );
    return FireweaveError(
      ErrorKind.invalidContext,
      message: 'per-call targetingKey differs from fw.instanceKey',
    );
  }

  @override
  Future<void> resetForTests() {
    lookup = null;
    instanceIdOption = null;
    instance = null;
    return super.resetForTests();
  }
}

/// This isolate's server singleton.
final ServerCore serverCore = ServerCore();

/// The server profile's instance-key derivation with its sources injected:
/// [read] stands in for the process environment and [osHostName] for the
/// operating system's host name (`HOSTNAME` is read first, as node does).
/// Pure apart from the random fallback.
({String value, InstanceKeySource source}) deriveServerInstanceKey(
  String? option,
  EnvLookup read,
  String? Function() osHostName,
) => deriveInstanceKey(
  option,
  (name) => _clean(read(name)),
  () => _clean(read(hostNameVariable)) ?? _clean(osHostName()),
);

/// First non-empty of: the option, then each name, then each legacy name
/// (adding one warning naming its replacement to [warnings]).
Sourced? _pick(
  String? option,
  String optionName,
  List<String> names,
  List<String> legacy,
  EnvLookup read,
  List<String> warnings,
  String replacement,
) {
  final fromOption = sourced(option, optionName);
  if (fromOption != null) {
    return fromOption;
  }
  for (final name in names) {
    final value = sourced(read(name), name);
    if (value != null) {
      return value;
    }
  }
  for (final name in legacy) {
    final value = sourced(read(name), name);
    if (value != null) {
      warnings.add(
        '[fireweave] $name is a legacy name and will stop being read in the '
        'next major version. Rename it to $replacement; the value does not '
        'change.',
      );
      return value;
    }
  }
  return null;
}

/// The server profile's resolution, pure: the options, then [read] (the
/// process environment's stand-in), then the legacy names, then the
/// defaults, handed to [resolvePolicy]. [channel] stands in for this build's
/// release channel. No I/O and no globals; [startServer] is this plus the
/// singleton.
PolicyResult resolveServerStart({
  required Map<String, Flag> flags,
  required EnvLookup read,
  required SdkChannel channel,
  required String sdkVersion,
  Mode? mode,
  String? environment,
  String? url,
  String? key,
}) {
  String? lookup(String name) => _clean(read(name));
  final keyWarnings = <String>[];
  final urlWarnings = <String>[];
  final pickedKey = _pick(
    key,
    'Fireweave.start(key:)',
    const <String>[serverKeyVariable],
    legacyKeyNames,
    lookup,
    keyWarnings,
    serverKeyVariable,
  );
  final pickedUrl = _pick(
    url,
    'Fireweave.start(url:)',
    const <String>[urlVariable],
    legacyUrlNames,
    lookup,
    urlWarnings,
    urlVariable,
  );
  final pickedEnvironment = _pick(
    environment,
    'Fireweave.start(environment:)',
    const <String>[environmentVariable, serverEnvironmentFallback],
    const <String>[],
    lookup,
    <String>[],
    environmentVariable,
  );
  return resolvePolicy(
    PolicyInput(
      profile: StartProfile.server,
      mode: mode,
      key: pickedKey,
      url: pickedUrl,
      environment: pickedEnvironment,
      flags: flags,
      channel: channel,
      sdkVersion: sdkVersion,
      environmentChecked:
          'Fireweave.start(environment:), $environmentVariable and '
          '$serverEnvironmentFallback',
      retiredEnvironmentSet: lookup(retiredEnvironmentName) != null,
      // Legacy-name warnings only matter for a value that is used.
      warnings: mode == Mode.local
          ? const <String>[]
          : <String>[...keyWarnings, if (pickedKey != null) ...urlWarnings],
    ),
  );
}

/// Start the server profile.
Future<void> startServer({
  Map<String, Flag>? flags,
  Mode? mode,
  String? environment,
  String? url,
  String? key,
  String? instanceId,
  Map<String, String>? env,
  HttpTransport? transport,
  LogSink? log,
}) async {
  if (!hasDartIo) {
    // dart2js and dart2wasm compile a dart:io import into run-time stubs, so
    // this library builds for the web; a server key must never run there.
    throw FireweaveError.configuration(
      '[fireweave] package:fireweave/server.dart is for Dart VM servers, CLIs '
      'and executables. Flutter and web apps use package:fireweave/client.dart '
      'with a browser key.',
      initFatal: true,
    );
  }
  final core = serverCore;
  final EnvLookup read = env != null
      ? (name) => _clean(env[name])
      : (name) => _clean(readProcessEnvironment(name));

  final normalized = normalizeFlags(flags);
  final policy = resolveServerStart(
    flags: normalized,
    mode: mode,
    environment: environment,
    url: url,
    key: key,
    read: read,
    channel: sdkChannel,
    sdkVersion: sdkVersion,
  );
  final ResolvedStart config;
  switch (policy) {
    case PolicyFailure():
      throw policy.toError();
    case PolicyOk(config: final resolved):
      config = resolved;
  }

  final instanceOption = sourced(instanceId, 'instanceId')?.value;
  final signature = startSignature(config, instanceOption);
  if (core.isActive) {
    if (signature != core.signature) {
      throw FireweaveError.configuration(
        '[fireweave] Fireweave.start() was already called with a different '
        'configuration in this isolate. Call it once, before serving.',
        initFatal: true,
      );
    }
    await core.ready;
    _throwIfFailed(core);
    return;
  }
  final handedOut = core.instance;
  if (instanceOption != null &&
      handedOut != null &&
      handedOut.value != instanceOption) {
    throw FireweaveError.configuration(
      '[fireweave] Fireweave.start(instanceId:) differs from the '
      'fw.instanceKey already handed out. Pass instanceId on the first '
      'start.',
      initFatal: true,
    );
  }

  // Only a start that actually begins sets these: an identical second start
  // is a no-op and a conflicting one throws, and neither may swap them.
  if (log != null) {
    core.log = log;
  }
  core.lookup = read;
  if (instanceOption != null) {
    core.instanceIdOption = instanceOption;
  }
  await core.begin(
    config,
    signature,
    transport: transport,
    targetingKey: () async => core.instanceKey,
  );
  _throwIfFailed(core);
}

void _throwIfFailed(ServerCore core) {
  final failure = core.failure;
  if (core.state == StartState.failed && failure != null) {
    throw failure;
  }
}

/// `Fireweave.start` for Dart servers, CLIs and AOT executables.
abstract final class Fireweave {
  /// Start FireWeave for this isolate. Call once, before serving (and in
  /// every isolate that reads):
  ///
  /// ```dart
  /// Future<void> main() async {
  ///   await Fireweave.start(flags: flags);
  ///   // serve...
  /// }
  /// ```
  ///
  /// Each value resolves as: the option, then the process environment
  /// (`FIREWEAVE_KEY`, `FIREWEAVE_URL`, `FIREWEAVE_ENV` then `APP_ENV`,
  /// `FIREWEAVE_INSTANCE_ID`), then the legacy `FW_PROJECT_API_KEY` /
  /// `FW_API_URL` / `FW_ATTEST_URL` with one warning, then the default.
  /// Empty values count as unset. [env] replaces the process environment
  /// (tests).
  ///
  /// [mode] wins when given. Otherwise a key means remote; no key and a
  /// development environment name (`development`, `dev`, `local`, `test`)
  /// means local; anything else throws a `Configuration` [FireweaveError]
  /// naming `FIREWEAVE_KEY`. A second call with the same configuration is a
  /// no-op; a different one throws. A fw-server that is down does not throw:
  /// start completes and reads serve their defaults.
  static Future<void> start({
    Map<String, Flag>? flags,
    Mode? mode,
    String? environment,
    String? url,
    String? key,
    String? instanceId,
    Map<String, String>? env,
    HttpTransport? transport,
    LogSink? log,
  }) => startServer(
    flags: flags,
    mode: mode,
    environment: environment,
    url: url,
    key: key,
    instanceId: instanceId,
    env: env,
    transport: transport,
    log: log,
  );

  /// Flush and close (`fw.shutdown()`), so the VM can exit. A later start
  /// begins fresh.
  static Future<void> shutdown() => serverCore.shutdown();

  /// Test only: shut down and forget this isolate's singleton, its one-time
  /// warnings, its log sink and its instance key.
  static Future<void> debugResetForTests() => serverCore.resetForTests();
}

/// The server profile's accessor. Safe to use anywhere, before or after
/// start; reads are synchronous and never throw.
final class FireweaveServerStart {
  const FireweaveServerStart._();

  /// The core's nine read methods, over decisions prefetched under
  /// [instanceKey]: `fw.controlPoints.getBooleanValue('nightly-job', false)`.
  ControlPointsNamespace get controlPoints => serverCore.controlPoints;

  /// Register durable targeting facts at sign-in. Resolves with the result;
  /// never throws, and does not change the decisions reads serve.
  Future<RegisterTargetResult> identify(
    String targetingKey, {
    Map<String, Object?>? properties,
    TargetKind kind = TargetKind.user,
  }) async {
    final core = serverCore;
    try {
      await core.ready;
      return await core.register(targetingKey, properties, kind);
    } on Object {
      return RegisterTargetResult.failure(FireweaveError(ErrorKind.internal));
    }
  }

  /// Stable key for reads where this server is the subject: the
  /// `instanceId` option, then `FIREWEAVE_INSTANCE_ID`, then `inst_` + a
  /// hash of the host name (`HOSTNAME`, else the operating system's), then
  /// a random id for the life of the isolate. Nothing is written to disk.
  String get instanceKey => serverCore.instanceKey;

  /// Settles when the current start attempt does. Never rejects.
  Future<void> get ready => serverCore.ready;

  /// Every state change.
  Stream<StartState> get changes => serverCore.changes;

  /// What start decided and how it went. Never the key.
  FireweaveStatus get status => serverCore.status();

  /// The core client, for anything this accessor does not cover. `null`
  /// until start settles.
  FireweaveClient? get client => serverCore.client;

  /// Flush and close, so the VM can exit. A later start begins fresh.
  Future<void> shutdown() => serverCore.shutdown();
}

/// The server profile's accessor for this isolate.
const FireweaveServerStart fw = FireweaveServerStart._();
