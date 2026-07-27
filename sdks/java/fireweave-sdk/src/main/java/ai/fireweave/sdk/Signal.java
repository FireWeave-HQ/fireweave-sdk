package ai.fireweave.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable canonical signal envelope (spec {@code signal.schema.json}). Recorded via
 * {@code FireweaveClient.signals().recordHealth/recordError/recordMetric/recordOutcome}.
 * Messages are secret-sanitized at construction.
 */
public final class Signal {

    public enum Kind {
        HEALTH, ERROR, METRIC, OUTCOME;

        public String canonical() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    private final Kind kind;
    private final String name;
    private final String status;
    private final ErrorKind errorKind;
    private final String message;
    private final JsonValue value;
    private final String targetingKey;
    private final String rolloutId;
    private final String changeId;
    private final String stampId;
    private final String flagKey;
    private final String variant;
    private final Map<String, JsonValue> attributes;

    private Signal(Builder b) {
        this.kind = Objects.requireNonNull(b.kind, "kind");
        this.name = Objects.requireNonNull(b.name, "name");
        if (name.isEmpty()) {
            // Empty names MUST be rejected before any backend track/capture (spec signal.schema.json).
            throw new IllegalArgumentException("signal name must not be empty");
        }
        this.status = b.status;
        this.errorKind = b.errorKind;
        this.message = Redaction.sanitize(b.message);
        this.value = b.value;
        this.targetingKey = b.targetingKey;
        this.rolloutId = b.rolloutId;
        this.changeId = b.changeId;
        this.stampId = b.stampId;
        this.flagKey = b.flagKey;
        this.variant = b.variant;
        this.attributes = Collections.unmodifiableMap(new LinkedHashMap<>(b.attributes));
    }

    public static Builder builder(Kind kind, String name) {
        return new Builder(kind, name);
    }

    public Kind kind() {
        return kind;
    }

    public String name() {
        return name;
    }

    public String status() {
        return status;
    }

    public ErrorKind errorKind() {
        return errorKind;
    }

    /** Sanitized human-readable detail (never contains phc_/phs_/phx_ secrets). */
    public String message() {
        return message;
    }

    public JsonValue value() {
        return value;
    }

    public String targetingKey() {
        return targetingKey;
    }

    public String rolloutId() {
        return rolloutId;
    }

    public String changeId() {
        return changeId;
    }

    public String stampId() {
        return stampId;
    }

    public String flagKey() {
        return flagKey;
    }

    public String variant() {
        return variant;
    }

    public Map<String, JsonValue> attributes() {
        return attributes;
    }

    public static final class Builder {
        private final Kind kind;
        private final String name;
        private String status;
        private ErrorKind errorKind;
        private String message;
        private JsonValue value;
        private String targetingKey;
        private String rolloutId;
        private String changeId;
        private String stampId;
        private String flagKey;
        private String variant;
        private final Map<String, JsonValue> attributes = new LinkedHashMap<>();

        private Builder(Kind kind, String name) {
            this.kind = kind;
            this.name = name;
        }

        public Builder status(String status) {
            this.status = status;
            return this;
        }

        public Builder errorKind(ErrorKind errorKind) {
            this.errorKind = errorKind;
            return this;
        }

        public Builder message(String message) {
            this.message = message;
            return this;
        }

        public Builder value(JsonValue value) {
            this.value = value;
            return this;
        }

        public Builder targetingKey(String targetingKey) {
            this.targetingKey = targetingKey;
            return this;
        }

        public Builder rolloutId(String rolloutId) {
            this.rolloutId = rolloutId;
            return this;
        }

        public Builder changeId(String changeId) {
            this.changeId = changeId;
            return this;
        }

        public Builder stampId(String stampId) {
            this.stampId = stampId;
            return this;
        }

        public Builder flagKey(String flagKey) {
            this.flagKey = flagKey;
            return this;
        }

        public Builder variant(String variant) {
            this.variant = variant;
            return this;
        }

        public Builder attribute(String key, JsonValue value) {
            attributes.put(key, value == null ? JsonValue.ofNull() : value);
            return this;
        }

        public Signal build() {
            return new Signal(this);
        }
    }
}
