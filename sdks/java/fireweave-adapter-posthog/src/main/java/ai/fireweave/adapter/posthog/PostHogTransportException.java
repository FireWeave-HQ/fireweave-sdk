package ai.fireweave.adapter.posthog;

/**
 * Transport-level failure from {@link PostHogClientApi}. {@code httpStatus == 0} means no HTTP
 * response (network / timeout / parse — discriminated by {@link Kind}).
 */
public class PostHogTransportException extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Kind { HTTP, TIMEOUT, NETWORK, MALFORMED_BODY }

    private final Kind kind;
    private final int httpStatus;

    public PostHogTransportException(Kind kind, int httpStatus, String message, Throwable cause) {
        super(message, cause);
        this.kind = kind;
        this.httpStatus = httpStatus;
    }

    public static PostHogTransportException http(int status) {
        return new PostHogTransportException(Kind.HTTP, status, "http status " + status, null);
    }

    public static PostHogTransportException timeout() {
        return new PostHogTransportException(Kind.TIMEOUT, 0, "request timed out", null);
    }

    public static PostHogTransportException network(Throwable cause) {
        return new PostHogTransportException(Kind.NETWORK, 0, "network error", cause);
    }

    public static PostHogTransportException malformedBody() {
        return new PostHogTransportException(Kind.MALFORMED_BODY, 0, "malformed response body", null);
    }

    public Kind kind() {
        return kind;
    }

    public int httpStatus() {
        return httpStatus;
    }
}
