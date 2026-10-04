/// The per-isolate singleton machinery both start profiles share: state,
/// the one client, the read facade, one-time warnings, remote-failure lines
/// and the status snapshot (node: `src/start/state.ts`, web:
/// `src/start/state.ts`).
///
/// Dart statics belong to one isolate, so each profile keeps one
/// [StartCore] per isolate; `Fireweave.start` must run in every isolate
/// that reads. Built only on the package's public API; the core
/// (`initFireweave` and everything in `package:fireweave/fireweave.dart`) is
/// unchanged.
library;

import 'dart:async';

import 'package:fireweave/fireweave.dart';

import 'channel.dart';
import 'flags.dart';
import 'names.dart';
import 'policy.dart';
import 'transport/owned_transport.dart';

/// Where a start profile is.
///
/// [starting] until the first prefetch settles; then [ready], [stale] (the
/// prefetch lost the boot ceiling) or [error] (it failed); [failed] when the
/// configuration was refused or the core could not start; [shutdown] after
/// `fw.shutdown()`.
enum StartState { notStarted, starting, ready, stale, error, failed, shutdown }

/// Why the start profile is not serving decisions, or what went wrong with
/// the last request. [reason] is a fixed code; [variable] names the option or
/// variable at fault. Never a value.
final class StartProblem {
  const StartProblem(this.reason, {this.variable});

  /// `missing-key`, `server-key`, `wrong-key-family`, `insecure-url`,
  /// `invalid-flags`, `start-failed`, `key-rejected`, `rate-limited`,
  /// `unreachable` or `unexpected-response`.
  final String reason;
  final String? variable;

  @override
  bool operator ==(Object other) =>
      other is StartProblem &&
      other.reason == reason &&
      other.variable == variable;

  @override
  int get hashCode => Object.hash(reason, variable);

  @override
  String toString() => variable == null
      ? 'StartProblem($reason)'
      : 'StartProblem($reason, $variable)';
}

/// What `Fireweave.start` decided and how it went. Never contains the key,
/// so it is safe to log or show on a debug screen.
final class FireweaveStatus {
  const FireweaveStatus({
    required this.state,
    required this.channel,
    required this.sdkVersion,
    this.mode,
    this.modeSource,
    this.host,
    this.endpointSource,
    this.keySource,
    this.environment,
    this.flagCount,
    this.problem,
    this.error,
    this.lastErrorKind,
  });

  final StartState state;

  /// `null` until a start resolved one.
  final Mode? mode;

  /// `option`, `key` or `environment`.
  final String? modeSource;

  /// The release channel of this build of the package.
  final SdkChannel channel;
  final String sdkVersion;

  /// fw-server host name only (remote mode): never a path, a query or
  /// userinfo.
  final String? host;

  /// Where the endpoint came from: an option, a variable, or
  /// `SDK channel (…)`.
  final String? endpointSource;

  /// The option or variable the key came from; `none` in local mode.
  final String? keySource;

  /// The environment name, when it chose the mode.
  final String? environment;
  final int? flagCount;
  final StartProblem? problem;

  /// Why start failed, when it did. Names sources, never values.
  final String? error;

  /// The kind of the last failed fw-server request, sticky across a later
  /// success (which clears [problem]).
  final ErrorKind? lastErrorKind;

  Map<String, Object?> toJson() => <String, Object?>{
    'state': state.name,
    'mode': mode?.wireName,
    'modeSource': modeSource,
    'channel': channel.name,
    'sdkVersion': sdkVersion,
    'host': host,
    'endpointSource': endpointSource,
    'keySource': keySource,
    'environment': environment,
    'flagCount': flagCount,
    'problem': problem?.reason,
    'problemVariable': problem?.variable,
    'error': error,
    'lastErrorKind': lastErrorKind?.wireName,
  };

  @override
  String toString() {
    final fields = toJson().entries
        .where((e) => e.value != null)
        .map((e) => '${e.key}: ${e.value}')
        .join(', ');
    return 'FireweaveStatus($fields)';
  }
}

// `print` reaches the Flutter console and a server's stdout on every
// platform, like the core local adapter's default sink.
// ignore: avoid_print
void _defaultLog(String line) => print(line);

StartState _fromLifecycle(LifecycleState state) => switch (state) {
  LifecycleState.uninitialized ||
  LifecycleState.initializing => StartState.starting,
  LifecycleState.ready => StartState.ready,
  LifecycleState.stale => StartState.stale,
  LifecycleState.error || LifecycleState.fatal => StartState.error,
  LifecycleState.shutdown => StartState.shutdown,
};

Decision _errorDecision(JsonValue defaultValue, FireweaveError error) =>
    Decision(
      value: defaultValue,
      reason: DecisionReason.error,
      errorCode: error.openFeatureErrorCode,
      errorMessage: error.message,
      errorKind: error.kind,
      flagMetadata: Map<String, Object?>.unmodifiable(<String, Object?>{
        flagMetadataErrorKindKey: error.kind.wireName,
      }),
    );

/// The idempotency signature: mode, url, key, allowed hosts, the identity
/// option, and the local values in local mode only (a key-holding remote
/// start ignores them). Injected objects (log, transport, store) are not
/// part of it: closures and fresh instances compare by identity.
String startSignature(ResolvedStart config, String? identity) => <String>[
  config.mode.wireName,
  config.url ?? '',
  config.key ?? '',
  (config.allowedHosts ?? const <String>[]).join(','),
  identity ?? '',
  if (config.mode == Mode.local) flagsSignature(config.flags),
].map((part) => '${part.length}:$part').join('|');

/// One profile's singleton for this isolate.
class StartCore {
  StartCore(this.profile);

  final StartProfile profile;

  StartState state = StartState.notStarted;

  /// Bumped by every start and shutdown, so a late result from an older
  /// attempt is ignored.
  int generation = 0;
  String? signature;
  ResolvedStart? config;
  FireweaveClient? client;
  OwnedTransport? _owned;
  StartProblem? problem;
  FireweaveError? failure;
  ErrorKind? lastErrorKind;

  /// The targeting key the current decisions were prefetched under.
  String? currentKey;
  LogSink log = _defaultLog;
  final Set<String> _warned = <String>{};
  final Set<String> _diagnosed = <String>{};
  Future<void> ready = Future<void>.value();
  Future<void> _chain = Future<void>.value();
  final StreamController<StartState> _changes =
      StreamController<StartState>.broadcast();

  late final StartControlPoints controlPoints = StartControlPoints(this);

  Stream<StartState> get changes => _changes.stream;

  bool get isActive =>
      state == StartState.starting ||
      state == StartState.ready ||
      state == StartState.stale ||
      state == StartState.error;

  void emit(String line) {
    try {
      log(line);
    } on Object {
      // a log sink's bug must not break the SDK
    }
  }

  void warnOnce(String line) {
    if (_warned.add(line)) {
      emit(line);
    }
  }

  void setState(StartState next, {bool always = false}) {
    if (state == next && !always) {
      return;
    }
    state = next;
    _changes.add(next);
  }

  /// The error a read or an identity call reports while there is no client.
  FireweaveError notStartedError() => switch (state) {
    StartState.failed => FireweaveError(ErrorKind.configuration),
    StartState.shutdown => FireweaveError(ErrorKind.alreadyClosed),
    _ => FireweaveError(ErrorKind.notReady),
  };

  /// A configuration fault in a start call. A running client is kept; with
  /// none, the profile becomes [StartState.failed] and reads serve defaults.
  Future<void> fail(StartProblem startProblem, String message) {
    if (isActive) {
      warnOnce('$message Keeping the running configuration.');
      return ready;
    }
    problem = startProblem;
    failure = FireweaveError.configuration(message, initFatal: true);
    config = null;
    signature = null;
    warnOnce('$message FireWeave is not running; reads serve their defaults.');
    setState(StartState.failed);
    ready = Future<void>.value();
    return ready;
  }

  String _localLine(ResolvedStart config) {
    final why = config.modeSource == 'option'
        ? 'Fireweave.start(mode: Mode.local)'
        : "no ${profile.keyVariable}; environment '${config.environment}' "
              'from ${config.environmentSource}';
    final n = config.flags.length;
    return '[fireweave:local] Local mode ($why). Serving $n '
        'flag${n == 1 ? '' : 's'} from your flags map; nothing is sent to '
        'fw-server.';
  }

  /// Begin a start for [startConfig]. Resolves when the first prefetch
  /// settles, never rejects; a core failure lands in [failure].
  Future<void> begin(
    ResolvedStart startConfig,
    String startSignature, {
    required Future<String> Function() targetingKey,
    HttpTransport? transport,
  }) {
    final gen = ++generation;
    config = startConfig;
    signature = startSignature;
    problem = null;
    failure = null;
    client = null;
    currentKey = null;
    _chain = Future<void>.value();
    for (final warning in startConfig.warnings) {
      warnOnce(warning);
    }
    if (startConfig.mode == Mode.local) {
      emit(_localLine(startConfig));
    }
    setState(StartState.starting);
    ready = _boot(gen, startConfig, targetingKey, transport);
    return ready;
  }

  Future<void> _boot(
    int gen,
    ResolvedStart startConfig,
    Future<String> Function() targetingKey,
    HttpTransport? transport,
  ) async {
    OwnedTransport? owned;
    try {
      final key = await targetingKey();
      if (gen != generation) {
        return;
      }
      currentKey = key;
      final context = EvaluationContext(targetingKey: key);
      final FireweaveClient started;
      if (startConfig.mode == Mode.local) {
        started = await initFireweave(
          InitFireweaveOptions.local(
            controlPoints: localSeeds(startConfig.flags),
            log: emit,
            context: context,
          ),
        );
      } else {
        var chosen = transport;
        if (chosen == null) {
          owned = createOwnedTransport();
          chosen = owned;
        }
        started = await initFireweave(
          InitFireweaveOptions.remote(
            apiKey: startConfig.key!,
            apiUrl: startConfig.url!,
            allowedHosts: startConfig.allowedHosts,
            context: context,
            httpTransport: chosen,
          ),
        );
      }
      if (gen != generation) {
        await started.shutdown();
        owned?.close();
        return;
      }
      client = started;
      _owned = owned;
      observeRuntime(started.runtime);
      setState(_fromLifecycle(started.runtime.state), always: true);
    } on Object catch (error) {
      owned?.close();
      if (gen != generation) {
        return;
      }
      final err = error is FireweaveError
          ? error
          : FireweaveError(ErrorKind.internal);
      failure = err;
      problem = const StartProblem('start-failed');
      warnOnce(
        '[fireweave] start failed: ${err.message}. FireWeave is not running; '
        'reads serve their defaults.',
      );
      setState(StartState.failed);
    }
  }

  // ------------------------------------------------------- diagnostics

  /// Record the outcome of the runtime's last prefetch.
  void observeRuntime(FireweaveRuntime runtime) {
    switch (runtime.state) {
      case LifecycleState.ready:
        observeSuccess();
      case LifecycleState.error:
      case LifecycleState.fatal:
        observeError(runtime.initializationError);
      case LifecycleState.uninitialized:
      case LifecycleState.initializing:
      case LifecycleState.stale:
      case LifecycleState.shutdown:
        break;
    }
  }

  void observeSuccess() {
    const transient = <String>{
      'key-rejected',
      'rate-limited',
      'unreachable',
      'unexpected-response',
    };
    if (transient.contains(problem?.reason)) {
      problem = null;
    }
  }

  /// One line per kind of fw-server failure, once per isolate; every kind
  /// lands in [lastErrorKind]. Lines name the key's source and the host,
  /// never a value.
  void observeError(FireweaveError? error) {
    final c = config;
    if (error == null || c == null || c.mode != Mode.remote) {
      return;
    }
    lastErrorKind = error.kind;
    final host = c.host ?? 'fw-server';
    final keySource = c.keySource;
    final (String code, String? variable, String group, String line)? entry =
        switch (error.kind) {
          ErrorKind.authentication => (
            'key-rejected',
            keySource,
            'key-rejected-401',
            '[fireweave] fw-server at $host rejected the key from $keySource '
                '(HTTP 401): it is wrong, revoked or from another project. '
                'Reads serve their defaults.',
          ),
          ErrorKind.authorization => (
            'key-rejected',
            keySource,
            'key-rejected-403',
            '[fireweave] fw-server at $host refused the key from $keySource '
                'for this project or environment (HTTP 403). Reads serve '
                'their defaults.',
          ),
          ErrorKind.rateLimited => (
            'rate-limited',
            keySource,
            'rate-limited',
            '[fireweave] fw-server at $host rate-limited the key from '
                '$keySource (HTTP 429). Reads serve their defaults until a '
                'later request succeeds.',
          ),
          ErrorKind.network ||
          ErrorKind.timeout ||
          ErrorKind.backendUnavailable => (
            'unreachable',
            c.urlSource,
            'unreachable',
            '[fireweave] Could not reach fw-server at $host (endpoint from '
                '${c.urlSource}): offline, a firewall, or the wrong endpoint. '
                'Reads serve their defaults.',
          ),
          ErrorKind.malformedResponse => (
            'unexpected-response',
            c.urlSource,
            'unexpected-response',
            '[fireweave] fw-server at $host (endpoint from ${c.urlSource}) '
                'did not answer like fw-server: check the endpoint. Reads '
                'serve their defaults.',
          ),
          _ => null,
        };
    if (entry == null) {
      return;
    }
    final (code, variable, group, line) = entry;
    problem = StartProblem(code, variable: variable);
    if (_diagnosed.add(group)) {
      emit(line);
    }
  }

  // ------------------------------------------------------ identity calls

  /// Run identity changes one at a time, after start settles, so the last
  /// call wins.
  Future<T> serialized<T>(Future<T> Function() task) {
    final run = _chain.then((_) => ready).then((_) => task());
    _chain = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  /// Register a target through the client's adapter. The runtime gates
  /// registration on its cache state (a failed boot prefetch would refuse a
  /// sign-in without trying); the adapter accepts it once it initialised.
  Future<RegisterTargetResult> register(
    String targetingKey,
    Map<String, Object?>? properties,
    TargetKind kind,
  ) async {
    final c = client;
    if (c == null) {
      return RegisterTargetResult.failure(notStartedError());
    }
    if (targetingKey.trim().isEmpty) {
      return RegisterTargetResult.failure(FireweaveError.targetingKeyMissing());
    }
    try {
      final result = await c.runtime.backendAdapter.registerTarget(
        targetingKey,
        options: RegisterTargetOptions(kind: kind, properties: properties),
      );
      if (result.ok) {
        observeSuccess();
      } else {
        observeError(result.error);
      }
      return result;
    } on Object {
      return RegisterTargetResult.failure(FireweaveError(ErrorKind.internal));
    }
  }

  /// Re-prefetch under [key] when it differs from the current one.
  Future<void> switchTo(String key) async {
    final c = client;
    if (c == null || key == currentKey) {
      return;
    }
    currentKey = key;
    try {
      c.setContext(EvaluationContext(targetingKey: key));
      await c.runtime.refresh();
      observeRuntime(c.runtime);
    } on Object {
      // the runtime reports a failed prefetch through its state
    }
    setState(_fromLifecycle(c.runtime.state), always: true);
  }

  // ----------------------------------------------------------- reads

  /// Profile hook: notes on a per-call context. Returns an error to serve
  /// the default with, or `null` to read the cache.
  FireweaveError? checkContext(EvaluationContext? context) => null;

  T read<T>(
    String key,
    FlagType type,
    JsonValue defaultValue,
    EvaluationContext? context,
    T Function(FireweaveError error) fallback,
    T Function(ControlPointsNamespace controlPoints) run,
  ) {
    try {
      final c = client;
      if (c == null) {
        if (validateControlPointKey(key) case Invalid(:final error)) {
          return fallback(error);
        }
        if (validateDefaultValue(type, defaultValue) case Invalid(
          :final error,
        )) {
          return fallback(error);
        }
        if (state == StartState.notStarted) {
          warnOnce(
            '[fireweave] A control point was read before Fireweave.start() '
            'in this isolate. Call `await Fireweave.start()` first (before '
            'runApp or serve, and in every isolate that reads); reads serve '
            'their defaults until then.',
          );
        }
        return fallback(notStartedError());
      }
      final c0 = config;
      if (c0 != null &&
          c0.mode == Mode.local &&
          !c0.flags.containsKey(key) &&
          validateControlPointKey(key).isValid) {
        warnOnce(
          "[fireweave:local] '$key' is not in your flags map ($flagsFile), so "
          'it gets its default. Add it there to try it locally.',
        );
      }
      final refused = checkContext(context);
      if (refused != null) {
        return fallback(refused);
      }
      return run(c.controlPoints);
    } on Object {
      return fallback(FireweaveError(ErrorKind.internal));
    }
  }

  // ------------------------------------------------------- status/close

  FireweaveStatus status() {
    final c = config;
    return FireweaveStatus(
      state: state,
      channel: c?.channel ?? sdkChannel,
      sdkVersion: c?.sdkVersion ?? sdkVersion,
      mode: c?.mode,
      modeSource: c?.modeSource,
      host: c?.host,
      endpointSource: c?.urlSource,
      keySource: c?.keySource,
      environment: c?.environment,
      flagCount: c?.flags.length,
      problem: problem,
      error: failure?.message,
      lastErrorKind: lastErrorKind,
    );
  }

  /// Flush and close. A later start begins fresh.
  Future<void> shutdown() async {
    await ready;
    final c = client;
    final owned = _owned;
    generation += 1;
    client = null;
    _owned = null;
    signature = null;
    ready = Future<void>.value();
    setState(StartState.shutdown);
    if (c != null) {
      await c.shutdown();
    }
    owned?.close();
  }

  /// Forget everything, for tests: the next start begins fresh, warnings are
  /// logged again and the log sink is the default.
  Future<void> resetForTests() async {
    generation += 1;
    final c = client;
    final owned = _owned;
    state = StartState.notStarted;
    signature = null;
    config = null;
    client = null;
    _owned = null;
    problem = null;
    failure = null;
    lastErrorKind = null;
    currentKey = null;
    log = _defaultLog;
    _warned.clear();
    _diagnosed.clear();
    ready = Future<void>.value();
    _chain = Future<void>.value();
    if (c != null) {
      await c.shutdown();
    }
    owned?.close();
  }
}

/// `fw.controlPoints`: the core's nine read methods with the core's
/// signatures, over whichever client this isolate's start produced. Never
/// throws: before start, after a failed start and after shutdown each read
/// returns the caller's default (an `ERROR` decision for the `*Details`
/// forms and `evaluate`).
final class StartControlPoints implements ControlPointsNamespace {
  StartControlPoints(this._core);

  final StartCore _core;

  @override
  Decision evaluate(
    String key,
    FlagType type,
    JsonValue defaultValue, {
    EvaluationContext? context,
    EvaluateOptions? options,
  }) => _core.read(
    key,
    type,
    defaultValue,
    context,
    (e) => _errorDecision(defaultValue, e),
    (cp) => cp.evaluate(
      key,
      type,
      defaultValue,
      context: context,
      options: options,
    ),
  );

  @override
  bool getBooleanValue(
    String key,
    bool defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.boolean,
    defaultValue,
    context,
    (_) => defaultValue,
    (cp) => cp.getBooleanValue(key, defaultValue, context: context),
  );

  @override
  String getStringValue(
    String key,
    String defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.string,
    defaultValue,
    context,
    (_) => defaultValue,
    (cp) => cp.getStringValue(key, defaultValue, context: context),
  );

  @override
  num getNumberValue(
    String key,
    num defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.number,
    defaultValue,
    context,
    (_) => defaultValue,
    (cp) => cp.getNumberValue(key, defaultValue, context: context),
  );

  @override
  JsonValue getObjectValue(
    String key,
    JsonValue defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.object,
    defaultValue,
    context,
    (_) => defaultValue,
    (cp) => cp.getObjectValue(key, defaultValue, context: context),
  );

  @override
  Decision getBooleanDetails(
    String key,
    bool defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.boolean,
    defaultValue,
    context,
    (e) => _errorDecision(defaultValue, e),
    (cp) => cp.getBooleanDetails(key, defaultValue, context: context),
  );

  @override
  Decision getStringDetails(
    String key,
    String defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.string,
    defaultValue,
    context,
    (e) => _errorDecision(defaultValue, e),
    (cp) => cp.getStringDetails(key, defaultValue, context: context),
  );

  @override
  Decision getNumberDetails(
    String key,
    num defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.number,
    defaultValue,
    context,
    (e) => _errorDecision(defaultValue, e),
    (cp) => cp.getNumberDetails(key, defaultValue, context: context),
  );

  @override
  Decision getObjectDetails(
    String key,
    JsonValue defaultValue, {
    EvaluationContext? context,
  }) => _core.read(
    key,
    FlagType.object,
    defaultValue,
    context,
    (e) => _errorDecision(defaultValue, e),
    (cp) => cp.getObjectDetails(key, defaultValue, context: context),
  );
}
