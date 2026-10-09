import '../../application/ports.dart';
import '../../domain/errors.dart';

/// Selected by conditional import only on a platform with NEITHER `dart:io`
/// NOR `dart:js_interop`. No such Dart platform exists today — every
/// supported target has one of the two (`default_http_transport.dart`) —
/// so this is a fallback for a future platform, kept so the conditional
/// export is total.
///
/// Throwing here — at adapter construction, before any prefetch — is what
/// would make such a gap fail LOUDLY at boot (`spec/modes.md`
/// "Initialisation validation" spirit) rather than silently serving every
/// caller's default with a green boot log. Local mode never reaches this
/// file.
HttpTransport createDefaultHttpTransport() =>
    throw FireweaveError.configuration(
      'remote mode on this platform requires an injected httpTransport '
      '(neither dart:io nor dart:js_interop is available)',
      initFatal: true,
    );
