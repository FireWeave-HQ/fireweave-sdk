import 'dart:async';

import 'package:fireweave/client.dart';
import 'package:fireweave/src/start/client_profile.dart' show startClient;
import 'package:test/test.dart';

import 'support/start_doubles.dart';

/// The client start profile (`package:fireweave/client.dart`). Compile-time
/// defines cannot be set at run time, so these tests hand `startClient` a
/// define map; test/start_client_io_test.dart runs the real `const` reads.
/// Platform-neutral: runs on the VM and on the Chrome leg.
const String browserKey = 'fw_public_s3cr3tvalue';
const String url = 'https://flags.example.com';

final Map<String, Flag> flags = defineFlags(<String, Flag>{
  'new-checkout': const Flag.local(true),
});

/// An in-memory [DeviceIdStore] that can be made to throw.
class MemoryStore implements DeviceIdStore {
  MemoryStore([this.value]);

  String? value;
  bool failing = false;
  int writes = 0;
  int deletes = 0;

  @override
  Future<String?> read() async {
    if (failing) {
      throw StateError('storage unavailable');
    }
    return value;
  }

  @override
  Future<void> write(String deviceId) async {
    if (failing) {
      throw StateError('storage unavailable');
    }
    writes += 1;
    value = deviceId;
  }

  @override
  Future<void> delete() async {
    if (failing) {
      throw StateError('storage unavailable');
    }
    deletes += 1;
    value = null;
  }
}

void main() {
  late LogCapture log;
  late RoutingTransport transport;

  Future<void> start({
    Map<String, String> defines = const <String, String>{},
    Map<String, Flag>? flags,
    Mode? mode,
    String? environment,
    String? url,
    String? key,
    String? deviceId,
    DeviceIdStore? store,
    LogSink? logSink,
  }) => startClient(
    defines: defines,
    flags: flags,
    mode: mode,
    environment: environment,
    url: url,
    key: key,
    deviceId: deviceId,
    deviceIdStore: store,
    transport: transport,
    log: logSink ?? log.call,
  );

  setUp(() async {
    await Fireweave.debugResetForTests();
    log = LogCapture();
    transport = RoutingTransport(
      decisions: <String, Object?>{'new-checkout': true},
    );
  });

  tearDownAll(Fireweave.debugResetForTests);

  group('resolution from defines', () {
    test('FIREWEAVE_ENV=development and no key: local', () async {
      await start(
        flags: flags,
        defines: <String, String>{'FIREWEAVE_ENV': 'development'},
      );
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
      final status = fw.status;
      expect(status.state, StartState.ready);
      expect(status.mode, Mode.local);
      expect(status.modeSource, 'environment');
      expect(status.environment, 'development');
      expect(status.keySource, 'none');
      expect(status.flagCount, 1);
      expect(log.containing('[fireweave:local] Local mode'), hasLength(1));
      expect(transport.requests, isEmpty);
      expect(fw.deviceId, startsWith('dev_'));
    });

    test('FIREWEAVE_BROWSER_KEY means remote over FIREWEAVE_URL', () async {
      await start(
        defines: <String, String>{
          'FIREWEAVE_BROWSER_KEY': browserKey,
          'FIREWEAVE_URL': url,
        },
      );
      expect(fw.status.state, StartState.ready);
      expect(fw.status.mode, Mode.remote);
      expect(fw.status.modeSource, 'key');
      expect(fw.status.keySource, 'FIREWEAVE_BROWSER_KEY');
      expect(fw.status.endpointSource, 'FIREWEAVE_URL');
      expect(fw.status.host, 'flags.example.com');
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
      final evaluate = transport.evaluates.single;
      expect(evaluate.url.toString(), '$url/v1/flags/evaluate');
      expect(evaluate.headers['Authorization'], 'Bearer $browserKey');
      expect(evaluate.body['targetingKey'], fw.deviceId);
    });

    test('without FIREWEAVE_URL the endpoint is the channel host', () async {
      await start(
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      expect(transport.evaluates.single.url.host, 'app-server.fireweave.ai');
      expect(fw.status.endpointSource, 'SDK channel (production)');
    });

    test('options win over defines; empty values are unset', () async {
      await start(
        key: 'fw_public_option',
        url: 'https://option.example.com',
        defines: <String, String>{
          'FIREWEAVE_BROWSER_KEY': browserKey,
          'FIREWEAVE_URL': url,
          'FIREWEAVE_ENV': '',
        },
      );
      expect(fw.status.keySource, 'Fireweave.start(key:)');
      expect(fw.status.host, 'option.example.com');
      await Fireweave.debugResetForTests();

      await start(
        key: ' ',
        environment: 'test',
        defines: <String, String>{
          'FIREWEAVE_BROWSER_KEY': '',
          'FIREWEAVE_ENV': 'production',
        },
      );
      expect(fw.status.mode, Mode.local);
      expect(fw.status.environment, 'test');
    });

    test(
      'a server key passed as a define is never read, with one warning',
      () async {
        await start(
          defines: <String, String>{
            'FIREWEAVE_KEY': '',
            'FIREWEAVE_ENV': 'dev',
          },
        );
        expect(fw.status.mode, Mode.local);
        final lines = log.containing(
          'FIREWEAVE_KEY was passed as a compile-time define',
        );
        expect(lines, hasLength(1));
        expect(lines.single, contains('revoke'));
      },
    );

    test('Mode.local ignores a key, with one warning', () async {
      await start(
        mode: Mode.local,
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      expect(fw.status.mode, Mode.local);
      expect(fw.status.modeSource, 'option');
      expect(
        log.containing('ignores the key from FIREWEAVE_BROWSER_KEY'),
        hasLength(1),
      );
      expect(transport.requests, isEmpty);
    });
  });

  group('configuration faults never throw', () {
    test('no key and no environment: failed, one line, defaults', () async {
      await start(flags: flags);
      final status = fw.status;
      expect(status.state, StartState.failed);
      expect(
        status.problem,
        const StartProblem('missing-key', variable: 'FIREWEAVE_BROWSER_KEY'),
      );
      expect(status.error, contains('FIREWEAVE_BROWSER_KEY is not set'));
      expect(status.mode, isNull);
      expect(log.lines, hasLength(1));
      expect(log.lines.single, contains('reads serve their defaults'));
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isFalse);
      expect(
        fw.controlPoints.getBooleanDetails('new-checkout', false).errorKind,
        ErrorKind.configuration,
      );
    });

    test(
      'a release build without a key and a production name fails closed',
      () async {
        await start(defines: <String, String>{'FIREWEAVE_ENV': 'production'});
        expect(fw.status.state, StartState.failed);
        expect(fw.status.error, contains("'production' (from FIREWEAVE_ENV)"));
      },
    );

    test('a server key is refused without printing it', () async {
      await start(
        defines: <String, String>{
          'FIREWEAVE_BROWSER_KEY': 'project-api-key_s3cr3tvalue',
        },
      );
      expect(fw.status.state, StartState.failed);
      expect(fw.status.problem?.reason, 'server-key');
      expect(fw.status.error, contains('revoke'));
      expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
      expect(fw.status.toString(), isNot(contains('s3cr3t')));
      expect(transport.requests, isEmpty);
    });

    test('other key families are refused', () async {
      for (final bad in <String>[
        'fw_org_s3cr3t',
        'cli_at_s3cr3t',
        '${'ph'}c_s3cr3t',
        'fw_ingest_pub_s3cr3t',
      ]) {
        await Fireweave.debugResetForTests();
        await start(defines: <String, String>{'FIREWEAVE_BROWSER_KEY': bad});
        expect(fw.status.problem?.reason, 'wrong-key-family', reason: bad);
        expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
      }
    });

    test('an http endpoint off loopback is refused', () async {
      await start(
        key: browserKey,
        defines: <String, String>{'FIREWEAVE_URL': 'http://flags.example.com'},
      );
      expect(
        fw.status.problem,
        const StartProblem('insecure-url', variable: 'FIREWEAVE_URL'),
      );
    });

    test('a bad flags map is refused', () async {
      await start(
        flags: <String, Flag>{'': const Flag.local(true)},
        defines: <String, String>{'FIREWEAVE_ENV': 'dev'},
      );
      expect(
        fw.status.problem,
        const StartProblem('invalid-flags', variable: 'flags'),
      );
    });

    test('a corrected start runs after a failed one', () async {
      await start();
      expect(fw.status.state, StartState.failed);
      await start(flags: flags, environment: 'dev');
      expect(fw.status.state, StartState.ready);
      expect(fw.status.problem, isNull);
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
    });
  });

  group('singleton', () {
    test(
      'the same options twice is one start; different options keep the first',
      () async {
        final defines = <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey};
        await start(defines: defines);
        await start(defines: defines, logSink: (_) {});
        expect(transport.evaluates, hasLength(1));
        await start(defines: defines, url: 'https://other.example.com');
        expect(transport.evaluates, hasLength(1));
        expect(fw.status.host, 'app-server.fireweave.ai');
        expect(
          log.containing('different configuration; keeping the first'),
          hasLength(1),
        );
      },
    );

    test('a bad repeat start keeps the running client', () async {
      await start(flags: flags, environment: 'dev');
      await start(key: 'project-api-key_s3cr3t');
      expect(fw.status.state, StartState.ready);
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
      expect(log.containing('Keeping the running configuration'), hasLength(1));
    });

    test('a read before start returns the default and warns once', () {
      final printed = <String>[];
      runZoned(
        () {
          expect(
            fw.controlPoints.getBooleanValue('new-checkout', true),
            isTrue,
          );
          expect(
            fw.controlPoints.getBooleanDetails('new-checkout', false).errorKind,
            ErrorKind.notReady,
          );
        },
        zoneSpecification: ZoneSpecification(
          print: (_, _, _, line) => printed.add(line),
        ),
      );
      expect(printed, hasLength(1));
      expect(printed.single, contains('before Fireweave.start()'));
    });

    test(
      'ready settles with the start; changes fires on settle and on identify',
      () async {
        final states = <StartState>[];
        final sub = fw.changes.listen(states.add);
        unawaited(
          start(defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey}),
        );
        await fw.ready;
        expect(fw.status.state, StartState.ready);
        await fw.identify('user-1');
        await pumpEventQueue();
        await sub.cancel();
        expect(states, <StartState>[
          StartState.starting,
          StartState.ready,
          StartState.ready,
        ]);
      },
    );

    test(
      'after shutdown reads serve defaults, and start begins again',
      () async {
        await start(flags: flags, environment: 'dev');
        await fw.shutdown();
        expect(fw.status.state, StartState.shutdown);
        expect(
          fw.controlPoints.getBooleanDetails('new-checkout', false).errorKind,
          ErrorKind.alreadyClosed,
        );
        await start(flags: flags, environment: 'dev');
        expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
      },
    );

    test(
      'a local read of a key missing from the flags map warns once',
      () async {
        await start(flags: flags, environment: 'dev');
        expect(fw.controlPoints.getStringValue('copy', 'hello'), 'hello');
        expect(fw.controlPoints.getStringValue('copy', 'hello'), 'hello');
        expect(
          log.containing(
            "'copy' is not in your flags map (lib/fireweave/flags.dart)",
          ),
          hasLength(1),
        );
      },
    );

    test('reads never throw', () async {
      void readAll() {
        final cp = fw.controlPoints;
        expect(cp.getBooleanValue('', true), isTrue);
        expect(cp.getNumberValue('k', 3), 3);
        expect(cp.getObjectValue('k', const <Object?>[1]), <Object?>[1]);
        expect(cp.evaluate('k', FlagType.number, 'x').isError, isTrue);
      }

      readAll();
      await start(environment: 'dev');
      readAll();
      await fw.shutdown();
      readAll();
    });

    test('status never includes the key', () async {
      await start(
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      expect(fw.status.toString(), isNot(contains('s3cr3t')));
      expect(fw.status.toJson().values.join(' '), isNot(contains('s3cr3t')));
    });
  });

  group('identity', () {
    test(
      'identify registers the user and re-prefetches under them; reset switches back',
      () async {
        await start(
          defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
        );
        final device = fw.deviceId!;
        expect(device, matches(RegExp(r'^dev_[0-9a-f-]{36}$')));

        final result = await fw.identify(
          'user-1',
          properties: <String, Object?>{'plan': 'pro'},
        );
        expect(result.ok, isTrue);
        expect(transport.registers.single.body, <String, Object?>{
          'targetingKey': 'user-1',
          'kind': 'user',
          'properties': <String, Object?>{'plan': 'pro'},
        });
        expect(
          transport.evaluates.map((r) => r.body['targetingKey']),
          <Object?>[device, 'user-1'],
        );

        await fw.reset();
        expect(transport.evaluates.last.body['targetingKey'], device);
        expect(fw.deviceId, device);
      },
    );

    test('identify before start resolves a failure with one warning', () async {
      final result = await fw.identify('user-1');
      expect(result.ok, isFalse);
      expect(result.error!.kind, ErrorKind.notReady);
    });

    test('identify registers even when the boot prefetch failed', () async {
      transport.evaluateStatus = 500;
      await start(
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      expect(fw.status.state, StartState.error);
      expect((await fw.identify('user-1')).ok, isTrue);
      expect(transport.registers, hasLength(1));
    });

    test('a blank key is refused and leaves the decisions alone', () async {
      await start(
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      final result = await fw.identify(' ');
      expect(result.ok, isFalse);
      expect(result.error!.kind, ErrorKind.invalidContext);
      expect(transport.evaluates, hasLength(1));
    });

    test('concurrent identify then reset: the last call wins', () async {
      await start(
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      final device = fw.deviceId;
      unawaited(fw.identify('user-1'));
      await fw.reset();
      expect(transport.evaluates.last.body['targetingKey'], device);
    });

    test(
      'a per-call targetingKey does not change the decision, and warns once',
      () async {
        await start(
          defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
        );
        final ctx = EvaluationContext(targetingKey: 'someone-else');
        expect(
          fw.controlPoints.getBooleanValue('new-checkout', false, context: ctx),
          isTrue,
        );
        fw.controlPoints.getBooleanValue('new-checkout', false, context: ctx);
        expect(log.containing('per-call targetingKey'), hasLength(1));
      },
    );

    test('an app-supplied deviceId is used verbatim and not stored', () async {
      final store = MemoryStore();
      await start(
        deviceId: 'analytics-id-1',
        store: store,
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      expect(fw.deviceId, 'analytics-id-1');
      expect(transport.evaluates.single.body['targetingKey'], 'analytics-id-1');
      expect(store.writes, 0);
    });

    test('a deviceIdStore keeps the id across starts', () async {
      final store = MemoryStore();
      final defines = <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey};
      await start(store: store, defines: defines);
      final first = fw.deviceId;
      expect(store.value, first);
      await fw.shutdown();
      await start(store: store, defines: defines);
      expect(fw.deviceId, first);
      expect(store.writes, 1);
    });

    test('without a store the id is in memory, fresh per start', () async {
      final defines = <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey};
      await start(defines: defines);
      final first = fw.deviceId;
      await fw.shutdown();
      await start(defines: defines);
      expect(fw.deviceId, isNot(first));
    });

    test(
      'a store that throws falls back to an in-memory id with one warning',
      () async {
        final store = MemoryStore()..failing = true;
        await start(
          store: store,
          defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
        );
        expect(fw.status.state, StartState.ready);
        expect(fw.deviceId, startsWith('dev_'));
        expect(log.containing('deviceIdStore could not be read'), hasLength(1));
      },
    );

    test('reset(rotateDeviceId: true) mints and stores a new id', () async {
      final store = MemoryStore('dev_old');
      await start(
        store: store,
        defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
      );
      expect(fw.deviceId, 'dev_old');
      await fw.reset(rotateDeviceId: true);
      expect(fw.deviceId, isNot('dev_old'));
      expect(store.value, fw.deviceId);
      expect(store.deletes, 1);
      expect(transport.evaluates.last.body['targetingKey'], fw.deviceId);
    });

    test(
      'local mode records identify in-process and never touches the store',
      () async {
        final store = MemoryStore();
        await start(store: store, environment: 'dev');
        expect((await fw.identify('user-1')).ok, isTrue);
        expect(
          log.containing('[fireweave:local] registerTarget user user-1'),
          hasLength(1),
        );
        expect(store.writes, 0);
      },
    );
  });

  group('remote failures', () {
    test(
      'a 401 logs one key-rejected line naming the define, never the key',
      () async {
        transport.evaluateStatus = 401;
        transport.registerStatus = 401;
        await start(
          defines: <String, String>{
            'FIREWEAVE_BROWSER_KEY': browserKey,
            'FIREWEAVE_URL': url,
          },
        );
        await fw.identify('user-1');
        final lines = log.containing(
          'rejected the key from FIREWEAVE_BROWSER_KEY',
        );
        expect(lines, hasLength(1));
        expect(lines.single, contains('flags.example.com'));
        expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
        expect(fw.status.problem?.reason, 'key-rejected');
        expect(fw.status.lastErrorKind, ErrorKind.authentication);
        expect(
          fw.controlPoints.getBooleanValue('new-checkout', false),
          isFalse,
        );
      },
    );

    test(
      'with the key passed as an option, the line names the option',
      () async {
        transport.evaluateStatus = 401;
        await start(key: browserKey);
        expect(
          log.containing('rejected the key from Fireweave.start(key:)'),
          hasLength(1),
        );
      },
    );

    test(
      'an unreachable fw-server logs once; a later success clears the problem',
      () async {
        transport.throwOnEvaluate = FireweaveError(ErrorKind.network);
        await start(
          defines: <String, String>{'FIREWEAVE_BROWSER_KEY': browserKey},
        );
        expect(fw.status.problem?.reason, 'unreachable');
        transport.throwOnEvaluate = null;
        await fw.identify('user-1');
        expect(fw.status.state, StartState.ready);
        expect(fw.status.problem, isNull);
        expect(fw.status.lastErrorKind, ErrorKind.network);
        expect(log.containing('Could not reach fw-server'), hasLength(1));
      },
    );

    test('local mode reports no remote failures', () async {
      await start(environment: 'dev');
      await fw.identify('user-1');
      expect(fw.status.lastErrorKind, isNull);
    });
  });
}
