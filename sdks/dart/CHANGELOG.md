# Changelog

All notable changes to the `fireweave` Dart package. The repository-wide changelog
(`../../CHANGELOG.md`) carries the cross-language view.

## Unreleased (3.0.0)

BREAKING ([ADR-0013](../../docs/adr/0013-control-point-wire.md)): evaluate calls
`POST /v1/control-points/evaluate`; `Decision.controlPointMetadata` replaces `flagMetadata`;
`ErrorKind.controlPointNotFound` replaces `flagNotFound`; metadata keys are
`fireweave.controlPointVersion` and `fireweave.vendorControlPointId`; `client.flags` is removed;
the start profile takes `controlPoints` (`defineControlPoints`, `LocalControlPoint`).

## 2.2.0

Initial package aligned with the other Fireweave SDK manifests. Control-point
evaluation and target registration (spec v0.1.0) — the two v1 capabilities —
with synchronous reads over a prefetched cache
([ADR-0011](../../docs/adr/0011-dart-control-points.md)). One package for Flutter on
Android, iOS, macOS, Windows, Linux, and web, for the Dart VM, and for Dart compiled to
JavaScript or WebAssembly: the HTTP transport is chosen per platform from SDK libraries
(`dart:io`, or the browser's `fetch` via `dart:js_interop`). Zero runtime dependencies;
no `flutter` SDK dependency.
