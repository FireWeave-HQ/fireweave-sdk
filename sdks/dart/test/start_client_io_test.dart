@TestOn('vm')
@Timeout(Duration(minutes: 2))
library;

import 'dart:io';

import 'package:fireweave/client.dart';
import 'package:test/test.dart';

import 'support/loopback_fw_server.dart';
import 'support/start_doubles.dart';

/// The client profile on the VM: its owned `dart:io` transport against a
/// real loopback HTTP server, and the real `const` define reads through
/// `dart run -D...` (defines cannot be set inside a running test).
Future<ProcessResult> runExample(List<String> defines) => Process.run(
  Platform.resolvedExecutable,
  <String>['run', ...defines, 'example/start_client_example.dart'],
);

void main() {
  late LogCapture log;

  setUp(() async {
    await Fireweave.debugResetForTests();
    log = LogCapture();
  });

  tearDownAll(Fireweave.debugResetForTests);

  group('over real HTTP (the owned dart:io transport)', () {
    late LoopbackFwServer server;

    setUp(() async {
      server = await LoopbackFwServer.start(
        decisions: <String, Object?>{'new-checkout': true},
      );
    });

    tearDown(() => server.close());

    test(
      'evaluates, identifies and resets against a loopback fw-server',
      () async {
        await Fireweave.start(
          key: 'fw_public_s3cr3tvalue',
          url: server.url,
          log: log.call,
        );
        expect(fw.status.state, StartState.ready);
        expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
        final device = fw.deviceId;
        expect((await fw.identify('user-1')).ok, isTrue);
        await fw.reset();
        expect(server.requests.map((r) => r.path), <String>[
          '/v1/control-points/evaluate',
          '/v1/targets/register',
          '/v1/control-points/evaluate',
          '/v1/control-points/evaluate',
        ]);
        expect(
          server.requests
              .where((r) => r.path == '/v1/control-points/evaluate')
              .map((r) => r.body['targetingKey']),
          <Object?>[device, 'user-1', device],
        );
        expect(
          server.requests.first.authorization,
          'Bearer fw_public_s3cr3tvalue',
        );
        await fw.shutdown();
        expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
      },
    );

    test('a 401 over the wire logs key-rejected once', () async {
      server.status = 401;
      await Fireweave.start(
        key: 'fw_public_s3cr3tvalue',
        url: server.url,
        log: log.call,
      );
      await fw.identify('user-1');
      expect(
        log.containing('rejected the key from Fireweave.start(key:)'),
        hasLength(1),
      );
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isFalse);
      await fw.shutdown();
    });
  });

  group('compile-time defines (const reads, in a real program)', () {
    test('-DFIREWEAVE_ENV=development runs local', () async {
      final r = await runExample(<String>['-DFIREWEAVE_ENV=development']);
      expect(r.exitCode, 0, reason: '${r.stdout}${r.stderr}');
      expect(
        r.stdout,
        contains("environment 'development' from FIREWEAVE_ENV"),
      );
      expect(r.stdout, contains('new-checkout: true'));
    });

    test(
      'a server key as FIREWEAVE_BROWSER_KEY fails closed without printing it',
      () async {
        final r = await runExample(<String>[
          '-DFIREWEAVE_BROWSER_KEY=project-api-key_s3cr3tvalue',
        ]);
        expect(r.exitCode, 0, reason: '${r.stdout}${r.stderr}');
        expect(
          r.stdout,
          contains('The key from FIREWEAVE_BROWSER_KEY is a server key'),
        );
        expect(r.stdout, contains('new-checkout: false'));
        expect('${r.stdout}${r.stderr}', isNot(contains('s3cr3t')));
      },
    );

    test('a FIREWEAVE_KEY define is reported, never read', () async {
      final r = await runExample(<String>[
        '-DFIREWEAVE_KEY=project-api-key_s3cr3tvalue',
        '-DFIREWEAVE_ENV=dev',
      ]);
      expect(r.exitCode, 0, reason: '${r.stdout}${r.stderr}');
      expect(
        r.stdout,
        contains('FIREWEAVE_KEY was passed as a compile-time define'),
      );
      expect(r.stdout, contains('mode: local'));
      expect('${r.stdout}${r.stderr}', isNot(contains('s3cr3t')));
    });
  });
}
