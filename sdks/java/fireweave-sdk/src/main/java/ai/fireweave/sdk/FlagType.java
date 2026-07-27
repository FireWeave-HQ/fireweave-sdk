package ai.fireweave.sdk;

/** Requested flag value type. Integer and float are distinct (OpenFeature Java splits them). */
public enum FlagType {
    BOOLEAN,
    STRING,
    INTEGER,
    FLOAT,
    OBJECT;

    /** Canonical lower-case fixture string ("boolean" | "string" | "integer" | "float" | "object"). */
    public String canonical() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }

    public static FlagType fromCanonical(String s) {
        return valueOf(s.toUpperCase(java.util.Locale.ROOT));
    }
}
