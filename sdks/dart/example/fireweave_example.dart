// Runnable offline: `dart run example/fireweave_example.dart`.
// Against the repo's protocol stub (`node test-server/implementation/server.mjs`):
// `dart run example/fireweave_example.dart --remote`, or the same file compiled
// for the web (`dart compile js` / `dart compile wasm`) and run wherever
// `fetch` exists — the `--remote` branch is what keeps the remote adapter and
// the platform transport in a tree-shaken web build.
//
// In a Flutter app the same calls sit in `main()` (init) and inside widgets
// (`build()` reads control points synchronously — no FutureBuilder needed).
import 'package:fireweave/fireweave.dart';

Future<void> main(List<String> args) async {
  final remote = args.contains('--remote');

  // Local mode: no network, no credentials. Production swaps this single
  // options object for `InitFireweaveOptions.remote(...)`; the read sites
  // below do not change.
  final fw = await initFireweave(
    remote
        ? InitFireweaveOptions.remote(
            apiKey: 'project-api-key_dev',
            apiUrl: 'http://127.0.0.1:3901',
            allowedHosts: const ['127.0.0.1'],
            context: EvaluationContext(targetingKey: 'user_42'),
          )
        : InitFireweaveOptions.local(controlPoints: {'new-checkout': true}),
  );

  // Once per login: the durable facts your targeting rules match on.
  // In local mode this is recorded in-process and traced; nothing is sent.
  final registered = await fw.identify(
    'user_42',
    options: const RegisterTargetOptions(properties: {'plan': 'pro'}),
  );

  // Per render/request: synchronous reads, never throw. `new-checkout` is
  // seeded locally; the stub serves its own fixture keys (`fw-bool-on`, …),
  // so against it `new-checkout` resolves FLAG_NOT_FOUND -> the default.
  for (final key in ['new-checkout', if (remote) 'fw-bool-on']) {
    final details = fw.controlPoints.getBooleanDetails(key, false);
    // ignore: avoid_print
    print(
      '$key: ${details.value} (${details.reason.wireName}'
      '${details.errorKind == null ? '' : ', ${details.errorKind!.wireName}'})',
    );
  }
  // ignore: avoid_print
  print(
    'state: ${fw.runtime.state.wireName}; registerTarget ok: ${registered.ok}',
  );

  await fw.shutdown();
}
