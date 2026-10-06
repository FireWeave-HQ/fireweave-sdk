// The server start profile: a Dart VM server, CLI or AOT executable.
//
//   FIREWEAVE_ENV=development dart run example/start_server_example.dart
//   FIREWEAVE_KEY=project-api-key_... dart run example/start_server_example.dart
//
// The key comes from the process environment only, never a compile-time
// define, so it is never baked into an executable. Start once per isolate,
// before serving; shut down on SIGTERM so the process exits promptly.
import 'package:fireweave/server.dart';

// Conventionally lib/fireweave/controlPoints.dart.
final controlPoints = defineControlPoints({
  'nightly-reindex': const LocalControlPoint.local(
    true,
    description: 'Nightly reindex',
  ),
});

Future<void> main() async {
  // Throws a Configuration FireweaveError on a bad configuration (for
  // example no FIREWEAVE_KEY outside a development environment).
  await Fireweave.start(controlPoints: controlPoints);

  // Server-subject reads are prefetched under fw.instanceKey
  // (FIREWEAVE_INSTANCE_ID, else a hash of the host name).
  // @fireweave-controlpoint nightly-reindex
  final on = fw.controlPoints.getBooleanValue('nightly-reindex', false);
  // ignore: avoid_print
  print('nightly-reindex: $on (instance ${fw.instanceKey})');

  // Durable targeting facts at sign-in; does not change server reads.
  await fw.identify('user_42', properties: {'plan': 'pro'});

  // ignore: avoid_print
  print(fw.status);
  await fw.shutdown();
}
