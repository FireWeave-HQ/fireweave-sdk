package ai.fireweave.sdk.domain;

/**
 * SDK runtime mode (spec/modes.md). An SDK instance runs in exactly one mode, fixed at
 * initialisation; the mode selects the adapter and nothing downstream branches on it again.
 *
 * <p>{@code mode} is required and never inferred: {@code InitOptions.mode()} is nullable
 * precisely so a caller (or a config file half-migrated from remote to local) can construct an
 * options value with no mode at all, which {@code Validation.validateInitOptions} rejects as
 * {@code Configuration} — "mode absent" in spec/modes.md's initialisation-validation table.
 * "mode unrecognised" (the table's other half of that row) has no Java analogue: an enum-typed
 * field cannot hold a value outside {@link #LOCAL}/{@link #REMOTE} in the first place.
 */
public enum Mode {
    LOCAL,
    REMOTE
}
