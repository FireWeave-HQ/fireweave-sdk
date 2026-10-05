/// FireWeave for Dart servers, CLIs and AOT executables, in one line: the
/// server start profile (docs/adr/0012-start-profile.md).
///
/// ```dart
/// // lib/fireweave/flags.dart: every control point the app reads
/// import 'package:fireweave/server.dart';
/// final flags = defineFlags({'nightly-reindex': Flag.local(true)});
///
/// // bin/server.dart
/// import 'package:fireweave/server.dart';
///
/// Future<void> main() async {
///   await Fireweave.start(flags: flags); // FIREWEAVE_KEY from the environment
///   // serve; on SIGTERM: await fw.shutdown();
/// }
///
/// // anywhere:
/// if (fw.controlPoints.getBooleanValue('nightly-reindex', false)) { ... }
/// ```
///
/// The key comes from the process environment (`FIREWEAVE_KEY`), never from
/// a compile-time define, so it is never baked into an executable. This
/// library imports `dart:io` and therefore compiles only where `dart:io`
/// exists: the Dart VM, AOT executables, and Flutter on mobile and desktop,
/// never the web. Dart statics belong to one isolate, so start in every
/// isolate that reads. Flutter and web apps use
/// `package:fireweave/client.dart`.
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
export 'src/start/core.dart' show FireweaveStatus, StartProblem, StartState;
export 'src/start/flags.dart' show Flag, defineFlags;
export 'src/start/server_profile.dart'
    show Fireweave, FireweaveServerStart, defaultServerRefreshInterval, fw;
