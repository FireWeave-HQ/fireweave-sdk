# fireweave (Dart SDK)

Fireweave release-engineering SDK for Dart — **control points** and target registration, the
two v1 capabilities (`spec/control-points.md` "Scope of v1"). One package for Flutter on every
platform, the Dart VM, and Dart compiled to JavaScript or WebAssembly.

- **Dependency budget: zero.** `pubspec.yaml` has no `dependencies:` block at all, and no
  `flutter` SDK dependency. The HTTP transport comes from SDK libraries alone — `dart:io` on
  the VM and Flutter mobile/desktop, the browser's `fetch` through `dart:js_interop` on the web
  — chosen by conditional import. Guard tests assert all of it.
- **Synchronous reads.** `initFireweave` prefetches every decision for the current context; the
  nine `controlPoints` methods are pure cache reads, safe inside a widget's `build()`. Like the
  web and Swift SDKs, not the server ones
  ([ADR-0009](../../docs/adr/0009-browser-control-points.md),
  [ADR-0011](../../docs/adr/0011-dart-control-points.md)).
- **The SDK reads no environment variables** — every option is an explicit argument to
  `initFireweave` (`spec/modes.md`).
- **No vendor SDK, key, or hostname in your app.** Applications hold a Fireweave project key
  and talk to fw-server; which backend fw-server forwards to is fw-server's concern.

## Platforms

| Platform | Remote transport | Tested by |
| --- | --- | --- |
| Flutter — Android, iOS, macOS, Windows, Linux | `dart:io` `HttpClient` | `dart test` (VM leg) |
| Flutter — web | browser `fetch` (`dart:js_interop`) | `dart test -p chrome` + `dart compile js` |
| Dart VM (servers, CLIs) | `dart:io` `HttpClient` | `dart test` (VM leg) |
| `dart compile js` / `dart compile wasm` | browser `fetch` (`dart:js_interop`) | `dart compile js` / `dart compile wasm` of the example |

Local mode needs no transport and works everywhere. On the web, fw-server must answer CORS
preflights for your app's origin (the same platform property the JavaScript web SDK relies on).

## Install

```bash
flutter pub add fireweave   # Flutter apps, any platform
dart pub add fireweave      # Dart servers, CLIs, and web builds
```

From a repository checkout instead, depend on the package by path:

```yaml
dependencies:
  fireweave:
    path: ../fireweave-sdk/sdks/dart
```

## Quick start (production path)

```dart
import 'package:fireweave/fireweave.dart';

// mode is fixed by the options type you construct (spec/modes.md); apiKey and
// apiUrl are explicit — the SDK reads no environment. Boot fails LOUDLY on a
// bad configuration; reads on the returned client never throw.
final fw = await initFireweave(InitFireweaveOptions.remote(
  apiKey: 'project-api-key_...',
  apiUrl: 'https://app-server.fireweave.ai',
  context: EvaluationContext(targetingKey: deviceId), // prefetch under a stable key
));

// Once per login: the durable facts your targeting rules match on, then a
// re-prefetch under the user's id so percentage ramps bucket on it.
await fw.identify('user_42',
    options: const RegisterTargetOptions(properties: {'plan': 'pro'}));

// Inside build(): synchronous, never throws.
final enabled = fw.controlPoints.getBooleanValue('new-checkout', false);

await fw.shutdown();
```

A boot that times out against fw-server (5 s ceiling by default) does not block the
app: the runtime enters `STALE` and serves defaults with reason `STALE`, so a
timed-out boot stays distinguishable from a rollout at 0%. The next `identify()` /
`runtime.refresh()` gets a fresh attempt.

## Quick start (local dev — no network, no credentials)

```dart
final fw = await initFireweave(InitFireweaveOptions.local(
  controlPoints: {'new-checkout': true},
));
assert(fw.controlPoints.getBooleanValue('new-checkout', false));
await fw.registerTarget('user_42'); // recorded in-process + traced; nothing sent
```

The recorded target set is readable back (`spec/modes.md`) through the runtime's
adapter, the same pattern every other SDK's tests use:

```dart
final local = fw.runtime.backendAdapter as FireweaveLocalAdapter;
assert(local.registeredTargets().single.targetingKey == 'user_42');
```

The `[fireweave:local]` trace line goes to `print` by default (so it reaches the
Flutter console); pass `log:` to route it elsewhere.

## Quick start (offline, in-memory — tests)

```dart
final runtime = FireweaveRuntime(InMemoryAdapter.fromFlagsJson({
  'new-checkout': {'type': 'boolean', 'enabled': true, 'variant': 'on', 'value': true},
}));
await runtime.initialize(context: EvaluationContext(targetingKey: 'u1'));
final fw = FireweaveClient(runtime);
assert(fw.controlPoints.getBooleanValue('new-checkout', false));
```

To reuse your app's own HTTP client, or to fake the network in tests, pass an
`HttpTransport` to `InitFireweaveOptions.remote(httpTransport: ...)`.

## The nine methods

`getBooleanValue` / `getStringValue` / `getNumberValue` / `getObjectValue`, their
`*Details` counterparts (return the whole `Decision` — `reason`, `errorKind`,
`flagMetadata`, … — instead of just the value), and the general-form `evaluate`. All
nine live on `client.controlPoints`; `client.flags` is an identical, deprecated alias
(`identical(client.flags, client.controlPoints)` holds). `getNumberValue` returns
`num` — number, not integer, per the spec.

## Module layout

| Directory | Responsibility |
| --- | --- |
| `lib/src/domain/` | Pure types + validation: `errors`, `types`, `context`, `decision`, `mode`, `target`, `validation`. No I/O, no imports from `application/`/`infrastructure/`. |
| `lib/src/application/runtime.dart` | Lifecycle state machine, context layering, prefetch race, the synchronous evaluation pipeline. Evaluation never throws. |
| `lib/src/application/client.dart` | `FireweaveClient` — `controlPoints`, `registerTarget`, `identify`, `invokeCapability` (degrades; v1 has no supported capabilities). |
| `lib/src/application/init_fireweave.dart` | `initFireweave` — the single entry point and sanctioned composition root (the only application file allowed to import `infrastructure/`). |
| `lib/src/application/ports.dart` | The `ControlPointsBackendAdapter` and `HttpTransport` port boundary. |
| `lib/src/infrastructure/adapters/remote_adapter.dart` | `FireweaveRemoteAdapter` — the production backend (`POST /v1/flags/evaluate`, `POST /v1/targets/register`). |
| `lib/src/infrastructure/adapters/local_adapter.dart` | `FireweaveLocalAdapter` — the dev substrate: seeded boolean overrides, no network; `registerTarget` records in-process and traces. |
| `lib/src/infrastructure/adapters/in_memory_adapter.dart` | Deterministic fixture-driven adapter for tests. |
| `lib/src/infrastructure/hosts.dart` | SSRF allowlist (on by default; https required off-loopback). |
| `lib/src/infrastructure/transport/` | The `dart:io` and `fetch` transports, selected by conditional import. |

## Development

```bash
dart pub get
dart format --output=none --set-exit-if-changed .
dart analyze --fatal-infos
dart test                       # VM leg: unit + guards + the 65-fixture gate
dart test -p chrome             # browser leg: runtime under dart2js + fetch transport
dart compile js   -o /tmp/example.js   example/fireweave_example.dart
dart compile wasm -o /tmp/example.wasm example/fireweave_example.dart
dart run conformance/run_conformance.dart --contracts ../../contracts --out /tmp/report.json
dart pub publish --dry-run
```

## License

[MIT](LICENSE).
