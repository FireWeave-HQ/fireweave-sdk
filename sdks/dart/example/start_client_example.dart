// The client start profile in a plain Dart program (a Flutter app makes the
// same calls in main() before runApp, and reads inside build()).
//
//   dart run -DFIREWEAVE_ENV=development example/start_client_example.dart
//   dart compile js -DFIREWEAVE_ENV=development example/start_client_example.dart
//   dart compile exe -DFIREWEAVE_BROWSER_KEY=fw_public_... example/start_client_example.dart
//
// Flutter: flutter run --dart-define-from-file=fireweave.env
// (FIREWEAVE_BROWSER_KEY, and optionally FIREWEAVE_URL and FIREWEAVE_ENV).
import 'package:fireweave/client.dart';

// Conventionally lib/fireweave/controlPoints.dart: every control point the app reads,
// with the value served in local mode only.
final controlPoints = defineControlPoints({
  'new-checkout': const LocalControlPoint.local(
    true,
    description: 'New checkout flow',
  ),
});

Future<void> main() async {
  // Never throws: a refused configuration leaves fw.status.state == failed and
  // every read serving its default.
  await Fireweave.start(controlPoints: controlPoints);

  // @fireweave-controlpoint new-checkout
  final on = fw.controlPoints.getBooleanValue('new-checkout', false);
  // ignore: avoid_print
  print('new-checkout: $on');

  await fw.identify('user_42', properties: {'plan': 'pro'}); // sign-in
  await fw.reset(); // sign-out: back to the device id

  // Mode, why, endpoint, key source and any problem; never the key.
  // ignore: avoid_print
  print(fw.status);
  await fw.shutdown();
}
