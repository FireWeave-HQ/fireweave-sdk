/// Target-registration vocabulary (`spec/remote-register-target.schema.json`).
library;

/// What is being registered. Recorded on the target so rules can distinguish
/// user-level from device-level targeting.
enum TargetKind {
  user,
  device;

  /// `spec/remote-register-target.schema.json`: `kind` defaults to `"user"`.
  static const TargetKind defaultKind = TargetKind.user;

  /// The string sent on the wire (`'user'` / `'device'`).
  String get wireName => name;
}
