package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.FireweaveError;

import java.util.Objects;

/**
 * Result of a {@link FireweaveClient} extension call ({@link FireweaveClient#invokeCapability}).
 * Extension calls never throw on the normal path; failures degrade to a result carrying a
 * {@link FireweaveError} (fixture {@code ext-unsupported-capability-degrade}).
 */
public final class ExtensionResult<T> {

    private final boolean ok;
    private final T value;
    private final FireweaveError error;
    private final boolean degraded;

    private ExtensionResult(boolean ok, T value, FireweaveError error, boolean degraded) {
        this.ok = ok;
        this.value = value;
        this.error = error;
        this.degraded = degraded;
    }

    public static <T> ExtensionResult<T> ok(T value) {
        return new ExtensionResult<>(true, value, null, false);
    }

    public static <T> ExtensionResult<T> failure(FireweaveError error) {
        return new ExtensionResult<>(false, null, Objects.requireNonNull(error, "error"), false);
    }

    public static <T> ExtensionResult<T> degraded(FireweaveError error) {
        return new ExtensionResult<>(false, null, Objects.requireNonNull(error, "error"), true);
    }

    public boolean isOk() {
        return ok;
    }

    /** Value on success; null on failure. */
    public T value() {
        return value;
    }

    /** Error on failure; null on success. */
    public FireweaveError error() {
        return error;
    }

    /** True when the call degraded gracefully (e.g. UnsupportedCapability) instead of failing hard. */
    public boolean isDegraded() {
        return degraded;
    }
}
