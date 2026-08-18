package ai.fireweave.openfeature;

import java.util.Objects;

/**
 * One evaluation observed through {@link FireweaveLocalProvider}, recorded as the
 * caller saw it (including the FLAG_NOT_FOUND → DEFAULT rewrite).
 */
public final class FwLocalCapture {

    private final String flagKey;
    private final String type;
    private final Object value;
    private final String reason;
    private final long ts;

    public FwLocalCapture(String flagKey, String type, Object value, String reason, long ts) {
        this.flagKey = Objects.requireNonNull(flagKey, "flagKey");
        this.type = Objects.requireNonNull(type, "type");
        this.value = value;
        this.reason = reason == null ? "UNKNOWN" : reason;
        this.ts = ts;
    }

    public String flagKey() {
        return flagKey;
    }

    /** {@code boolean} | {@code string} | {@code integer} | {@code double} | {@code object}. */
    public String type() {
        return type;
    }

    public Object value() {
        return value;
    }

    public String reason() {
        return reason;
    }

    /** Epoch millis (or the injected clock). */
    public long ts() {
        return ts;
    }

    @Override
    public String toString() {
        return "FwLocalCapture{" + type + " " + flagKey + "=" + value + " (" + reason + ")}";
    }
}
