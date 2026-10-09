/// Fireweave SDK mode (`spec/modes.md`).
///
/// Dart, like Swift/Rust/Java, has a closed enum type — there is no value of
/// [Mode] that is neither [local] nor [remote], so "mode unrecognised" has no
/// direct analogue here. `validateInitOptions` takes `Mode?` so "absent" is
/// reachable and tested via `null`, matching the java/rust/swift precedent.
enum Mode {
  local,
  remote;

  /// The string used at the options boundary (`'local'` / `'remote'`).
  String get wireName => name;
}
