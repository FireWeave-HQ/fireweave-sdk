/// The ONLY file in this package that reads the process environment or the
/// host name.
///
/// The core reads no environment (`spec/modes.md`); the server start profile
/// is the documented exception (docs/adr/0012-start-profile.md), and
/// test/start_guard_test.dart pins both lookups to this file. It imports
/// `dart:io`, so `package:fireweave/server.dart` compiles only where
/// `dart:io` exists: the Dart VM, AOT executables and Flutter on mobile and
/// desktop, never the web.
library;

import 'dart:io';

/// One variable from the process environment, or `null` when unset.
String? readProcessEnvironment(String name) {
  try {
    return Platform.environment[name];
  } on Object {
    return null;
  }
}

/// The operating system's host name, or `null` when it will not say.
String? readHostName() {
  try {
    return Platform.localHostname;
  } on Object {
    return null;
  }
}
