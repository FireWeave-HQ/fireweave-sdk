//! SDK runtime mode (`spec/modes.md`). An SDK instance runs in exactly one
//! mode, fixed at initialisation; the mode selects the adapter and nothing
//! downstream branches on it again.

/// `Mode` is a closed two-variant enum — the java precedent
/// (`ai.fireweave.sdk.domain.Mode`) for a statically-typed, closed-enum
/// host language. `spec/modes.md`'s initialisation-validation table has a
/// row for "mode absent or unrecognised": the "absent" half is reachable
/// here via `Option<Mode>` on `application::mode::InitOptions` (`None`);
/// the "unrecognised" half has no Rust analogue, exactly as java's doc
/// comment on `Mode` states — a value typed `Mode` cannot hold anything
/// outside [`Mode::Local`]/[`Mode::Remote`] in the first place, so there
/// is no "wrong string" state left to reject at runtime.
///
/// (See `application::mode::InitOptions` for why local- and remote-mode
/// fields still live on one flat struct rather than two disjoint types:
/// the "mode local combined with credentials" validation row needs that
/// combination to be constructible.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    Local,
    Remote,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Local => "local",
            Mode::Remote => "remote",
        }
    }
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
