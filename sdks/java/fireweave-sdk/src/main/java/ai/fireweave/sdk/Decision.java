package ai.fireweave.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable canonical flag decision (mirrors {@code spec/decision.schema.json}), produced by a
 * {@link BackendAdapter} / {@link FireweaveRuntime} and mapped to OpenFeature
 * {@code ProviderEvaluation} at the provider boundary. No vendor types appear here.
 *
 * <p>On error paths {@link #value()} is always the caller-supplied default, {@link #reason()} is
 * {@code ERROR}, and {@code flagMetadata} carries {@code fireweave.errorKind}.
 *
 * <p>flagMetadata values are OpenFeature scalars only: Boolean, String, or Number.
 */
public final class Decision {

    private final String flagKey;
    private final JsonValue value;
    private final String variant;
    private final String reason;
    private final FireweaveError error;
    private final Map<String, Object> flagMetadata;
    private final JsonValue payload;
    private final boolean exposureEmitted;
    private final boolean exposureSuppressed;

    private Decision(Builder b) {
        this.flagKey = Objects.requireNonNull(b.flagKey, "flagKey");
        this.value = Objects.requireNonNull(b.value, "value");
        this.variant = b.variant;
        this.reason = Objects.requireNonNull(b.reason, "reason");
        this.error = b.error;
        this.flagMetadata = Collections.unmodifiableMap(new LinkedHashMap<>(b.flagMetadata));
        this.payload = b.payload;
        this.exposureEmitted = b.exposureEmitted;
        this.exposureSuppressed = b.exposureSuppressed;
    }

    public static Builder builder(String flagKey) {
        return new Builder(flagKey);
    }

    public String flagKey() {
        return flagKey;
    }

    public JsonValue value() {
        return value;
    }

    public String variant() {
        return variant;
    }

    public String reason() {
        return reason;
    }

    /** Error occurrence, or null on success. */
    public FireweaveError error() {
        return error;
    }

    /** Scalar-only flagMetadata (Boolean | String | Number values). */
    public Map<String, Object> flagMetadata() {
        return flagMetadata;
    }

    /** Variant payload, or null. */
    public JsonValue payload() {
        return payload;
    }

    public boolean exposureEmitted() {
        return exposureEmitted;
    }

    public boolean exposureSuppressed() {
        return exposureSuppressed;
    }

    public static final class Builder {
        private final String flagKey;
        private JsonValue value;
        private String variant;
        private String reason = Reasons.UNKNOWN;
        private FireweaveError error;
        private final Map<String, Object> flagMetadata = new LinkedHashMap<>();
        private JsonValue payload;
        private boolean exposureEmitted;
        private boolean exposureSuppressed;

        private Builder(String flagKey) {
            this.flagKey = flagKey;
        }

        public Builder value(JsonValue value) {
            this.value = value;
            return this;
        }

        public Builder variant(String variant) {
            this.variant = variant;
            return this;
        }

        public Builder reason(String reason) {
            this.reason = reason;
            return this;
        }

        public Builder error(FireweaveError error) {
            this.error = error;
            return this;
        }

        /** Value must be a Boolean, String or Number (OpenFeature scalar contract). */
        public Builder metadata(String key, Object value) {
            if (value != null) {
                if (!(value instanceof Boolean || value instanceof String || value instanceof Number)) {
                    throw new IllegalArgumentException("flagMetadata values must be scalar, got "
                            + value.getClass().getSimpleName());
                }
                flagMetadata.put(key, value);
            }
            return this;
        }

        public Builder payload(JsonValue payload) {
            this.payload = payload;
            return this;
        }

        public Builder exposureEmitted(boolean emitted) {
            this.exposureEmitted = emitted;
            return this;
        }

        public Builder exposureSuppressed(boolean suppressed) {
            this.exposureSuppressed = suppressed;
            return this;
        }

        public Decision build() {
            return new Decision(this);
        }
    }
}
