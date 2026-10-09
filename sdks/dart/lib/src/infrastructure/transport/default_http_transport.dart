/// Conditional export — one transport per platform family, chosen at compile
/// time, all from SDK libraries (never a pub dependency):
///
/// | Platform | `dart:` library present | Transport |
/// | --- | --- | --- |
/// | Dart VM; Flutter on Android, iOS, macOS, Windows, Linux | `dart:io` | `IoHttpTransport` (`HttpClient`) |
/// | Flutter web, `dart compile js`, `dart compile wasm` | `dart:js_interop` | `WebHttpTransport` (`fetch`) |
/// | anything else (no such Dart platform today) | — | the loud-failing stub |
///
/// Only `createDefaultHttpTransport` crosses this boundary; callers can still
/// inject their own `HttpTransport` for tests or custom clients.
library;

export 'http_transport_stub.dart'
    if (dart.library.io) 'http_transport_io.dart'
    if (dart.library.js_interop) 'http_transport_web.dart'
    show createDefaultHttpTransport;
