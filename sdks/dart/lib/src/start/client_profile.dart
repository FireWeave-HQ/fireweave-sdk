/// The client start profile behind `package:fireweave/client.dart`: Flutter
/// apps on every platform and Dart compiled for the web (web:
/// `src/start/state.ts` and `src/start/fw.ts`).
///
/// It reads no environment at run time (there is none on a device or in a
/// browser): the key, endpoint and environment name come from the start
/// options, then from compile-time defines, then the defaults. Nothing here
/// throws: an app that fails to start must still draw its first frame, so a
/// fault logs one line, sets the state to `failed` with a `problem`, and
/// every read serves its default.
library;

import 'package:fireweave/fireweave.dart';

import 'channel.dart';
import 'client_defines.dart';
import 'core.dart';
import 'flags.dart';
import 'identity.dart';
import 'names.dart';
import 'policy.dart';

/// Persists the anonymous device id across launches. The client profile
/// ships none (the package has no dependencies); a Flutter app can back one
/// with `shared_preferences` in a few lines, and a `fireweave_flutter`
/// companion is planned to provide it. Every call may throw: the profile
/// falls back to an in-memory id with one warning.
abstract interface class DeviceIdStore {
  /// The stored id, or `null` when none is stored.
  Future<String?> read();

  Future<void> write(String deviceId);

  Future<void> delete();
}

/// The client profile's singleton for this isolate.
final class ClientCore extends StartCore {
  ClientCore() : super(StartProfile.client);

  /// The anonymous key decisions fall back to after `fw.reset()`.
  String? deviceId;
  DeviceIdStore? store;

  @override
  FireweaveError? checkContext(EvaluationContext? context) {
    final perCall = context?.targetingKey;
    if (perCall != null && perCall != currentKey) {
      warnOnce(
        '[fireweave] A per-call targetingKey does not change the decision in '
        'the client profile: decisions follow fw.identify(). Drop the context '
        'argument.',
      );
    }
    return null;
  }

  @override
  Future<void> resetForTests() {
    deviceId = null;
    store = null;
    return super.resetForTests();
  }
}

/// This isolate's client singleton.
final ClientCore clientCore = ClientCore();

Future<String> _loadDeviceId(
  ClientCore core,
  ResolvedStart config,
  String? option,
  DeviceIdStore? store,
) async {
  if (option != null) {
    return option;
  }
  // Local mode stores nothing: the id lives for this run only.
  if (config.mode == Mode.local || store == null) {
    return mintDeviceId();
  }
  try {
    final stored = (await store.read())?.trim();
    if (stored != null && stored.isNotEmpty) {
      return stored;
    }
  } on Object {
    core.warnOnce(
      '[fireweave] The deviceIdStore could not be read; using an in-memory '
      'device id for this run.',
    );
    return mintDeviceId();
  }
  final minted = mintDeviceId();
  try {
    await store.write(minted);
  } on Object {
    core.warnOnce(
      '[fireweave] The deviceIdStore could not be written; the device id '
      'lasts for this run only.',
    );
  }
  return minted;
}

/// Start the client profile. [defines] is the compile-time define map;
/// tests hand in their own, since defines cannot be set at run time.
Future<void> startClient({
  Map<String, Flag>? flags,
  Mode? mode,
  String? environment,
  String? url,
  String? key,
  String? deviceId,
  DeviceIdStore? deviceIdStore,
  HttpTransport? transport,
  LogSink? log,
  Map<String, String> defines = compiledDefines,
}) {
  final core = clientCore;
  if (log != null && !core.isActive) {
    core.log = log;
  }

  final Map<String, Flag> normalized;
  try {
    normalized = normalizeFlags(flags);
  } on FireweaveError catch (error) {
    return core.fail(
      const StartProblem('invalid-flags', variable: 'flags'),
      error.message,
    );
  }

  if (defines.containsKey(serverKeyVariable)) {
    core.warnOnce(
      '[fireweave] $serverKeyVariable was passed as a compile-time define. '
      'The client profile never reads it: a server key must not be compiled '
      'into an app. Remove it from the define file, use $browserKeyVariable '
      'with a browser key ($browserKeyPrefix…), and revoke the server key if '
      'a build with it was released.',
    );
  }

  final policy = resolvePolicy(
    PolicyInput(
      profile: StartProfile.client,
      mode: mode,
      key: firstOf(<Sourced?>[
        sourced(key, 'Fireweave.start(key:)'),
        sourced(defines[browserKeyVariable], browserKeyVariable),
      ]),
      url: firstOf(<Sourced?>[
        sourced(url, 'Fireweave.start(url:)'),
        sourced(defines[urlVariable], urlVariable),
      ]),
      environment: firstOf(<Sourced?>[
        sourced(environment, 'Fireweave.start(environment:)'),
        sourced(defines[environmentVariable], environmentVariable),
      ]),
      flags: normalized,
      channel: sdkChannel,
      sdkVersion: sdkVersion,
      environmentChecked:
          'Fireweave.start(environment:) and the $environmentVariable define',
    ),
  );
  switch (policy) {
    case PolicyFailure(:final reason, :final variable, :final message):
      return core.fail(StartProblem(reason, variable: variable), message);
    case PolicyOk(:final config):
      final deviceIdOption = sourced(deviceId, 'deviceId')?.value;
      final signature = startSignature(config, deviceIdOption);
      if (core.isActive) {
        if (signature != core.signature) {
          core.warnOnce(
            '[fireweave] Fireweave.start() was already called with a '
            'different configuration; keeping the first one. Call it once, '
            'before runApp.',
          );
        }
        return core.ready;
      }
      core.store = deviceIdStore;
      return core.begin(
        config,
        signature,
        transport: transport,
        targetingKey: () async {
          final id = await _loadDeviceId(
            core,
            config,
            deviceIdOption,
            deviceIdStore,
          );
          core.deviceId = id;
          return id;
        },
      );
  }
}

/// `Fireweave.start` for Flutter apps and Dart web apps.
abstract final class Fireweave {
  /// Start FireWeave for this isolate. Call once, before `runApp`:
  ///
  /// ```dart
  /// Future<void> main() async {
  ///   await Fireweave.start(flags: flags);
  ///   runApp(const App());
  /// }
  /// ```
  ///
  /// Each value resolves as: the option, then the compile-time define
  /// (`--dart-define` / `--dart-define-from-file`), then the default. The
  /// key is a browser key (`fw_public_…`, define `FIREWEAVE_BROWSER_KEY`);
  /// [url] defaults to this build's channel host (define `FIREWEAVE_URL`);
  /// [environment] (define `FIREWEAVE_ENV`) only feeds the mode rule.
  ///
  /// [mode] wins when given. Otherwise a key means remote; no key and a
  /// development environment name (`development`, `dev`, `local`, `test`)
  /// means local; anything else fails closed.
  ///
  /// Completes when the first prefetch settles and never throws: a refused
  /// configuration logs one line, `fw.status.state` becomes
  /// `StartState.failed` with a `problem`, and every read serves its
  /// default. A second call with the same configuration is a no-op; a
  /// different one logs once and keeps the first.
  ///
  /// [deviceId] is an app-supplied anonymous key (used verbatim, not
  /// stored); without it the profile uses [deviceIdStore], else an in-memory
  /// `dev_<uuid>` id for this run. [transport] and [log] are not part of the
  /// configuration check.
  static Future<void> start({
    Map<String, Flag>? flags,
    Mode? mode,
    String? environment,
    String? url,
    String? key,
    String? deviceId,
    DeviceIdStore? deviceIdStore,
    HttpTransport? transport,
    LogSink? log,
  }) => startClient(
    flags: flags,
    mode: mode,
    environment: environment,
    url: url,
    key: key,
    deviceId: deviceId,
    deviceIdStore: deviceIdStore,
    transport: transport,
    log: log,
  );

  /// Flush and close (`fw.shutdown()`). A later start begins fresh.
  static Future<void> shutdown() => clientCore.shutdown();

  /// Test only: shut down and forget this isolate's singleton, its one-time
  /// warnings and its log sink, so the next start begins fresh.
  static Future<void> debugResetForTests() => clientCore.resetForTests();
}

/// The client profile's accessor. Safe to use anywhere, before or after
/// start; reads are synchronous and never throw.
final class FireweaveClientStart {
  const FireweaveClientStart._();

  /// The core's nine read methods, over this isolate's client:
  /// `fw.controlPoints.getBooleanValue('new-checkout', false)`.
  ControlPointsNamespace get controlPoints => clientCore.controlPoints;

  /// Sign-in and session restore: register the user, then re-prefetch under
  /// their key. Resolves with the registration result; never throws.
  Future<RegisterTargetResult> identify(
    String targetingKey, {
    Map<String, Object?>? properties,
    TargetKind kind = TargetKind.user,
  }) async {
    final core = clientCore;
    try {
      return await core.serialized(() async {
        if (core.client == null) {
          core.warnOnce(
            '[fireweave] fw.identify() ran while FireWeave was not running '
            '(not started, failed or shut down); the user was not registered.',
          );
          return RegisterTargetResult.failure(core.notStartedError());
        }
        if (targetingKey.trim().isEmpty) {
          return RegisterTargetResult.failure(
            FireweaveError.targetingKeyMissing(),
          );
        }
        final result = await core.register(targetingKey, properties, kind);
        await core.switchTo(targetingKey);
        return result;
      });
    } on Object {
      return RegisterTargetResult.failure(FireweaveError(ErrorKind.internal));
    }
  }

  /// Sign-out: back to the device id. With [rotateDeviceId] (consent
  /// withdrawn) a fresh id is minted first and the stored one replaced.
  /// Never throws.
  Future<void> reset({bool rotateDeviceId = false}) async {
    final core = clientCore;
    try {
      await core.serialized(() async {
        if (core.client == null) {
          return;
        }
        if (rotateDeviceId) {
          final minted = mintDeviceId();
          final store = core.store;
          if (store != null && core.config?.mode == Mode.remote) {
            try {
              await store.delete();
              await store.write(minted);
            } on Object {
              core.warnOnce(
                '[fireweave] The deviceIdStore could not be updated; the new '
                'device id lasts for this run only.',
              );
            }
          }
          core.deviceId = minted;
        }
        final id = core.deviceId;
        if (id != null) {
          await core.switchTo(id);
        }
      });
    } on Object {
      // never throw from sign-out
    }
  }

  /// The anonymous key, for joining with analytics. `null` before start.
  String? get deviceId => clientCore.deviceId;

  /// Settles when the current start attempt does. Never rejects.
  Future<void> get ready => clientCore.ready;

  /// Every state change, including the re-prefetch after identify or reset.
  Stream<StartState> get changes => clientCore.changes;

  /// What start decided and how it went. Never the key.
  FireweaveStatus get status => clientCore.status();

  /// The core client, for anything this accessor does not cover. `null`
  /// until start settles.
  FireweaveClient? get client => clientCore.client;

  /// Flush and close. A later start begins fresh.
  Future<void> shutdown() => clientCore.shutdown();
}

/// The client profile's accessor for this isolate.
const FireweaveClientStart fw = FireweaveClientStart._();
