import 'owned_transport_types.dart';

/// Platforms without `dart:io` (the web): no owned transport, so the core's
/// platform default (`fetch`) is used.
OwnedTransport? createOwnedTransport() => null;

/// Whether this platform has `dart:io` (chosen by the same conditional
/// import). dart2js and dart2wasm compile a `dart:io` import into stubs that
/// throw at run time, so the server profile checks this to refuse the web.
const bool hasDartIo = false;
