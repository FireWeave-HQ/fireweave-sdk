package ai.fireweave.sdk;

/**
 * Canonical Fireweave error taxonomy (15 kinds, PascalCase), mirroring
 * {@code spec/errors.schema.json} and {@code contracts/errors.json}.
 *
 * <p>Enum constant names intentionally use PascalCase so that {@link #name()} is the canonical
 * cross-language {@code kind} string (e.g. {@code "AlreadyClosed"}).
 *
 * <p>The OpenFeature error code is carried here as a plain string so the core module has no
 * OpenFeature dependency; {@code fireweave-openfeature} maps it to
 * {@code dev.openfeature.sdk.ErrorCode} at the provider boundary.
 */
public enum ErrorKind {
    NotReady("PROVIDER_NOT_READY", true, FailureClass.TRANSIENT, "provider not ready"),
    FlagNotFound("FLAG_NOT_FOUND", false, FailureClass.PERMANENT, "flag not found"),
    TypeMismatch("TYPE_MISMATCH", false, FailureClass.PERMANENT, "flag type mismatch"),
    InvalidContext("INVALID_CONTEXT", false, FailureClass.PERMANENT, "invalid evaluation context"),
    Authentication("GENERAL", false, FailureClass.PERMANENT, "authentication failed"),
    Authorization("GENERAL", false, FailureClass.PERMANENT, "authorization failed"),
    RateLimited("GENERAL", true, FailureClass.TRANSIENT, "rate limited"),
    Timeout("GENERAL", true, FailureClass.TRANSIENT, "request timed out"),
    Network("GENERAL", true, FailureClass.TRANSIENT, "network error"),
    BackendUnavailable("GENERAL", true, FailureClass.TRANSIENT, "backend unavailable"),
    MalformedResponse("PARSE_ERROR", false, FailureClass.PERMANENT, "malformed backend response"),
    UnsupportedCapability("GENERAL", false, FailureClass.PERMANENT, "unsupported capability"),
    Configuration("PROVIDER_FATAL", false, FailureClass.PERMANENT, "invalid configuration"),
    AlreadyClosed("PROVIDER_NOT_READY", false, FailureClass.PERMANENT, "provider already closed"),
    Internal("GENERAL", false, FailureClass.PERMANENT, "internal error");

    /** Failure durability classification for adapters and signals. */
    public enum FailureClass {
        TRANSIENT,
        PERMANENT;

        /** Canonical lower-case string used in fixtures and wire shapes. */
        public String canonical() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    private final String openFeatureErrorCode;
    private final boolean retryable;
    private final FailureClass failureClass;
    private final String defaultMessage;

    ErrorKind(String openFeatureErrorCode, boolean retryable, FailureClass failureClass, String defaultMessage) {
        this.openFeatureErrorCode = openFeatureErrorCode;
        this.retryable = retryable;
        this.failureClass = failureClass;
        this.defaultMessage = defaultMessage;
    }

    /** Primary OpenFeature error code string for this kind (see errors.md for alternates). */
    public String openFeatureErrorCode() {
        return openFeatureErrorCode;
    }

    /** Whether a later identical call may succeed without a configuration change. */
    public boolean retryable() {
        return retryable;
    }

    public FailureClass failureClass() {
        return failureClass;
    }

    /** Safe, secret-free default message (canonical, matches contracts/errors.json). */
    public String defaultMessage() {
        return defaultMessage;
    }

    /** The flagMetadata key carrying the canonical kind on error decisions. */
    public static final String FLAG_METADATA_ERROR_KIND_KEY = "fireweave.errorKind";
}
