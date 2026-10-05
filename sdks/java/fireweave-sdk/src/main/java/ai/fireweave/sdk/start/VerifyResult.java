package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.Redaction;

/**
 * What {@link Fw#verify()} found: either fw-server accepted the configured key, or the error kind
 * that stopped it. Never contains the key, so it is safe to log. Immutable.
 */
public final class VerifyResult {

    private static final VerifyResult OK = new VerifyResult(true, null, null);

    private final boolean ok;
    private final ErrorKind errorKind;
    private final String message;

    private VerifyResult(boolean ok, ErrorKind errorKind, String message) {
        this.ok = ok;
        this.errorKind = errorKind;
        this.message = message;
    }

    static VerifyResult success() {
        return OK;
    }

    static VerifyResult failure(ErrorKind kind, String message) {
        ErrorKind k = kind == null ? ErrorKind.Internal : kind;
        return new VerifyResult(false, k, Redaction.sanitize(message == null ? k.defaultMessage() : message));
    }

    /** True when fw-server answered the probe with this key. */
    public boolean ok() {
        return ok;
    }

    /** Why the check failed; null when {@link #ok()}. */
    public ErrorKind errorKind() {
        return errorKind;
    }

    /** A redacted, human-readable reason; null when {@link #ok()}. */
    public String message() {
        return message;
    }

    @Override
    public String toString() {
        return ok ? "VerifyResult{ok}" : "VerifyResult{errorKind=" + errorKind + ", message=" + message + "}";
    }
}
