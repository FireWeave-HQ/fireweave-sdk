package ai.fireweave.sdk.domain;

import java.util.Objects;

/**
 * Immutable error occurrence carried on a {@link Decision} or on an extension-call result
 * (mirrors {@code spec/errors.schema.json#/$defs/errorInstance}).
 * Message is secret-sanitized at construction; no stack traces are carried.
 */
public final class FireweaveError {

    private final ErrorKind kind;
    private final String message;
    private final String openFeatureErrorCode;
    private final String cause; // sanitized cause class name only

    private FireweaveError(ErrorKind kind, String message, String openFeatureErrorCode, String cause) {
        this.kind = Objects.requireNonNull(kind, "kind");
        this.message = Redaction.sanitize(message == null ? kind.defaultMessage() : message);
        this.openFeatureErrorCode = openFeatureErrorCode != null ? openFeatureErrorCode : kind.openFeatureErrorCode();
        this.cause = cause;
    }

    public static FireweaveError of(ErrorKind kind, String message) {
        return new FireweaveError(kind, message, null, null);
    }

    public static FireweaveError from(FireweaveException e) {
        return new FireweaveError(e.kind(), e.getMessage(), e.openFeatureErrorCode(),
                e.getCause() != null ? e.getCause().getClass().getName() : null);
    }

    public ErrorKind kind() {
        return kind;
    }

    public String message() {
        return message;
    }

    /** OpenFeature error code string for this occurrence (may be a documented subtype). */
    public String openFeatureErrorCode() {
        return openFeatureErrorCode;
    }

    /** Sanitized cause class name, or null. */
    public String causeName() {
        return cause;
    }

    public boolean retryable() {
        return kind.retryable();
    }

    @Override
    public String toString() {
        return "FireweaveError{" + kind + ": " + message + "}";
    }
}
