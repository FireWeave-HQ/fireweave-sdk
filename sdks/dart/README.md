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
- **The core reads no environment variables** — every option is an explicit argument to
  `initFireweave` (`spec/modes.md`). The opt-in start profile below is the one documented
  exception ([ADR-0012](../../docs/adr/0012-start-profile.md)), confined by guard tests to one
  define-reading file (client) and one environment-reading file (server).
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

**Staging builds** are `X.Y.Z-rc.N` and call `staging-app-server.fireweave.ai`. pub.dev never
receives one, so a staging build comes from its git tag, the highest `dart/vX.Y.Z-rc.N`:

```yaml
dependencies:
  fireweave:
    git:
      url: https://github.com/FireWeave-HQ/fireweave-sdk
      path: sdks/dart
      ref: dart/v3.0.0-rc.1
```

This is the one Dart install that records an exact build: `ref` pins the tag. To move to a newer
staging build, change `ref` to the higher `dart/v…-rc.N` tag and run `dart pub get`.

## Quick start (one line: the start profile)

The start profile ([ADR-0012](../../docs/adr/0012-start-profile.md)) is one awaited call over
the unchanged core: it resolves the key, the endpoint and the mode by rule, keeps one client
per isolate, and gives you `fw`. Dart runs no code on import and has no top-level `await`, so
the one line is `await Fireweave.start(...)` in `main`. `initFireweave` (below) is unchanged.

There are two profiles in this package; pick one per app.

### Flutter and Dart web apps: `package:fireweave/client.dart`

```dart
// lib/fireweave/control_points.dart: every control point the app reads, with its local value
import 'package:fireweave/client.dart';

final controlPoints = defineControlPoints({
  'new-checkout': LocalControlPoint.local(true, description: 'New checkout flow'),
});

// lib/main.dart
import 'package:fireweave/client.dart';
import 'fireweave/control_points.dart';

Future<void> main() async {
  await Fireweave.start(controlPoints: controlPoints); // before runApp; never throws
  runApp(const App());
}
```

```dart
// @fireweave-controlpoint new-checkout
if (fw.controlPoints.getBooleanValue('new-checkout', false)) { /* sync, safe in build() */ }

await fw.identify(user.id, properties: {'plan': user.plan}); // sign-in: register, re-prefetch
await fw.reset();                      // sign-out: back to the device id
await fw.reset(rotateDeviceId: true);  // consent withdrawn: a fresh device id
fw.deviceId;                           // the anonymous key, for analytics joins
fw.status;                             // mode, why, endpoint, key source, problem; never the key
fw.changes.listen((state) => ...);     // after start settles, identify, reset, shutdown
```

The client reads no environment at run time. The key, endpoint and environment name are
compile-time defines:

```bash
flutter run --dart-define=FIREWEAVE_ENV=development             # local, no key (debug launch configs only)
flutter build apk --dart-define-from-file=fireweave.env          # FIREWEAVE_BROWSER_KEY=fw_public_...
dart compile js -DFIREWEAVE_BROWSER_KEY=fw_public_... web/main.dart
```

Only browser keys (`fw_public_…`) are accepted: a browser key is public by construction, since
it ships inside the app. `FIREWEAVE_KEY` is never read as a define; passing it logs a warning
telling you to remove and revoke it. A change to a define needs a rebuild (a full restart in
`flutter run`), not a hot reload.

**Nothing throws.** An app that fails to start must still draw its first frame, so a refused
configuration logs one line, `fw.status.state` becomes `StartState.failed` with a `problem`, and
every read serves its default. A release build with no key and no development environment name
therefore runs on defaults; check `fw.status` (or forward `log:` to your crash reporter). This
package imports nothing from Flutter, so it cannot see the build mode: `flutter run` without a
key needs `--dart-define=FIREWEAVE_ENV=development`. Never put a development name in a release
define file.

**Device id.** Without options it is an in-memory `dev_<uuid>` for this run. Pass `deviceId:` to
use your own anonymous id (used verbatim, not stored), or `deviceIdStore:` to persist one. The
package has no dependencies, so it ships no store; a Flutter app can back one with
`shared_preferences`:

```dart
class PrefsDeviceIdStore implements DeviceIdStore {
  final _prefs = SharedPreferencesAsync();
  @override Future<String?> read() => _prefs.getString('fireweave.device-id');
  @override Future<void> write(String id) => _prefs.setString('fireweave.device-id', id);
  @override Future<void> delete() => _prefs.remove('fireweave.device-id');
}
```

A `fireweave_flutter` companion (persisted id, build-mode environment, rebuild scope, refresh
on resume) is planned and not part of this package.

### Dart servers, CLIs and executables: `package:fireweave/server.dart`

```dart
import 'dart:io';
import 'package:fireweave/server.dart';
import 'package:my_server/fireweave/control_points.dart';

Future<void> main() async {
  await Fireweave.start(controlPoints: controlPoints); // FIREWEAVE_KEY from the process environment
  ProcessSignal.sigterm.watch().listen((_) async {
    await fw.shutdown(); // closes the connection pool so the VM exits at once
    exit(0);
  });
  // serve...
}

// @fireweave-controlpoint nightly-reindex
if (fw.controlPoints.getBooleanValue('nightly-reindex', false)) { /* ... */ }

await fw.identify(user.id, properties: {'plan': user.plan}); // registers; reads do not change
fw.instanceKey; // FIREWEAVE_INSTANCE_ID, else inst_ + a hash of the host name
```

The key comes from the process environment only, never a define, so it is never baked into an
executable. `server.dart` refuses to start on the web. Server decisions are prefetched at start
under `fw.instanceKey` (the server is the subject): a read whose per-call
`context.targetingKey` differs serves the default with `InvalidContext` and warns once. Per-user
server reads are not part of the start profile; `initFireweave` with a per-user context covers
them.

In remote mode the server profile re-fetches its decisions every 30 seconds
(`refreshInterval:`; `Duration.zero` turns it off; local mode never re-fetches). A success swaps
the decisions in one step. A re-fetch that fails or times out keeps the last good decisions and
serves them with reason `STALE` (`fw.status.state` is `stale`), logs the failure once per kind
and records it in `fw.status`; the next success replaces them. Only a start whose first fetch
fails serves defaults. The pending re-fetch keeps the isolate alive, so `fw.shutdown()` stops
it: a CLI either calls `fw.shutdown()` when it is done or starts with
`refreshInterval: Duration.zero`.

### Options and overrides

Each value resolves as: the `Fireweave.start` option, then the client's compile-time define or
the server's environment variable, then the default. Empty and whitespace-only values count as
unset.

| Option | Client define | Server environment | Default | Notes |
| --- | --- | --- | --- | --- |
| `controlPoints` | — | — | `{}` | `defineControlPoints({...})`, checked with the core's key rule. Served in local mode only; a local read of a key missing from it gets its default and warns once. |
| `mode` | — | — | inferred | `Mode.local` or `Mode.remote`; see the mode rule. |
| `environment` | `FIREWEAVE_ENV` | `FIREWEAVE_ENV`, then `APP_ENV` | — | Only feeds the mode rule. `FW_ENV` is not read. |
| `url` | `FIREWEAVE_URL` | `FIREWEAVE_URL`, then legacy `FW_API_URL` / `FW_ATTEST_URL` (one warning) | this build's channel | `-rc.N` builds call `https://staging-app-server.fireweave.ai`, others `https://app-server.fireweave.ai`. https only, except `localhost`, `127.0.0.1` and `::1`. An override is the only extra allowed host. |
| `key` | `FIREWEAVE_BROWSER_KEY` | `FIREWEAVE_KEY`, then legacy `FW_PROJECT_API_KEY` (one warning) | — | Client: browser keys (`fw_public_…`) only; a server key gets a revoke instruction. Server: browser keys, analytics vendor keys and org/CLI tokens are refused. Messages name the source, never the value. |
| `deviceId` (client) | — | — | in-memory `dev_<uuid>` | App-supplied anonymous id. |
| `deviceIdStore` (client) | — | — | none | Persists the device id. |
| `instanceId` (server) | — | `FIREWEAVE_INSTANCE_ID` | `inst_` + FNV-1a-64 of `HOSTNAME` or the host name | The same hash as every other SDK; nothing is written to disk. |
| `env` (server) | — | — | the process environment | A map read instead, for tests. |
| `transport` | — | — | the profile's own `dart:io` client, closed by `fw.shutdown()`; `fetch` on the web | Not part of the configuration check. |
| `log` | — | — | `print` | Where `[fireweave]` lines go. Not part of the configuration check. |
| `refreshInterval` (server) | — | — | 30 s (`defaultServerRefreshInterval`) | How often remote mode re-fetches; `Duration.zero` turns it off. Not part of the configuration check. |

### The mode rule

1. An explicit `mode` wins: `Mode.local` ignores a key (one warning, nothing is sent);
   `Mode.remote` without a key is a configuration fault.
2. Otherwise a key means remote.
3. No key and an environment name of `development`, `dev`, `local` or `test` (trimmed, any case)
   means local.
4. Anything else fails closed: the server throws `FireweaveError` (`Configuration`,
   `PROVIDER_FATAL`) naming `FIREWEAVE_KEY`; the client becomes `failed` naming
   `FIREWEAVE_BROWSER_KEY`. A missing credential in production never becomes local evaluation.

### One client per isolate

- Dart statics belong to one isolate: call `Fireweave.start` in every isolate that reads
  (background isolates, `Isolate.run`, each isolate of a `shared: true` server).
- An identical second start is a no-op. A different one throws on the server; on the client it
  logs once and keeps the first. Local values are part of the check in local mode only.
- A read before start returns the default (`NotReady` for the `*Details` forms) and warns once.
  Reads never throw, before start, after a failed start, or after shutdown.
- `fw.shutdown()` closes everything; a later start begins fresh. In tests, call
  `Fireweave.debugResetForTests()` between cases.

### Is FireWeave working? `fw.status`

```dart
print(fw.status);
// FireweaveStatus(state: ready, mode: remote, modeSource: key, channel: production,
//   sdkVersion: 2.2.0, host: app-server.fireweave.ai,
//   endpointSource: SDK channel (production), keySource: FIREWEAVE_KEY, flagCount: 1)
```

It never contains the key. `problem` says why decisions are defaults: a configuration fault
(`missing-key`, `server-key`, `wrong-key-family`, `insecure-url`, `invalid-control-points`,
`start-failed`) or the last fw-server failure (`key-rejected` for 401/403, `rate-limited`,
`unreachable`, `unexpected-response`, cleared by a later success). Each kind of fw-server
failure also logs one line per isolate naming the key's source and the host, and
`lastErrorKind` keeps the latest kind (`Authentication`, `Authorization`, `RateLimited`,
`Network`, `Timeout`, `BackendUnavailable`, `MalformedResponse`), so a revoked key never looks
like a rollout at 0%. A local start logs one `[fireweave:local]` line, so a local boot
in a production log stands out.

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
`runtime.refresh()` gets a fresh attempt. Once a fetch has succeeded, a later one that fails or
times out keeps the last good decisions and serves them with reason `STALE`; only a failure
with no earlier success serves defaults with `ERROR`.

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
`controlPointMetadata`, … — instead of just the value), and the general-form `evaluate`.
All nine live on `client.controlPoints`; the `client.flags` alias was removed in 3.0.0
(ADR-0013). `getNumberValue` returns
`num` — number, not integer, per the spec.

## Module layout

| Directory | Responsibility |
| --- | --- |
| `lib/src/domain/` | Pure types + validation: `errors`, `types`, `context`, `decision`, `mode`, `target`, `validation`. No I/O, no imports from `application/`/`infrastructure/`. |
| `lib/src/application/runtime.dart` | Lifecycle state machine, context layering, prefetch race, the synchronous evaluation pipeline. Evaluation never throws. |
| `lib/src/application/client.dart` | `FireweaveClient` — `controlPoints`, `registerTarget`, `identify`, `invokeCapability` (degrades; v1 has no supported capabilities). |
| `lib/src/application/init_fireweave.dart` | `initFireweave` — the single entry point and sanctioned composition root (the only application file allowed to import `infrastructure/`). |
| `lib/src/application/ports.dart` | The `ControlPointsBackendAdapter` and `HttpTransport` port boundary. |
| `lib/src/infrastructure/adapters/remote_adapter.dart` | `FireweaveRemoteAdapter` — the production backend (`POST /v1/control-points/evaluate`, `POST /v1/targets/register`). |
| `lib/src/infrastructure/adapters/local_adapter.dart` | `FireweaveLocalAdapter` — the dev substrate: seeded boolean overrides, no network; `registerTarget` records in-process and traces. |
| `lib/src/infrastructure/adapters/in_memory_adapter.dart` | Deterministic fixture-driven adapter for tests. |
| `lib/src/infrastructure/hosts.dart` | SSRF allowlist (on by default; https required off-loopback). |
| `lib/src/infrastructure/transport/` | The `dart:io` and `fetch` transports, selected by conditional import. |
| `lib/client.dart`, `lib/server.dart`, `lib/src/start/` | The start profile, built only on the public API above. `client_defines.dart` is the only file that reads compile-time defines, `server_env_io.dart` the only one that reads the environment or the host name, and `build_info.dart` is stamped by `tools/release/version.sh apply dart`. |

## Development

```bash
dart pub get
dart format --output=none --set-exit-if-changed .
dart analyze --fatal-infos
dart test                       # VM leg: unit + guards + the 65-fixture gate
dart test -p chrome             # browser leg: runtime under dart2js + fetch transport
dart compile js   -o /tmp/example.js   example/fireweave_example.dart
dart compile wasm -o /tmp/example.wasm example/fireweave_example.dart
dart compile js   -DFIREWEAVE_ENV=development -o /tmp/start.js   example/start_client_example.dart
dart compile wasm -DFIREWEAVE_ENV=development -o /tmp/start.wasm example/start_client_example.dart
dart compile exe  -DFIREWEAVE_ENV=development -o /tmp/start example/start_client_example.dart && /tmp/start
dart run conformance/run_conformance.dart --contracts ../../contracts --out /tmp/report.json
dart pub publish --dry-run
```

## License

[MIT](LICENSE).
