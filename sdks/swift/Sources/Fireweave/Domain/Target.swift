/// Target-registration vocabulary (`spec/remote-register-target.schema.json`).

/// What is being registered. Recorded on the target so rules can distinguish
/// user-level from device-level targeting.
public enum TargetKind: String, Sendable, Equatable {
  case user
  case device

  /// `spec/remote-register-target.schema.json`: `kind` defaults to `"user"`.
  public static let defaultKind: TargetKind = .user
}
