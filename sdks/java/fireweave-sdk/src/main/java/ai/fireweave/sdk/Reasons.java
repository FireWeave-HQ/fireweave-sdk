package ai.fireweave.sdk;

/** Standard OpenFeature reason strings used in Fireweave decisions (open string set). */
public final class Reasons {
    public static final String STATIC = "STATIC";
    public static final String DEFAULT = "DEFAULT";
    public static final String TARGETING_MATCH = "TARGETING_MATCH";
    public static final String SPLIT = "SPLIT";
    public static final String CACHED = "CACHED";
    public static final String DISABLED = "DISABLED";
    public static final String UNKNOWN = "UNKNOWN";
    public static final String STALE = "STALE";
    public static final String ERROR = "ERROR";

    private Reasons() {
    }
}
