/// Fireweave SDK mode (`spec/modes.md`).
///
/// **Spec-ambiguity note — "mode absent or unrecognised" in a closed-enum
/// language (recurrence of rust finding 3, task-12-report.md).** Swift, like
/// Rust and Java, has a closed enum type — there is no value of `Mode` that
/// is neither `.local` nor `.remote`, so "mode unrecognised" has no direct
/// Swift analogue for the SAME reason java's doc comment and rust's finding
/// 3 both give: an enum-typed field cannot hold a value outside its declared
/// cases. `InitOptions.mode: Mode?` (see `InitFireweave.swift`) makes
/// "absent" reachable and tested via `nil`, matching java/rust's precedent
/// exactly rather than re-deriving it.
public enum Mode: String, Sendable, Equatable {
  case local
  case remote
}
