package ai.fireweave.sdk.domain;

/**
 * Requested flag value type for typed evaluation (spec/control-points.md "The nine methods").
 *
 * <p>Exactly four: boolean, string, number, object — there is no separate integer/float
 * distinction in v1 ({@code Decision.value} is {@code jsonValue}; {@code getNumberValue} returns
 * <b>number</b>, not integer — {@code conformance/surface/control-points.surface.json}). Java's
 * pre-v1 surface exposed a five-way {@code BOOLEAN/STRING/INTEGER/FLOAT/OBJECT} split; that is
 * the drift this enum now matches node/python in rejecting.
 */
public enum FlagType {
    BOOLEAN,
    STRING,
    NUMBER,
    OBJECT;

    /** Canonical lower-case fixture string ("boolean" | "string" | "number" | "object"). */
    public String canonical() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }

    public static FlagType fromCanonical(String s) {
        return valueOf(s.toUpperCase(java.util.Locale.ROOT));
    }
}
