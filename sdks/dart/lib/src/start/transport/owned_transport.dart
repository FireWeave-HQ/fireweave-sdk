/// The transport the start profile owns and closes on shutdown. The core's
/// own `dart:io` client is never closed by the core (its remote adapter's
/// shutdown only sets flags), and a keep-alive socket would hold a Dart VM
/// process open for its idle timeout, so on `dart:io` platforms the start
/// layer brings its own and closes it.
///
/// On the web there is no owned transport: [createOwnedTransport] returns
/// `null` there and the core's `fetch` default is used.
library;

export 'owned_transport_stub.dart'
    if (dart.library.io) 'owned_transport_io.dart'
    show createOwnedTransport, hasDartIo;
export 'owned_transport_types.dart' show OwnedTransport;
