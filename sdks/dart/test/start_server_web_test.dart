@TestOn('!vm')
library;

import 'package:fireweave/server.dart';
import 'package:test/test.dart';

/// dart2js and dart2wasm compile `package:fireweave/server.dart` (its
/// `dart:io` import becomes run-time stubs), so the server profile itself
/// refuses to start off `dart:io`, as node's browser build does. Runs on the
/// Chrome leg.
void main() {
  test('the server profile refuses to start on the web', () async {
    await expectLater(
      Fireweave.start(key: 'project-api-key_s3cr3t', mode: Mode.remote),
      throwsA(
        isA<FireweaveError>()
            .having((e) => e.kind, 'kind', ErrorKind.configuration)
            .having((e) => e.message, 'message', contains('client.dart'))
            .having((e) => e.message, 'message', isNot(contains('s3cr3t'))),
      ),
    );
    expect(fw.status.state, StartState.notStarted);
    expect(fw.controlPoints.getBooleanValue('k', true), isTrue);
  });
}
