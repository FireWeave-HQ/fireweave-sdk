package ai.fireweave.sdk;

import java.util.Objects;

/**
 * Outcome of target registration. {@code ok=false} means the target was
 * <em>not</em> registered — rules that depend on its properties will not match
 * until a later attempt succeeds.
 *
 * <p>Registration sits in login paths and must not throw. A careful caller logs
 * {@link #error()}; most call sites ignore the result.
 */
public final class RegisterTargetResult {

    private final boolean ok;
    private final FireweaveError error;

    private RegisterTargetResult(boolean ok, FireweaveError error) {
        this.ok = ok;
        this.error = error;
    }

    public static RegisterTargetResult success() {
        return new RegisterTargetResult(true, null);
    }

    public static RegisterTargetResult failure(FireweaveError error) {
        return new RegisterTargetResult(false, Objects.requireNonNull(error, "error"));
    }

    public boolean ok() {
        return ok;
    }

    /** Present when {@link #ok()} is false; null on success. */
    public FireweaveError error() {
        return error;
    }

    @Override
    public String toString() {
        return ok ? "RegisterTargetResult{ok=true}" : "RegisterTargetResult{ok=false, error=" + error + "}";
    }
}
