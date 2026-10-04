/// FireWeave for Flutter apps (Android, iOS, macOS, Windows, Linux, web) and
/// Dart web apps, in one line: the client start profile
/// (docs/adr/0012-start-profile.md).
///
/// ```dart
/// // lib/fireweave/flags.dart: every control point the app reads
/// import 'package:fireweave/client.dart';
/// final flags = defineFlags({'new-checkout': Flag.local(true)});
///
/// // lib/main.dart
/// import 'package:fireweave/client.dart';
/// import 'fireweave/flags.dart';
///
/// Future<void> main() async {
///   await Fireweave.start(flags: flags); // before runApp
///   runApp(const App());
/// }
///
/// // anywhere, including build():
/// if (fw.controlPoints.getBooleanValue('new-checkout', false)) { ... }
/// ```
///
/// Build with the browser key as a compile-time define:
/// `flutter build apk --dart-define=FIREWEAVE_BROWSER_KEY=fw_public_...`
/// (or `--dart-define-from-file=fireweave.env`). `flutter run` with
/// `--dart-define=FIREWEAVE_ENV=development` and no key runs local.
///
/// This library reads no environment at run time and never imports
/// `dart:io` directly: the transport is chosen per platform by conditional
/// import, like the core's. Dart statics belong to one isolate, so start in
/// every isolate that reads. For Dart servers and CLIs use
/// `package:fireweave/server.dart`; the two cannot be imported into one
/// library (both declare `Fireweave` and `fw`).
library;

export 'fireweave.dart'
    show
        ControlPointsNamespace,
        Decision,
        DecisionReason,
        ErrorKind,
        EvaluateOptions,
        EvaluationContext,
        FireweaveClient,
        FireweaveError,
        FlagType,
        HttpTransport,
        JsonValue,
        LogSink,
        Mode,
        RegisterTargetResult,
        TargetKind,
        TransportResponse;
export 'src/start/build_info.dart' show buildSdkChannel, buildSdkVersion;
export 'src/start/channel.dart' show SdkChannel;
export 'src/start/client_profile.dart'
    show DeviceIdStore, Fireweave, FireweaveClientStart, fw;
export 'src/start/core.dart' show FireweaveStatus, StartProblem, StartState;
export 'src/start/flags.dart' show Flag, defineFlags;
