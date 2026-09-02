# ADR-0011: A Dart SDK for control points — Flutter on every platform, and the Dart VM

- **Status:** Accepted
- **Date:** 2026-09-02
- **Scope:** `sdks/dart` (the package published as `fireweave` on pub.dev)
- **Supersedes:** the *Dart surface* row (and the Flutter half of the *Mobile* row) in [ADR-0004](0004-server-first.md)'s "Future work" table; the "Dart remains out of scope" consequence in [ADR-0009](0009-browser-control-points.md)
- **Related:** ADR-0009 (browser control points — the architecture this reuses), ADR-0010 (v1 scope), ADR-0007 (control-point vocabulary)

## Context and Problem Statement

[ADR-0004](0004-server-first.md) put mobile and Dart out of phase one. Its reasons were capacity and the secret-key hazard, not disinterest. Two things have changed since.

1. **The UI-runtime constraint has a solved shape.** A UI framework cannot `await` inside a render path. [ADR-0009](0009-browser-control-points.md) resolved that for browsers by moving the async/sync boundary into the runtime — prefetch a decision cache asynchronously, evaluate as a pure synchronous read — and the Swift SDK reused that seam unchanged for iOS. Flutter's `build()` has exactly the same constraint, and therefore exactly the same answer.
2. **There is no OpenFeature dependency to wait for.** [ADR-0010](0010-control-points-only-v1.md) made Fireweave own the evaluation path outright. A Dart SDK no longer depends on the maturity of an OpenFeature Dart SDK; it depends only on the Dart SDK itself.

Dart is one language across many runtimes: Flutter on six platforms, the Dart VM on servers and CLIs, and Dart compiled to JavaScript or WebAssembly. Every other client surface (browser, iOS) has an open, auditable, zero-dependency implementation; Dart has nothing.

## Decision

**Ship `fireweave` for Dart at `sdks/dart`, as the eighth conformant SDK — one package for every platform Dart runs on.**

### Shape

Web's and Swift's, not node's. `initFireweave`, `refresh`, and `identify` are `async` and populate a decision cache; the nine `controlPoints` methods are **synchronous** cache reads. A boot that misses the prefetch ceiling enters `STALE` and serves defaults with reason `STALE` — a timed-out boot stays distinguishable from a rollout sitting at 0% (ADR-0009 "Fail-open, not fail-silent"). Both modes (`spec/modes.md`) are supported, like Swift; local `registerTarget` is recorded in-process and traced to an injectable sink.

### Every Dart platform, from SDK libraries alone

The one place the SDK touches the network is the `HttpTransport` port, and its default is chosen at compile time by conditional import:

| Platform | SDK library | Transport |
|---|---|---|
| Dart VM; Flutter on Android, iOS, macOS, Windows, Linux | `dart:io` | `HttpClient` |
| Flutter web; `dart compile js`; `dart compile wasm` | `dart:js_interop` | the browser's `fetch`, hand-bound |

Both are Dart SDK libraries, not pub packages — the same standing Swift gave Foundation and Rust gave `std`. `dart:js_interop` is used rather than the retired `dart:html` (which never worked under WebAssembly) and rather than `package:web` or `package:http` (pub dependencies). The browser's own origin model applies on the web leg: fw-server must answer CORS preflights for the app's origin, which ADR-0009 already made a platform property.

`pubspec.yaml` declares all six Flutter platforms explicitly. The package is tested on two legs — the VM and Chrome (the whole runtime under dart2js) — and the example is compiled for both JavaScript and WebAssembly in CI, so the conditional-import seam is proven on every web compiler without depending on a browser being present.

### Pure Dart, no `flutter` SDK dependency, zero runtime dependencies

`pubspec.yaml` carries no `dependencies:` block and never imports `package:flutter`. Consequences, all deliberate:

- the package runs unchanged in a Flutter app and in any plain Dart program;
- CI needs only `dart-lang/setup-dart` — installing the Flutter toolchain (~1 GB per job) would assert a property no code path depends on;
- a future widget layer (an `InheritedWidget` scope, say) is a separate, optional package that depends on this one, never a dependency baked into it.

Guarded by `test/architecture_guard_test.dart` (parses `pubspec.yaml` and every `import` in `lib/`) and `test/portability_guard_test.dart` (confines `dart:io` and `dart:js_interop` to their one transport file each; bans the retired browser libraries, the pub HTTP/web packages, environment reads, and vendor key shapes).

### Conformance

A real runner over the shared 65 fixtures (`conformance/run_conformance.dart`), with the disposition Swift ruled on for the identical architecture: 37 pass, 15 `skipped-with-documented-limitation` (6 context fixtures whose backend matching is driven by invocation-only context, 8 faults fixtures whose premise is a per-call HTTP fault, 1 integer/float fixture no v1 language can represent), 13 `skipped-v1-out-of-scope`. `tools/conformance/compare.mjs` places `dart` in the real-no-baseline tier with rust and swift; the matrix becomes 65 × 8. `conformance/surface/control-points.surface.json` gains a `dart` cell. A `dart test` wrapper pins the exact decomposition, so a per-language `verify` cannot go green while the fixture run drifts.

### Packaging and release

Package name `fireweave` (free on pub.dev at the time of writing; the same name Python and Rust publish under — there is no Flutter dependency to justify a `_flutter` suffix, and the package is not Flutter-only). Release component `dart`, tag `dart/vX.Y.Z`, version in lockstep with the other manifests. pub.dev has no staging registry and a published version can only be retracted, never deleted, so the channel shape is rust's: staging = `dart pub publish --dry-run` plus the git tag; production = pub.dev automated publishing (OIDC, `environment: release`), which pub.dev rejects until it is enabled for the package — fail-closed by construction.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A Flutter plugin depending on `package:flutter`, shipping widgets** | Forces the Flutter toolchain into every CI job and blocks Dart VM use, to ship a convenience layer that can be an optional package on top of this one |
| **Async reads, node's shape** | A widget's `build()` cannot `await`; every read site would need a `FutureBuilder` for a decision that must already be in memory |
| **`package:http` for a single cross-platform transport** | A runtime dependency, when `dart:io` and `dart:js_interop` already ship the clients. The zero-dependency budget is what keeps eight languages tractable (ADR-0010) |
| **`dart:html` for the web transport** | Retired by the Dart team and never available under `dart compile wasm`; `dart:js_interop` is its replacement |
| **Web as an unsupported boundary (inject-your-own transport)** | Honest but leaves Flutter web — a first-class Flutter target — without a working default; a hand-bound `fetch` costs one file and no dependency |
| **Name it `fireweave_flutter`** | Misdescribes a package with no Flutter dependency that also runs on servers; Python and Rust already publish as `fireweave` |
| **Declare all 65 fixtures not-applicable, as web does** | Swift showed 37 of them run for real on this architecture; a blanket synthesis would discard that signal |

## Consequences

- **Positive:** Dart gets the same open, vendor-neutral, zero-dependency treatment as every other surface, on every platform it runs on; the harness can scaffold a Dart surface against a real SDK; the UI-runtime constraint is answered by reusing a proven seam rather than a new design.
- **Negative:** an eighth package to version, publish, and keep in conformance; a second test leg (Chrome) and two web compiles in CI; pub.dev automated publishing must be provisioned before a production release.
- **Security:** the same posture as ADR-0009's browser package. A project key baked into an app bundle — mobile or web — is public by construction, so the scoped `fw_public_…` key family and per-key rate limiting that ADR-0009 names as required platform work apply here equally. Nothing in this package reads an environment, accepts a vendor key shape, or evaluates locally in remote mode.
- **Neutral:** ADR-0004 stands for everything else it decided; this ADR retires its *Dart surface* row and the Flutter half of *Mobile*. Native Android/iOS beyond Swift, edge, and WASM outside Dart remain where ADR-0004 left them.

## What this does not decide: on-device persistence

The cache this SDK holds is in-memory and per process. A **persisted** decision cache (survive a cold start, serve the last-known decisions before the first prefetch completes) is plausible follow-up work, and it is platform-specific in exactly the way the transport is: durable storage is a file under an app-private directory on the VM and on Flutter mobile/desktop, and `localStorage`/IndexedDB on the web. The decision recorded here is only that it would take the **same shape** as the transport, not a fourth architecture:

- a `DecisionCacheStore` port beside `HttpTransport` in `application/ports.dart`, with the runtime staying mode- and platform-blind;
- platform defaults chosen by conditional import from SDK libraries alone (`dart:io` files; `dart:js_interop` over `localStorage`), never a pub dependency;
- on Flutter mobile the SDK cannot locate the app's sandboxed documents directory itself — it reads no environment and holds no platform channel — so the **caller supplies the directory** (from `path_provider` in the app), or an optional `fireweave_flutter` companion package wires it; the core stays zero-dependency either way;
- cache-served reads surface as reason `CACHED`/`STALE` with `fireweave.fromCache`, which the decision model and the runtime already carry (`spec/decision.schema.json`), so call sites never learn which platform stored the bytes.

Whether to build it at all — and whether a stale persisted decision may ever be served ahead of a fresh prefetch under a progressive rollout — is a spec question (`spec/modes.md`) for every language, not a Dart packaging question.
