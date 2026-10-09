import 'package:fireweave/fireweave.dart';

/// An [HttpTransport] the start layer created and therefore closes.
abstract interface class OwnedTransport implements HttpTransport {
  /// Release every connection. Idempotent; never throws.
  void close();
}
