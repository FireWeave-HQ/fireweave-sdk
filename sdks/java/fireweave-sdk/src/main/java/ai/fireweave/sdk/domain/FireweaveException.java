package ai.fireweave.sdk.domain;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Kind-carrying Fireweave exception. Messages are always secret-sanitized at construction;
 * the original cause is preserved for diagnostics (never serialized into decisions).
 *
 * <p>Thrown internally by adapters and validators. A control-point read never surfaces this to
 * callers: {@code FireweaveRuntime.evaluate} converts it into a default-valued error
 * {@link Decision} (defaults do not throw, spec/control-points.md "Return discipline").
 * Extension APIs convert it into a structured, non-throwing result.
 */
public class FireweaveException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final ErrorKind kind;
    /**
     * Overrides the kind's default OpenFeature code for documented subtypes
     * (InvalidContext -&gt; TARGETING_KEY_MISSING; runtime Configuration -&gt; GENERAL).
     */
    private final String openFeatureErrorCodeOverride;
    /** Extra flagMetadata to attach to error decisions (e.g. fireweave.quotaLimited). */
    private final Map<String, Object> decisionMetadata;

    public FireweaveException(ErrorKind kind) {
        this(kind, kind.defaultMessage(), null, null, null);
    }

    public FireweaveException(ErrorKind kind, String message) {
        this(kind, message, null, null, null);
    }

    public FireweaveException(ErrorKind kind, String message, Throwable cause) {
        this(kind, message, cause, null, null);
    }

    public FireweaveException(ErrorKind kind,
                              String message,
                              Throwable cause,
                              String openFeatureErrorCodeOverride,
                              Map<String, Object> decisionMetadata) {
        super(Redaction.sanitize(message == null ? kind.defaultMessage() : message), cause);
        this.kind = Objects.requireNonNull(kind, "kind");
        this.openFeatureErrorCodeOverride = openFeatureErrorCodeOverride;
        this.decisionMetadata = decisionMetadata == null
                ? Collections.emptyMap()
                : Collections.unmodifiableMap(new LinkedHashMap<>(decisionMetadata));
    }

    public ErrorKind kind() {
        return kind;
    }

    /** Effective OpenFeature error code string for this occurrence. */
    public String openFeatureErrorCode() {
        return openFeatureErrorCodeOverride != null ? openFeatureErrorCodeOverride : kind.openFeatureErrorCode();
    }

    /** Extra flagMetadata entries to merge into the error decision. Never null. */
    public Map<String, Object> decisionMetadata() {
        return decisionMetadata;
    }

    /** Missing targeting key: InvalidContext with the TARGETING_KEY_MISSING OF subtype. */
    public static FireweaveException targetingKeyMissing() {
        return new FireweaveException(ErrorKind.InvalidContext, "targeting key missing", null,
                "TARGETING_KEY_MISSING", null);
    }

    /** Quota-limited empty snapshot: FlagNotFound plus {@code fireweave.quotaLimited: true}. */
    public static FireweaveException quotaLimited() {
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("fireweave.quotaLimited", true);
        return new FireweaveException(ErrorKind.FlagNotFound, ErrorKind.FlagNotFound.defaultMessage(), null,
                null, meta);
    }
}
