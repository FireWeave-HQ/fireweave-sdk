package domain

// Mode is the SDK runtime mode (spec/modes.md). An SDK instance runs in
// exactly one mode, fixed at initialisation; the mode selects the adapter
// and nothing downstream branches on it again.
//
// Mode is a plain string type rather than a closed enum deliberately: it is
// required and never inferred (spec/modes.md "mode is required and never
// inferred"), and ValidateInitOptions must be able to reject BOTH "absent"
// (the zero value "") and "unrecognised" (any string other than the two
// canonical values) as Configuration — a closed enum would make the latter
// unrepresentable, matching a caller-facing string option (e.g. read from a
// half-migrated config file) more faithfully than an enum would.
type Mode string

const (
	ModeLocal  Mode = "local"
	ModeRemote Mode = "remote"
)
