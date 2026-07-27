package ai.fireweave.sdk;

import java.util.Objects;

/** Immutable exposure event (flag decision shown to a subject). */
public final class Exposure {

    private final String targetingKey;
    private final String flagKey;
    private final String variant;
    private final JsonValue value;
    private final String rolloutId;

    public Exposure(String targetingKey, String flagKey, String variant, JsonValue value, String rolloutId) {
        this.targetingKey = Objects.requireNonNull(targetingKey, "targetingKey");
        this.flagKey = Objects.requireNonNull(flagKey, "flagKey");
        this.variant = variant;
        this.value = value == null ? JsonValue.ofNull() : value;
        this.rolloutId = rolloutId;
    }

    public String targetingKey() {
        return targetingKey;
    }

    public String flagKey() {
        return flagKey;
    }

    public String variant() {
        return variant;
    }

    public JsonValue value() {
        return value;
    }

    public String rolloutId() {
        return rolloutId;
    }

    /** Deterministic dedup key: same subject + flag + variant + value collapses to one exposure. */
    public String dedupKey() {
        return targetingKey + "\u0000" + flagKey + "\u0000" + (variant == null ? "" : variant)
                + "\u0000" + value.toCanonicalJson();
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof Exposure)) {
            return false;
        }
        Exposure e = (Exposure) o;
        return dedupKey().equals(e.dedupKey()) && Objects.equals(rolloutId, e.rolloutId);
    }

    @Override
    public int hashCode() {
        return dedupKey().hashCode();
    }
}
