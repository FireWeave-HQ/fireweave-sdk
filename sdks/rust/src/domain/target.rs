//! Target-registration vocabulary (`spec/remote-register-target.schema.json`).

/// What is being registered (`spec/remote-register-target.schema.json`
/// `kind`). Recorded on the target so rules can distinguish user-level
/// from device-level targeting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TargetKind {
    User,
    Device,
}

impl TargetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetKind::User => "user",
            TargetKind::Device => "device",
        }
    }
}

impl Default for TargetKind {
    /// `spec/remote-register-target.schema.json`: `kind` defaults to `"user"`.
    fn default() -> Self {
        TargetKind::User
    }
}

impl std::fmt::Display for TargetKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for TargetKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "user" => Ok(TargetKind::User),
            "device" => Ok(TargetKind::Device),
            _ => Err(()),
        }
    }
}
