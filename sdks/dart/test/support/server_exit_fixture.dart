import 'dart:io';

import 'package:fireweave/server.dart';

/// A tiny server-profile program for `start_server_test.dart`'s exit tests:
/// starts, reads once, optionally calls `fw.shutdown()`, and returns from
/// `main`. The VM exits only when nothing (a timer, a socket) keeps the
/// isolate alive, which is exactly what those tests measure.
///
/// Arguments: `remote <url>` or `local`, then `shutdown` or `no-shutdown`.
Future<void> main(List<String> args) async {
  final remote = args[0] == 'remote';
  await Fireweave.start(
    controlPoints: defineControlPoints(<String, LocalControlPoint>{
      'new-checkout': const LocalControlPoint.local(true),
    }),
    env: remote
        ? <String, String>{
            'FIREWEAVE_KEY': 'project-api-key_exitfixture',
            'FIREWEAVE_URL': args[1],
          }
        : <String, String>{'FIREWEAVE_ENV': 'dev'},
    log: (_) {},
  );
  stdout.writeln(fw.controlPoints.getBooleanValue('new-checkout', false));
  if (args.last == 'shutdown') {
    await fw.shutdown();
  }
}
